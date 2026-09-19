// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/api', () => ({ api: {} }))
vi.mock('../src/lib/shell', () => ({ isDesktopShell: () => false }))
vi.mock('../src/lib/localAgent', () => ({
  useLocalAgent: () => ({ preference: null, native: null }),
  hasLocalClaude: () => false,
  canInstallClaude: () => false,
  refreshLocalAgent: vi.fn().mockResolvedValue({ native: null }),
  selectLocalAgent: vi.fn(),
  disconnectLocalAgent: vi.fn(),
  invokeClaude: vi.fn(),
}))
import { LocalClaudeRow } from '../src/components/LocalClaude'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<LocalClaudeRow />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
it('points a browser at the desktop app instead of offering controls it cannot run', () => {
  expect(container.textContent).toContain('Desktop app')
  expect(container.textContent).toContain('Use this plan in the Doop desktop app.')
  expect(container.querySelectorAll('button')).toHaveLength(0)
  const link = container.querySelector('a')
  expect(link?.textContent).toBe('Download desktop app')
  expect(link?.getAttribute('href')).toBe('https://doop.design/download/mac')
})
