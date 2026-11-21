// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/App', () => ({ navigate: vi.fn() }))
vi.mock('../src/lib/auth', () => ({ authClient: {} }))
vi.mock('../src/lib/shell', async (load) => ({ ...(await load<object>()), isDesktopShell: () => true }))
import { moveTab, setTabsUser, tabShortcutTarget, useTabs } from '../src/lib/desktop'

const seed = (ids: string[]) => useTabs.setState({ tabs: ids.map((id) => ({ id, name: id.toUpperCase() })) })
const order = () => useTabs.getState().tabs.map((t) => t.id)
const mod2 = {
  key: '2',
  code: 'Digit2',
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
}

beforeEach(() => {
  localStorage.clear()
  setTabsUser(null)
  useTabs.setState({ tabs: [] })
})

it('moves a tab forward and backward in strip order', () => {
  seed(['a', 'b', 'c', 'd'])
  moveTab('a', 2)
  expect(order()).toEqual(['b', 'c', 'a', 'd'])
  moveTab('a', 0)
  expect(order()).toEqual(['a', 'b', 'c', 'd'])
})

it('clamps an out-of-range target to the strip bounds', () => {
  seed(['a', 'b', 'c'])
  moveTab('a', 99)
  expect(order()).toEqual(['b', 'c', 'a'])
  moveTab('a', -10)
  expect(order()).toEqual(['a', 'b', 'c'])
})

it('leaves state untouched for an unknown id or a no-op move', () => {
  seed(['a', 'b', 'c'])
  const before = useTabs.getState().tabs
  moveTab('zzz', 1)
  moveTab('b', 1)
  moveTab('a', -5)
  expect(useTabs.getState().tabs).toBe(before)
})

it('rebinds the ⌘2…⌘9 slots to the new strip order', () => {
  seed(['a', 'b', 'c'])
  moveTab('c', 0)
  expect(tabShortcutTarget(mod2, useTabs.getState().tabs, true)).toBe('/c/c')
})

it('persists the new order under the signed-in account', () => {
  setTabsUser('u1')
  seed(['a', 'b', 'c'])
  moveTab('a', 2)
  const stored = JSON.parse(localStorage.getItem('doop-open-tabs:u1') ?? '[]') as { id: string }[]
  expect(stored.map((t) => t.id)).toEqual(['b', 'c', 'a'])
})
