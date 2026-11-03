import { useEffect, useRef } from 'react'
import type { UserEvent } from '../../shared/userEvents'

/**
 * Listens to the signed-in user's push channel (`GET /api/me/events`) while
 * mounted. `onEvent` also fires with `{ type: 'canvases' }` every time the
 * stream opens, the first time included: a ping sent before the server
 * registered the stream (or while it was down) is gone, so the page
 * refetches to catch up.
 */
export function useUserEvents(onEvent: (event: UserEvent) => void): void {
  const handler = useRef(onEvent)
  useEffect(() => {
    handler.current = onEvent
  })

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource('/api/me/events')
    source.onopen = () => handler.current({ type: 'canvases' })
    source.onmessage = (ev: MessageEvent<string>) => {
      try {
        handler.current(JSON.parse(ev.data) as UserEvent)
      } catch {
        /* a malformed line is not worth breaking the page over */
      }
    }
    return () => source.close()
  }, [])
}
