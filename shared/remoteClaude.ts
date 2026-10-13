import type { Event as RuntimeEvent } from '../cantelop/src/contracts.js'

export interface RemoteClaudeStatus {
  authRequired?: boolean
  configured: boolean
  running: boolean
}

// Transport resets and receipt metadata are supplied by Cantelop, outside application events.
export type ClaudeEvent = (RuntimeEvent | { type: 'event_stream_reset' | 'event_cursor_expired' }) & {
  message_id?: string
}
