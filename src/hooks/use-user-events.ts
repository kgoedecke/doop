import { useEffect, useRef } from 'react'
import type { UserEvent } from '../../shared/userEvents'

/**
 * Listens to the signed-in user's push channel (`GET /api/me/events`) while
 * mounted. `onEvent` also fires with `{ type: 'canvases' }` on every
 * reconnect after the first open, since pings sent while the stream was
 * down are gone and the page should refetch to catch up.
 */
export function useUserEvents(onEvent: (event: UserEvent) => void): void {
  const handler = useRef(onEvent)
  useEffect(() => {
    handler.current = onEvent
  })

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource('/api/me/events')
    let opened = false
    source.onopen = () => {
      if (opened) handler.current({ type: 'canvases' })
      opened = true
    }
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
