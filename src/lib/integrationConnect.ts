import { req } from './api'
import { openExternal, receivesDesktopLinks } from './desktop'
import { forgetPendingConnect, rememberPendingConnect } from './desktopConnect'
import { isDesktopShell } from './shell'

/** Where the person went: off to the provider in this window, or to the
 *  system browser while this window stays put. */
export type ConnectDestination = 'provider' | 'browser'

function startConnect(provider: string, desktop: boolean) {
  return req<{ url: string }>(`/api/integrations/${provider}/start`, {
    method: 'POST',
    body: JSON.stringify({ desktop }),
  })
}

/**
 * Begin connecting an OAuth integration (Meta, Linear, Slack).
 * In a browser this leaves for the provider and lands back on Integrations.
 * In the desktop shell the provider page opens in the system browser, and
 * the browser hands the outcome back over a doop:// link (see
 * shared/desktopConnect.ts). Shells too old to receive that link open
 * Integrations in the browser instead, so the whole connection happens
 * there. Throws when the round trip cannot start; the caller shows why.
 * `onStarted` runs once the server has handed out the provider's URL, just
 * before the person leaves for it.
 */
export async function connectIntegration(provider: string, onStarted?: () => void): Promise<ConnectDestination> {
  if (!isDesktopShell()) {
    const { url } = await startConnect(provider, false)
    onStarted?.()
    location.assign(url)
    return 'provider'
  }
  if (!receivesDesktopLinks()) {
    if (!openExternal(`${location.origin}/integrations`)) throw new Error('Could not open your browser.')
    return 'browser'
  }
  if (!rememberPendingConnect(provider)) throw new Error('Could not start connecting from the app.')
  try {
    const { url } = await startConnect(provider, true)
    onStarted?.()
    if (!openExternal(url)) throw new Error('Could not open your browser.')
    return 'browser'
  } catch (error) {
    forgetPendingConnect(provider)
    throw error
  }
}
