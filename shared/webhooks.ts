/** Canvas events an outbound webhook can subscribe to. Names are stable API:
 *  they appear in the X-Doop-Event header and the payload's `type`. */
export const WEBHOOK_EVENTS = [
  'comment.created',
  'comment.replied',
  'comment.resolved',
  'frame.created',
  'task.completed',
  'task.failed',
] as const

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  'comment.created': 'A comment is left on an element',
  'comment.replied': 'A reply lands in a comment thread',
  'comment.resolved': 'A comment thread is resolved',
  'frame.created': 'A frame is created',
  'task.completed': 'An agent finishes a board card',
  'task.failed': 'An agent fails a board card',
}

/** A webhook as the settings page sees it: never the secret. */
export interface WebhookInfo {
  id: string
  url: string
  events: WebhookEventType[]
  enabled: boolean
  createdAt: number
  /** HTTP status of the last delivery attempt; null = no response (network, timeout, refused) */
  lastStatus: number | null
  lastAt: number | null
  lastError: string | null
  /** consecutive failed deliveries; resets on the first success */
  failures: number
}

export interface WebhookDeliveryResult {
  ok: boolean
  status: number | null
  error?: string
}
