import { useEffect } from 'react'
import { IOS_APP_ID, canvasAppBanner } from '../../shared/iosApp'
import { isDesktopShell } from './shell'

/* Which of Doop's native apps suits the browser this page runs in, and
   whether the person has already waved the suggestion away. The desktop card
   (NativeAppCard) and the iPhone/iPad sheet (IosAppPrompt) both read it. */

/** The platforms a native Doop app exists for. Android has none yet. */
export type NativeAppPlatform = 'macos' | 'windows' | 'linux' | 'ios'

/* absolute, like DOWNLOAD_URL in siteLinks.ts: the installers and the listing are the same
   whichever server the page came from. The /download/* routes on doop.design
   resolve the newest desktop release at request time. */
export const APP_STORE_URL = `https://apps.apple.com/us/app/doop-design/id${IOS_APP_ID}`
const INSTALLERS: Record<Exclude<NativeAppPlatform, 'ios'>, string> = {
  macos: 'https://doop.design/download/mac',
  windows: 'https://doop.design/download/windows',
  /* the AppImage, which runs on any distribution; the .deb and .rpm are on
     the download page */
  linux: 'https://doop.design/download/linux',
}

export function nativeAppUrl(platform: NativeAppPlatform): string {
  return platform === 'ios' ? APP_STORE_URL : INSTALLERS[platform]
}

type NavigatorLike = { userAgent: string; platform?: string; maxTouchPoints?: number }

/** Null inside the desktop app (it is the native app) and on platforms with
 *  none. iPadOS asks for desktop sites by default and calls itself a Mac,
 *  so a "Mac" with a touch screen is an iPad. */
export function nativeAppPlatform(nav: NavigatorLike = navigator): NativeAppPlatform | null {
  if (isDesktopShell()) return null
  const ua = nav.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return null
  if (/Macintosh|Mac OS X/.test(ua)) return (nav.maxTouchPoints ?? 0) > 1 ? 'ios' : 'macos'
  if (/Windows/.test(ua)) return 'windows'
  if (/CrOS/.test(ua)) return null
  if (/Linux/.test(ua)) return 'linux'
  return null
}

/* dismissals per browser, by surface: "Not now" on the sheet asks again
   after a while, the card's dismiss is for good */
const STORAGE_KEY = 'doop:native-app-promo'
export const IOS_PROMPT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000

type Dismissals = { card?: number; ios?: number }

function readDismissals(): Dismissals {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Dismissals) : {}
  } catch {
    return {}
  }
}

export function dismissNativeApp(surface: keyof Dismissals, at = Date.now()) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readDismissals(), [surface]: at }))
  } catch {
    /* storage refused (private mode): the suggestion just comes back next visit */
  }
}

export function desktopCardDismissed(): boolean {
  return readDismissals().card !== undefined
}

export function iosPromptSnoozed(now = Date.now()): boolean {
  const at = readDismissals().ios
  return at !== undefined && now - at < IOS_PROMPT_SNOOZE_MS
}

/** Direct canvas links carry the tag in the initial HTML. Keep it in sync
 * when the SPA opens another canvas or leaves the editor. */
export function useCanvasAppBanner(canvasId: string) {
  useEffect(() => {
    if (nativeAppPlatform() !== 'ios') return
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="apple-itunes-app"]')
    const meta = existing ?? document.createElement('meta')
    meta.name = 'apple-itunes-app'
    meta.content = canvasAppBanner(canvasId, location.origin)
    if (!existing) document.head.append(meta)
    return () => meta.remove()
  }, [canvasId])
}
