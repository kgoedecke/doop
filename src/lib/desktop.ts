/* Doop in the desktop shell (desktop/src-tauri). The shell is one webview
   with an overlay title bar; canvases open Figma-style in a tab strip the
   web app draws itself (src/components/DesktopTabs.tsx). Tabs are ordinary
   in-page navigations — this module only keeps the strip's state and the
   shell-specific plumbing. In a plain browser every entry point returns
   false / no-ops and the app behaves exactly as before. */

import { create } from 'zustand'
import { navigate } from '../App'

export type CanvasTab = { id: string; name: string }

type ShellWindow = Window & {
  __DOOP_DESKTOP__?: unknown
  __DOOP_DESKTOP_PLATFORM__?: unknown
  __TAURI__?: { opener?: { openUrl?: (url: string) => Promise<void> } }
}

const shellWindow = window as ShellWindow

export function isDesktopShell(): boolean {
  return typeof shellWindow.__DOOP_DESKTOP__ === 'string'
}

export function getDesktopPlatform(): 'macos' | 'windows' | 'linux' | 'other' {
  const p = shellWindow.__DOOP_DESKTOP_PLATFORM__
  if (typeof p === 'string') {
    if (p === 'macos' || p === 'darwin') return 'macos'
    if (p === 'windows') return 'windows'
    if (p === 'linux') return 'linux'
  }
  if (typeof navigator !== 'undefined') {
    const nav = navigator as { userAgentData?: { platform?: string } }
    const platform = nav.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
    if (/mac/i.test(platform)) return 'macos'
    if (/win/i.test(platform)) return 'windows'
    if (/linux/i.test(platform)) return 'linux'
  }
  return 'other'
}

/** The overlay title bar (traffic lights floating over the page) arrived
 *  with shell 0.1.2; older shells keep a native title bar and need no inset.
 *  Traffic lights are macOS-only — Windows shells use standard window framing. */
export function hasInsetTrafficLights(): boolean {
  if (getDesktopPlatform() !== 'macos') return false
  const v = shellWindow.__DOOP_DESKTOP__
  if (typeof v !== 'string') return false
  const [maj = 0, min = 0, pat = 0] = v.split('.').map((n) => parseInt(n, 10) || 0)
  return maj > 0 || min > 1 || (min === 1 && pat >= 2)
}

/* ---------- tab strip state ---------- */

/* Tabs persist per account (`doop-open-tabs:<userId>`): on a shared machine
   the next person to sign in must not see the previous account's canvas
   names, and each account gets its own tabs back — like Figma. Until the
   session resolves, tabs live only in memory. */

let userId: string | null = null

function storageKey(id: string) {
  return `doop-open-tabs:${id}`
}

function load(id: string): CanvasTab[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(id)) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((t): t is CanvasTab => typeof t?.id === 'string') : []
  } catch {
    return []
  }
}

export const useTabs = create<{ tabs: CanvasTab[] }>(() => ({ tabs: [] }))

function setTabs(tabs: CanvasTab[]) {
  useTabs.setState({ tabs })
  if (!userId) return
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(tabs))
  } catch {
    /* blocked storage only means tabs don't survive a relaunch */
  }
}

/** Called by App whenever the session's user changes (including to null on
 *  sign-out). Restores that account's tabs, keeping any opened before the
 *  session resolved — a deep link's tab must survive the swap. */
export function setTabsUser(id: string | null) {
  if (!isDesktopShell() || id === userId) return
  userId = id
  if (!id) {
    useTabs.setState({ tabs: [] })
    return
  }
  const restored = load(id)
  const current = useTabs.getState().tabs
  setTabs([...restored, ...current.filter((t) => !restored.some((r) => r.id === t.id))])
}

/** Make sure a tab exists for the canvas and its label is current. Called on
 *  every canvas visit, so deep links and back/forward grow tabs too and
 *  renames flow into the strip. */
export function ensureTab(id: string, name?: string) {
  if (!isDesktopShell()) return
  const { tabs } = useTabs.getState()
  const tab = tabs.find((t) => t.id === id)
  if (!tab) setTabs([...tabs, { id, name: name || 'Untitled canvas' }])
  else if (name && tab.name !== name) setTabs(tabs.map((t) => (t.id === id ? { ...t, name } : t)))
}

/** Open (or switch to) the tab for a canvas. False in plain browsers so
 *  callers fall back to a bare navigation. */
export function openCanvasTab(id: string, name?: string): boolean {
  if (!isDesktopShell()) return false
  ensureTab(id, name)
  navigate(`/c/${id}`)
  return true
}

/** Drop tabs whose canvases no longer exist. Home feeds this every fresh
 *  canvas list — deletes can happen in other sessions or by other people,
 *  so closing tabs at the delete button alone would still leave strays. */
export function pruneTabs(liveIds: ReadonlySet<string>) {
  const { tabs } = useTabs.getState()
  const next = tabs.filter((t) => liveIds.has(t.id))
  if (next.length !== tabs.length) setTabs(next)
}

export function closeTab(id: string, currentPath: string) {
  const { tabs } = useTabs.getState()
  const at = tabs.findIndex((t) => t.id === id)
  if (at < 0) return
  const next = tabs.filter((t) => t.id !== id)
  setTabs(next)
  /* closing the tab you're on lands you on its right neighbour, like Chrome */
  if (currentPath === `/c/${id}`) {
    const neighbour = next[Math.min(at, next.length - 1)]
    navigate(neighbour ? `/c/${neighbour.id}` : '/')
  }
}

/** Close every tab except one — the kept tab becomes the current page.
 *  Takes the current path like closeTab, so keeping the tab you're on adds
 *  no history entry (Back would otherwise land on the same canvas). */
export function closeOtherTabs(id: string, currentPath: string) {
  const keep = useTabs.getState().tabs.find((t) => t.id === id)
  if (!keep) return
  setTabs([keep])
  if (currentPath !== `/c/${id}`) navigate(`/c/${id}`)
}

export function closeAllTabs() {
  setTabs([])
  navigate('/')
}

/* ---------- external links ---------- */

/** Hand a URL to the system browser via the shell's opener IPC. False on
 *  pre-0.1.2 shells (no IPC) and in plain browsers. */
export function openExternal(url: string): boolean {
  const open = shellWindow.__TAURI__?.opener?.openUrl
  if (typeof open !== 'function') return false
  open(url).catch(console.error)
  return true
}

/** WKWebView silently drops target="_blank" clicks (no popup handler), so
 *  links like Help & docs did nothing in the shell. Route them to the system
 *  browser instead. Runs once from main.tsx; no-op outside the shell. */
export function initDesktopShell() {
  if (!isDesktopShell()) return
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null
      if (!a?.href || !/^https?:/i.test(a.href)) return
      e.preventDefault()
      if (openExternal(a.href)) return
      /* pre-0.1.2 shells have no opener IPC: cross-origin assigns still
         bounce to the system browser via the shell's navigation handler;
         same-origin ones would swallow the app, so they stay inert there */
      if (new URL(a.href).host !== location.host) location.assign(a.href)
    },
    true,
  )
}
