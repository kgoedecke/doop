import { useSyncExternalStore } from 'react'
import type { Me } from './me'

/**
 * One way to ask for the feedback modal from anywhere: the rail, the account
 * menu and the canvas Help menu. `FeedbackHost` (mounted once by the app)
 * shows it.
 */

let open = false
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function openFeedback(): void {
  open = true
  emit()
}

export function closeFeedback(): void {
  open = false
  emit()
}

export function useFeedbackOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => open,
  )
}

/** Whether to show a Feedback button: the server has somewhere to send it. */
export function offersFeedback(me: Me | null | undefined): boolean {
  return !!me?.feedback
}
