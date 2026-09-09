/* What the desktop shell (desktop/src-tauri/src/main.rs) tells the page
   about itself. The shell injects two globals before any page script runs:
   __DOOP_DESKTOP__ (the shell version) and, from 0.1.5, __DOOP_DESKTOP_PLATFORM__
   (Rust's std::env::consts::OS). This module has no imports on purpose:
   src/lib/posthog.ts must read the markers before the App tree is
   evaluated, and src/lib/desktop.ts pulls that tree in via `navigate`. */

export type DesktopPlatform = 'macos' | 'windows' | 'linux'

type ShellGlobals = {
  __DOOP_DESKTOP__?: unknown
  __DOOP_DESKTOP_PLATFORM__?: unknown
}

const shell = globalThis as ShellGlobals

export function isDesktopShell(): boolean {
  return typeof shell.__DOOP_DESKTOP__ === 'string'
}

/** The shell's version string, null outside the shell. */
export function shellVersion(): string | null {
  const version = shell.__DOOP_DESKTOP__
  return typeof version === 'string' ? version : null
}

/** Null outside the shell. Shells before 0.1.5 set no platform marker and
 *  only ever shipped as a macOS DMG, so a missing marker means macOS. */
export function desktopPlatform(): DesktopPlatform | null {
  if (!isDesktopShell()) return null
  const platform = shell.__DOOP_DESKTOP_PLATFORM__
  return platform === 'windows' || platform === 'linux' ? platform : 'macos'
}

function shellVersionAtLeast(major: number, minor: number, patch: number): boolean {
  const version = shell.__DOOP_DESKTOP__
  if (typeof version !== 'string') return false
  const [maj = 0, min = 0, pat = 0] = version.split('.').map((n) => parseInt(n, 10) || 0)
  if (maj !== major) return maj > major
  if (min !== minor) return min > minor
  return pat >= patch
}

/** The overlay title bar (traffic lights floating over the page) arrived
 *  with shell 0.1.2; older shells keep a native title bar and need no inset.
 *  Only macOS has an overlay title bar: Windows shells keep the native frame,
 *  so the page must not reserve room for traffic lights or act as the
 *  window's drag handle there. */
export function hasInsetTrafficLights(): boolean {
  return desktopPlatform() === 'macos' && shellVersionAtLeast(0, 1, 2)
}
