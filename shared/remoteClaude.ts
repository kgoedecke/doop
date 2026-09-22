import type { Event as RuntimeEvent } from '../services/claude-runtime/src/contracts.js'

export interface RemoteClaudeStatus {
  authRequired?: boolean
  configured: boolean
  running: boolean
}

// Transport resets and receipt metadata are supplied by Cantelop, outside application events.
export type ClaudeEvent = (RuntimeEvent | { type: 'event_stream_reset' | 'event_cursor_expired' }) & {
  message_id?: string
}

/** Consume bounded SSE frames in order. Advance the replay cursor only after handling a frame. */
export async function consumeClaudeEvents(
  response: Response,
  onEvent: (event: ClaudeEvent) => Promise<void> | void,
  onCursor: (cursor: string) => void,
  signal?: AbortSignal,
) {
  if (!response.ok || !response.body) throw new Error(`Claude event stream unavailable (${response.status}).`)
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) return
      buffer += decoder.decode(part.value, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        if (match.index > 256 * 1024) throw new Error('Claude event exceeded the frame limit.')
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const lines = frame.split(/\r?\n/)
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        const cursor = lines
          .find((line) => line.startsWith('id:'))
          ?.slice(3)
          .trim()
        if (data) {
          const value = JSON.parse(data)
          // Cantelop wraps application output; receipt metadata belongs to the envelope.
          const event =
            value && typeof value.data === 'object' && value.data !== null
              ? { ...value.data, message_id: value.message_id }
              : value
          await onEvent(event as ClaudeEvent)
        }
        if (cursor) onCursor(cursor)
      }
      if (buffer.length > 256 * 1024) throw new Error('Claude event exceeded the frame limit.')
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
