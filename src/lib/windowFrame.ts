/* The window frame on Windows. macOS shells overlay the title bar from the
   start (desktop/src-tauri/src/main.rs); Windows shells open with the native
   frame and the page swaps it for its own: the tab strip (and, on screens
   without it, ShellDragBar) carries minimize / maximize / close
   (src/components/WindowControls.tsx).

   The page drops the frame rather than the shell, because shell and app ship
   apart: a shell older than the `set_decorations` grant refuses the call and
   keeps its native frame, and a server running an app older than this module
   never asks — so no combination leaves a window without a way to close it.
   Detected by the call succeeding rather than by version, like the other
   shell capabilities. */

import { create } from 'zustand'
import { desktopPlatform } from './shell'

type AppWindow = {
  setDecorations: (decorations: boolean) => Promise<void>
  isMaximized: () => Promise<boolean>
  onResized: (handler: () => void) => Promise<() => void>
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
}

type FrameBridge = {
  __TAURI__?: { window?: { getCurrentWindow?: () => AppWindow } }
}

type FrameState = {
  /** The page draws the window controls: the native frame is gone. */
  custom: boolean
  /** Shows Restore instead of Maximize. */
  maximized: boolean
}

export const useWindowFrame = create<FrameState>(() => ({ custom: false, maximized: false }))

function appWindow(): AppWindow | null {
  return (globalThis as FrameBridge).__TAURI__?.window?.getCurrentWindow?.() ?? null
}

/** Swap the native frame for the page's own. Runs once from
 *  initDesktopShell; a no-op off Windows and outside the shell. */
export async function initWindowFrame(): Promise<void> {
  if (desktopPlatform() !== 'windows') return
  const win = appWindow()
  if (!win) return
  try {
    await win.setDecorations(false)
  } catch {
    /* a shell without the grant: its native frame stays, and so must
       the page's hands off the controls */
    return
  }
  const syncMaximized = () =>
    win
      .isMaximized()
      .then((maximized) => useWindowFrame.setState({ maximized }))
      .catch(console.error)
  useWindowFrame.setState({ custom: true })
  await syncMaximized()
  /* Win+Up, Aero snap and the drag region's double-click maximize without
     going through the controls */
  await win.onResized(() => void syncMaximized())
}

export function minimizeWindow() {
  appWindow()?.minimize().catch(console.error)
}

export function toggleMaximizeWindow() {
  appWindow()?.toggleMaximize().catch(console.error)
}

export function closeWindow() {
  appWindow()?.close().catch(console.error)
}
