import { isDesktopShell, type DesktopPlatform } from './shell'

/* Where a browser on each desktop OS gets the app. The doop.design routes
   (doop-marketing, src/pages/download/) redirect to the newest desktop-v*
   release's installer: the universal DMG, the NSIS setup.exe, the AppImage. */
const DOWNLOAD_URLS: Record<DesktopPlatform, string> = {
  macos: 'https://doop.design/download/mac',
  windows: 'https://doop.design/download/windows',
  linux: 'https://doop.design/download/linux',
}

type Navigator = { userAgent: string; userAgentData?: { platform?: string; mobile?: boolean } }

/** The desktop OS a browser runs on, null for phones, tablets and anything
 *  else. iPads report a Mac user agent but have touch points; Android's
 *  user agent names Linux, and ChromeOS runs no desktop build, so
 *  both are ruled out first. */
export function browserPlatform(
  nav: Navigator = navigator,
  touchPoints = navigator.maxTouchPoints,
): DesktopPlatform | null {
  if (nav.userAgentData?.mobile) return null
  if (/android|iphone|ipad|ipod|cros/i.test(nav.userAgent)) return null
  const ua = nav.userAgentData?.platform || nav.userAgent
  if (/mac/i.test(ua)) return touchPoints > 1 ? null : 'macos'
  if (/win/i.test(ua)) return 'windows'
  if (/linux/i.test(ua)) return 'linux'
  return null
}

/** The installer link for this browser's OS; null inside the desktop shell
 *  (it already is the app) and on platforms with no desktop build. */
export function desktopDownloadUrl(): string | null {
  if (isDesktopShell()) return null
  const platform = browserPlatform()
  return platform ? DOWNLOAD_URLS[platform] : null
}
