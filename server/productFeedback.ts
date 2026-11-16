import { Router } from 'express'
import { capture } from './analytics.ts'
import { env } from './env.ts'
import { sendMail } from './mailer.ts'
import { parseProductFeedback, type ProductFeedbackInput } from '../shared/productFeedback.ts'

/**
 * `POST /api/product-feedback`: a short note from a signed-in person to the
 * people running this instance, emailed to `FEEDBACK_EMAIL`. Nothing is
 * stored. With the address unset the feature is off: `/api/me` says so and
 * the app shows no Feedback button.
 */

export function productFeedbackEnabled(): boolean {
  return !!env.FEEDBACK_EMAIL
}

/* a note is a few a day at most; this only stops a script from filling the inbox */
const NOTES_PER_HOUR = 5
const HOUR_MS = 60 * 60 * 1000
const recent = new Map<string, number[]>()

function underLimit(userId: string, now: number): boolean {
  const hits = (recent.get(userId) ?? []).filter((at) => now - at < HOUR_MS)
  const allowed = hits.length < NOTES_PER_HOUR
  if (allowed) hits.push(now)
  recent.set(userId, hits)
  /* accounts whose hour has passed leave the map, so it never outgrows an hour of senders */
  for (const [id, times] of recent) if (times.every((at) => now - at >= HOUR_MS)) recent.delete(id)
  return allowed
}

/** Header values are one line: a name is the sender's to choose. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

export function productFeedbackEmail(
  from: { name: string; email: string },
  feedback: ProductFeedbackInput,
  to: string,
) {
  const name = oneLine(from.name) || from.email
  return {
    to,
    replyTo: from.email,
    subject: `Doop feedback from ${name}`,
    text: [
      feedback.message,
      '',
      '--',
      `${name} <${from.email}>`,
      ...(feedback.page ? [`Page: ${feedback.page}`] : []),
    ].join('\n'),
  }
}

export const productFeedbackRouter = Router()

productFeedbackRouter.post('/', async (req, res, next) => {
  const to = env.FEEDBACK_EMAIL
  if (!to) return res.status(404).json({ error: 'feedback is not set up on this server' })
  const feedback = parseProductFeedback(req.body)
  if (!feedback) return res.status(400).json({ error: 'write a short message first' })
  const user = req.user!
  if (!underLimit(user.id, Date.now()))
    return res.status(429).json({ error: 'that is a lot of feedback in one hour; try again later' })
  try {
    await sendMail(productFeedbackEmail(user, feedback, to))
    capture(user.id, 'product_feedback_sent', { length: feedback.message.length, page: feedback.page })
    res.json({ ok: true })
  } catch (e) {
    next(e)
  }
})
