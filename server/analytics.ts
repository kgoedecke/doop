import { env } from './env.ts'
/* Server-side PostHog capture — for events that happen where posthog-js
 * can't see them (MCP agents, background work). Events use the user's id
 * as distinct_id, the same id the web client identifies with, so they land
 * on the same PostHog person as the browser events.
 *
 * The key is the same public project token the client bundle ships with;
 * VITE_POSTHOG_KEY is a Railway service variable, so it is present at
 * runtime too, not only as a build arg. No key → captures are no-ops
 * (local dev, self-hosted installs with analytics off). */

const PH_INGEST = env.POSTHOG_INGEST_HOST
const PH_KEY = env.POSTHOG_KEY ?? env.VITE_POSTHOG_KEY

export function capture(distinctId: string, event: string, properties: Record<string, unknown> = {}) {
  if (!PH_KEY) return
  fetch(`${PH_INGEST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: PH_KEY, event, distinct_id: distinctId, properties }),
  }).catch(() => {}) /* analytics must never take a request down with it */
}

/* Per-(distinct_id, event) rate limit for signals that fire on every request
 * but only mean something once per session-ish window (an agent streaming a
 * design makes dozens of tool calls per minute). */
const lastCapture = new Map<string, number>()

export function captureThrottled(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
  windowMs = 30 * 60 * 1000,
) {
  const key = `${distinctId}\n${event}`
  const now = Date.now()
  const last = lastCapture.get(key)
  if (last && now - last < windowMs) return
  lastCapture.set(key, now)
  if (lastCapture.size > 10_000) {
    for (const [k, t] of lastCapture) if (now - t >= windowMs) lastCapture.delete(k)
  }
  capture(distinctId, event, properties)
}
