import { createHmac, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { linearInstallations } from '../db/schema.ts'
import { disconnectAgent, receiveSession, sessionEvent, wakeLinear } from './jobs.ts'

export function validSignature(raw: Buffer, signature: string, secret: string): boolean {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return false
  const expected = createHmac('sha256', secret).update(raw).digest()
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}

export function linearWebhookRouter() {
  const router = express.Router()
  router.post('/', express.raw({ type: '*/*', limit: '256kb' }), async (req, res, next) => {
    const secret = process.env.LINEAR_WEBHOOK_SECRET
    if (!secret) return res.status(503).json({ error: 'Linear webhooks are not configured.' })
    if (!Buffer.isBuffer(req.body) || !validSignature(req.body, req.get('linear-signature') ?? '', secret)) {
      return res.status(401).json({ error: 'Invalid Linear signature.' })
    }
    let body: unknown
    try {
      body = JSON.parse(req.body.toString('utf8'))
    } catch {
      return res.status(400).json({ error: 'Invalid JSON.' })
    }
    const envelope = z
      .object({
        type: z.string(),
        action: z.string(),
        webhookTimestamp: z.number().finite(),
        oauthClientId: z.string().optional(),
        organizationId: z.string().optional(),
      })
      .safeParse(body)
    if (!envelope.success || Math.abs(Date.now() - envelope.data.webhookTimestamp) > 60_000) {
      return res.status(400).json({ error: 'Invalid or expired Linear event.' })
    }
    try {
      if (
        envelope.data.type === 'OAuthApp' &&
        envelope.data.action === 'revoked' &&
        envelope.data.oauthClientId === process.env.LINEAR_CLIENT_ID &&
        envelope.data.organizationId
      ) {
        const [installation] = await db
          .select()
          .from(linearInstallations)
          .where(eq(linearInstallations.organizationId, envelope.data.organizationId))
        if (installation) await disconnectAgent(installation.userId)
      } else if (envelope.data.type === 'AgentSessionEvent') {
        const event = sessionEvent.safeParse(body)
        if (!event.success) return res.status(400).json({ error: 'Invalid Linear agent event.' })
        await receiveSession(event.data)
      }
      res.json({ ok: true })
      // Only local persistence happens before the acknowledgment. Network/model work runs separately.
      wakeLinear()
    } catch (error) {
      next(error)
    }
  })
  return router
}
