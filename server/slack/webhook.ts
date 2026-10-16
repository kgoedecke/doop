import { env } from '../env.ts'
import { createHmac, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { z } from 'zod'
import { disconnectTeam, receiveRequest, wakeSlack } from './jobs.ts'

const SIGNATURE_WINDOW_S = 5 * 60

/** Slack's v0 scheme: HMAC-SHA256 over `v0:<timestamp>:<raw body>`, hex, prefixed `v0=`. */
export function validSignature(
  raw: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (!secret || !/^\d{1,12}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/i.test(signature)) return false
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_WINDOW_S) return false
  const expected = createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest()
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))
}

const mention = z.object({
  type: z.literal('app_mention'),
  user: z.string().min(1).optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().max(100_000).default(''),
  channel: z.string().min(1),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
})

const eventCallback = z.object({
  type: z.literal('event_callback'),
  team_id: z.string().min(1),
  event_id: z.string().min(1),
  event: z.discriminatedUnion('type', [
    mention,
    z.object({ type: z.literal('app_uninstalled') }),
    z.object({ type: z.literal('tokens_revoked') }),
  ]),
})

const envelope = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url_verification'), challenge: z.string().min(1).max(1000) }),
  eventCallback,
])

const command = z.object({
  command: z.string().min(1),
  text: z.string().max(100_000).default(''),
  team_id: z.string().min(1),
  channel_id: z.string().min(1),
  user_id: z.string().min(1),
  trigger_id: z.string().min(1),
  response_url: z.string().url().max(2000).optional(),
})

/** Everything Slack sends: Events API JSON, slash commands and interactivity as forms. */
export function slackWebhookRouter() {
  const router = express.Router()
  router.post('/', express.raw({ type: '*/*', limit: '256kb' }), async (req, res, next) => {
    const secret = env.SLACK_SIGNING_SECRET
    if (!secret) return res.status(503).json({ error: 'Slack webhooks are not configured.' })
    res.set('X-Slack-No-Retry', '1')
    if (
      !Buffer.isBuffer(req.body) ||
      !validSignature(req.body, req.get('x-slack-request-timestamp') ?? '', req.get('x-slack-signature') ?? '', secret)
    ) {
      return res.status(401).json({ error: 'Invalid Slack signature.' })
    }
    const raw = req.body.toString('utf8')
    try {
      if (req.is('application/x-www-form-urlencoded')) {
        const form = Object.fromEntries(new URLSearchParams(raw))
        // Interactivity payloads arrive here too; Doop defines no interactive components yet.
        if ('payload' in form) return res.status(200).end()
        const parsed = command.safeParse(form)
        if (!parsed.success) return res.status(400).json({ error: 'Invalid Slack command.' })
        if (!parsed.data.text.trim()) {
          return res.json({
            response_type: 'ephemeral',
            text: 'Add a design brief, for example `/doop design a pricing page for a note-taking app`.',
          })
        }
        await receiveRequest({
          id: `cmd:${parsed.data.trigger_id}`,
          teamId: parsed.data.team_id,
          channelId: parsed.data.channel_id,
          requesterId: parsed.data.user_id,
          text: parsed.data.text,
          responseUrl: parsed.data.response_url,
        })
        res.json({ response_type: 'in_channel', text: 'Doop is on it — designing from your brief.' })
        wakeSlack()
        return
      }
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        return res.status(400).json({ error: 'Invalid JSON.' })
      }
      const parsed = envelope.safeParse(body)
      if (!parsed.success) return res.status(400).json({ error: 'Invalid Slack event.' })
      // Slack enables event subscriptions only after this answers with the bare challenge.
      if (parsed.data.type === 'url_verification') return res.type('text/plain').send(parsed.data.challenge)
      const { event, team_id: teamId, event_id: eventId } = parsed.data
      if (event.type === 'app_uninstalled' || event.type === 'tokens_revoked') {
        await disconnectTeam(teamId)
      } else if (event.user && !event.bot_id && !event.subtype) {
        await receiveRequest({
          id: eventId,
          teamId,
          channelId: event.channel,
          threadTs: event.thread_ts ?? event.ts,
          requesterId: event.user,
          text: event.text,
        })
      }
      res.json({ ok: true })
      // Only local persistence happens before the acknowledgment. Network/model work runs separately.
      wakeSlack()
    } catch (error) {
      // Nothing was persisted: let Slack redeliver instead of losing the request.
      res.removeHeader('X-Slack-No-Retry')
      next(error)
    }
  })
  return router
}
