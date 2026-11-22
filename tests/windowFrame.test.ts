import { afterEach, expect, it, vi } from 'vitest'
import {
  closeWindow,
  initWindowFrame,
  minimizeWindow,
  toggleMaximizeWindow,
  useWindowFrame,
} from '../src/lib/windowFrame'

afterEach(() => {
  vi.unstubAllGlobals()
  useWindowFrame.setState({ custom: false, maximized: false })
})

function stubShell(platform: string, { grant = true, maximized = false } = {}) {
  let onResized: (() => void) | undefined
  const win = {
    setDecorations: vi.fn(() => (grant ? Promise.resolve() : Promise.reject(new Error('not allowed')))),
    isMaximized: vi.fn(() => Promise.resolve(maximized)),
    onResized: vi.fn((handler: () => void) => {
      onResized = handler
      return Promise.resolve(() => {})
    }),
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  }
  vi.stubGlobal('__DOOP_DESKTOP__', '0.15.0')
  vi.stubGlobal('__DOOP_DESKTOP_PLATFORM__', platform)
  vi.stubGlobal('__TAURI__', { window: { getCurrentWindow: () => win } })
  return {
    win,
    resize(nowMaximized: boolean) {
      win.isMaximized.mockResolvedValue(nowMaximized)
      onResized?.()
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve))

it('swaps the native frame for the page controls on Windows', async () => {
  const { win } = stubShell('windows', { maximized: true })
  await initWindowFrame()
  expect(win.setDecorations).toHaveBeenCalledWith(false)
  expect(useWindowFrame.getState()).toEqual({ custom: true, maximized: true })
})

it('keeps the native frame when the shell refuses the call', async () => {
  const { win } = stubShell('windows', { grant: false })
  await initWindowFrame()
  expect(win.setDecorations).toHaveBeenCalled()
  expect(win.onResized).not.toHaveBeenCalled()
  expect(useWindowFrame.getState().custom).toBe(false)
})

it.each(['macos', 'linux'])('leaves the %s frame alone', async (platform) => {
  const { win } = stubShell(platform)
  await initWindowFrame()
  expect(win.setDecorations).not.toHaveBeenCalled()
  expect(useWindowFrame.getState().custom).toBe(false)
})

it('does nothing outside the shell', async () => {
  await initWindowFrame()
  expect(useWindowFrame.getState().custom).toBe(false)
})

it('follows maximize changes made outside the controls', async () => {
  const shell = stubShell('windows')
  await initWindowFrame()
  expect(useWindowFrame.getState().maximized).toBe(false)
  shell.resize(true)
  await flush()
  expect(useWindowFrame.getState().maximized).toBe(true)
  shell.resize(false)
  await flush()
  expect(useWindowFrame.getState().maximized).toBe(false)
})

it('hands the caption buttons to the window', () => {
  const { win } = stubShell('windows')
  minimizeWindow()
  toggleMaximizeWindow()
  closeWindow()
  expect(win.minimize).toHaveBeenCalledOnce()
  expect(win.toggleMaximize).toHaveBeenCalledOnce()
  expect(win.close).toHaveBeenCalledOnce()
})
