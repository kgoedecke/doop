// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: {} }))
vi.mock('../src/lib/shell', async (load) => ({ ...(await load<object>()), isDesktopShell: () => true }))
import { shellShortcutTarget, tabShortcutTarget } from '../src/lib/desktop'

const tabs = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
]
const keys = (code: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: code.slice(5),
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
})

it('sends ⌘1 home and ⌘2 onwards to the open tabs in strip order', () => {
  expect(tabShortcutTarget(keys('Digit1', { metaKey: true }), tabs, true)).toBe('/')
  expect(tabShortcutTarget(keys('Digit2', { metaKey: true }), tabs, true)).toBe('/c/a')
  expect(tabShortcutTarget(keys('Digit3', { metaKey: true }), tabs, true)).toBe('/c/b')
})

it('ignores a slot with no tab and chords that are not the plain modifier', () => {
  expect(tabShortcutTarget(keys('Digit4', { metaKey: true }), tabs, true)).toBeNull()
  expect(tabShortcutTarget(keys('Digit1', { metaKey: true, shiftKey: true }), tabs, true)).toBeNull()
  expect(tabShortcutTarget(keys('Digit1', { ctrlKey: true }), tabs, true)).toBeNull()
  expect(tabShortcutTarget(keys('Digit0', { metaKey: true }), tabs, true)).toBeNull()
  expect(tabShortcutTarget(keys('Digit2'), tabs, true)).toBeNull()
})

it('uses Ctrl off a Mac and reads the physical key, not the typed character', () => {
  expect(tabShortcutTarget(keys('Digit2', { ctrlKey: true }), tabs, false)).toBe('/c/a')
  expect(tabShortcutTarget({ ...keys('Digit1', { ctrlKey: true }), key: '&' }, tabs, false)).toBe('/')
})

it('opens Settings on ⌘, (Ctrl+, off a Mac) and leaves the tab chords alone', () => {
  const comma = (extra: Partial<KeyboardEvent>) => ({ ...keys('Comma', extra), key: ',' })
  expect(shellShortcutTarget(comma({ metaKey: true }), tabs, true)).toBe('/settings')
  expect(shellShortcutTarget(comma({ ctrlKey: true }), tabs, false)).toBe('/settings')
  expect(shellShortcutTarget(comma({ ctrlKey: true }), tabs, true)).toBeNull()
  expect(shellShortcutTarget(comma({ metaKey: true, shiftKey: true }), tabs, true)).toBeNull()
  expect(shellShortcutTarget(comma({}), tabs, true)).toBeNull()
  expect(shellShortcutTarget(keys('Digit2', { metaKey: true }), tabs, true)).toBe('/c/a')
})

it('hears the shortcuts from a field that stops its own keys', async () => {
  const { initDesktopShell, useTabs } = await import('../src/lib/desktop')
  const { navigate } = await import('../src/App')
  const listener = vi.spyOn(document, 'addEventListener')
  try {
    initDesktopShell()
    useTabs.setState({ tabs })
    const field = document.createElement('input')
    field.addEventListener('keydown', (e) => e.stopPropagation())
    document.body.append(field)
    const ctrl = !/mac/i.test(navigator.platform)
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: '2', code: 'Digit2', metaKey: !ctrl, ctrlKey: ctrl, bubbles: true }),
    )
    expect(navigate).toHaveBeenCalledWith('/c/a')
    field.remove()
  } finally {
    for (const [name, handler, options] of listener.mock.calls) document.removeEventListener(name, handler, options)
    listener.mockRestore()
  }
})
