import { DESKTOP_SCHEME } from './desktopAuth'

export const CODEX_SETUP_PATH = '/desktop/connect/codex'

type CodexBridge = {
  __DOOP_CODEX_SETUP__?: boolean
  __TAURI__?: { core?: { invoke: (command: string) => Promise<void> } }
}

const bridge = globalThis as CodexBridge
export const canAddToCodex = () => bridge.__DOOP_CODEX_SETUP__ === true && !!bridge.__TAURI__?.core

export async function addToCodex(): Promise<void> {
  if (!canAddToCodex()) throw new Error('Update Doop Desktop to add Codex directly, or use the manual setup below.')
  // The native command derives /mcp from its own webview. Neither a website
  // handoff nor an IPC argument can select another server or a local command.
  await bridge.__TAURI__!.core!.invoke('codex_add_mcp')
}

function serverOrigin(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    if (url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

function canvasFrom(params: URLSearchParams): string | undefined {
  const id = params.get('canvas')
  return id && /^[\w-]{1,128}$/.test(id) ? id : undefined
}

export function codexDesktopLink(origin: string, canvasId?: string): string {
  const params = new URLSearchParams({ origin })
  if (canvasId) params.set('canvas', canvasId)
  return `${DESKTOP_SCHEME}://connect/codex?${params}`
}

/** An external link only opens the setup screen. The user clicks Add to Codex
 * inside Doop before anything is written to their configuration. */
export function codexSetupTarget(link: string): string | null {
  try {
    const url = new URL(link)
    if (
      url.protocol !== `${DESKTOP_SCHEME}:` ||
      url.host !== 'connect' ||
      url.pathname !== '/codex' ||
      url.username ||
      url.password ||
      url.hash
    )
      return null
    const origin = serverOrigin(url.searchParams.get('origin'))
    if (!origin) return null
    const params = new URLSearchParams({ origin })
    const canvas = canvasFrom(url.searchParams)
    if (canvas) params.set('canvas', canvas)
    return `${CODEX_SETUP_PATH}?${params}`
  } catch {
    return null
  }
}

export function parseCodexSetup(search: string, currentOrigin: string): { canvasId?: string } | null {
  const params = new URLSearchParams(search)
  const requested = serverOrigin(params.get('origin'))
  const current = serverOrigin(currentOrigin)
  if (!requested || !current) return null
  const canonical = (origin: string) => (origin === 'https://www.doop.design' ? 'https://doop.design' : origin)
  if (canonical(requested) !== canonical(current)) return null
  return { canvasId: canvasFrom(params) }
}
