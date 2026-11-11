// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  navigate: vi.fn(),
  update: vi.fn(),
  notices: [] as string[],
  toasts: [] as string[],
}))
vi.mock('../src/lib/api', () => ({
  api: { workspaceLibraries: mocks.list, updateLibraryEverywhere: mocks.update },
  errorMessage: (_error: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/store', () => ({
  useStore: { getState: () => ({ pushNotice: (text: string) => mocks.notices.push(text) }) },
}))
vi.mock('../src/lib/desktop', () => ({ openCanvasTab: () => false }))
vi.mock('../src/lib/navigate', () => ({ navigate: mocks.navigate }))
import { WorkspaceLibraries } from '../src/components/WorkspaceLibraries'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The Workspace page's Libraries pane. */

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  mocks.list.mockReset()
  mocks.navigate.mockReset()
  mocks.update.mockReset()
  mocks.notices.length = 0
  mocks.toasts.length = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('lists each library with what it offers, and opens its canvas', async () => {
  mocks.list.mockResolvedValue([
    { id: 'lib1', name: 'Design system', components: 12, publishedAt: Date.now() - 60_000, usedBy: 1 },
  ])
  await act(async () =>
    root.render(<WorkspaceLibraries workspaceId="ws1" onToast={(text) => mocks.toasts.push(text)} />),
  )
  expect(mocks.list).toHaveBeenCalledWith('ws1')
  expect(container.textContent).toContain('Design system')
  expect(container.textContent).toContain('12 components · used on 1 canvas · published')
  /* nobody is behind, so there is nothing to update everywhere */
  expect(container.querySelector('[data-library-update-everywhere]')).toBeNull()
  await act(async () => container.querySelector('button')!.click())
  expect(mocks.navigate).toHaveBeenCalledWith('/c/lib1')
})

it('updates every canvas on an older version from a library row, after a confirmation', async () => {
  const library = { id: 'lib1', name: 'Design system', components: 12, publishedAt: Date.now() - 60_000, usedBy: 3 }
  mocks.list.mockResolvedValueOnce([{ ...library, behind: 2 }]).mockResolvedValue([{ ...library, behind: 0 }])
  mocks.update.mockResolvedValue({
    dry_run: false,
    canvases: [
      { canvas_id: 'k1', canvas_name: 'Landing', updated: ['Button'], frames_changed: 1, approvals_withdrawn: 0 },
      { canvas_id: 'k2', canvas_name: 'Pricing', updated: ['Button'], frames_changed: 3, approvals_withdrawn: 0 },
    ],
    skipped: [],
  })
  await act(async () =>
    root.render(<WorkspaceLibraries workspaceId="ws1" onToast={(text) => mocks.toasts.push(text)} />),
  )
  expect(container.textContent).toContain('used on 3 canvases · 2 on an older version · published')

  await act(async () => (container.querySelector('[data-library-update-everywhere]') as HTMLButtonElement).click())
  expect(mocks.update).not.toHaveBeenCalled()
  const dialog = document.querySelector('[data-slot="confirm-dialog"]')!
  expect(dialog.textContent).toContain('Update 2 canvases to the latest version?')
  await act(async () =>
    Array.from(dialog.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Update everywhere')!
      .click(),
  )
  expect(mocks.update).toHaveBeenCalledWith('lib1')
  /* said on this page's toast: the canvas's notices are not drawn here */
  expect(mocks.toasts).toEqual(['2 canvases updated'])
  expect(mocks.notices).toEqual([])
  /* the list is read again, and the row no longer offers it */
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[data-library-update-everywhere]')).toBeNull()
  expect(container.textContent).not.toContain('on an older version')
})

it('says how to make the first library, and when the list could not be read', async () => {
  mocks.list.mockResolvedValue([])
  await act(async () =>
    root.render(<WorkspaceLibraries workspaceId="ws1" onToast={(text) => mocks.toasts.push(text)} />),
  )
  expect(container.textContent).toContain('No libraries yet')

  mocks.list.mockRejectedValue(new Error('offline'))
  await act(async () =>
    root.render(<WorkspaceLibraries workspaceId="ws2" onToast={(text) => mocks.toasts.push(text)} />),
  )
  expect(container.textContent).toContain('Couldn’t load the libraries')
})
