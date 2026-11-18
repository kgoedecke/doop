import { useSyncExternalStore } from 'react'
import { posthog } from './posthog'

/**
 * One way to ask for the upgrade modal from anywhere: the rail's Upgrade
 * button, the account menu, Settings → Plan, the canvas menu, a Free limit
 * hit, and the `?upgrade` link. `UpgradeHost` (mounted once by the app)
 * shows it. Pages that already know the workspace (Home's wall, the
 * Workspace page's billing) keep opening their own modal for it.
 */

/** Where the ask came from, for the `upgrade_opened` event. */
export type UpgradeSource = 'rail' | 'account-menu' | 'settings' | 'canvas-menu' | 'link' | 'font-limit'

export interface UpgradeRequest {
  source: UpgradeSource
  /** what they were doing, shown as the modal's first line */
  reason?: string
}

/** The query parameter that opens the modal on arrival: /?upgrade */
export const UPGRADE_PARAM = 'upgrade'

let current: UpgradeRequest | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function openUpgrade(request: UpgradeRequest): void {
  posthog.capture('upgrade_opened', { source: request.source })
  current = request
  emit()
}

export function closeUpgrade(): void {
  current = null
  emit()
}

export function useUpgradeRequest(): UpgradeRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
}

/** Open the modal when the address asks for it, then take the parameter
 *  off so a reload or Back does not open it again. */
export function openUpgradeFromUrl(): void {
  const url = new URL(location.href)
  if (!url.searchParams.has(UPGRADE_PARAM)) return
  url.searchParams.delete(UPGRADE_PARAM)
  history.replaceState(history.state, '', url)
  openUpgrade({ source: 'link' })
}

/* A workspace the upgrade modal made for checkout carries a placeholder name;
   the Workspace page asks for a real one when Stripe sends the person back
   paid. Per browser; a blocked storage just skips the question. */
const NAME_AFTER_CHECKOUT = 'doop:name-after-checkout'

export function noteNameAfterCheckout(workspaceId: string): void {
  try {
    localStorage.setItem(NAME_AFTER_CHECKOUT, workspaceId)
  } catch {
    /* storage blocked: the default name stays */
  }
}

/** Whether to ask for this workspace's name now; asks once. */
export function takeNameAfterCheckout(workspaceId: string): boolean {
  try {
    if (localStorage.getItem(NAME_AFTER_CHECKOUT) !== workspaceId) return false
    localStorage.removeItem(NAME_AFTER_CHECKOUT)
    return true
  } catch {
    return false
  }
}
