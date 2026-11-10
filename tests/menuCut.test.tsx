// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'
import { ContextMenu, ContextMenuTrigger } from '../src/components/ui/context-menu'
import { TooltipProvider } from '../src/components/ui/tooltip'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: { createFrame: vi.fn(), updateFrame: vi.fn(), deleteFrame: vi.fn(), getCanvas: vi.fn() },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { api } = await import('../src/lib/api')
const { useStore } = await import('../src/lib/store')
const { FrameContextMenu } = await import('../src/components/FrameContextMenu')
const { ElementContextMenu } = await import('../src/components/ElementContextMenu')

const frame = (id: string, html = `<p>${id}</p>`): Frame =>
  ({ id, canvasId: 'c', pageId: 'p', name: id, x: 0, y: 0, width: 100, height: 100, html }) as Frame

/* the system clipboard answers only when the test says so */
let landWrite: () => void
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.deleteFrame).mockResolvedValue(undefined)
  vi.mocked(api.updateFrame).mockImplementation(async (id, patch) => ({ ...frame(id), ...patch }) as Frame)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => new Promise<void>((resolve) => (landWrite = resolve)) },
  })
})
afterEach(() => vi.restoreAllMocks())

function open(frames: Frame[]) {
  useStore
    .getState()
    .setCanvas({ id: 'c', name: 'T', frames, pages: [{ id: 'p', name: 'P' }], role: 'edit' } as unknown as Canvas)
}

async function pickCut(menu: ReactNode, label: string) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div data-target>target</div>
          </ContextMenuTrigger>
          {menu}
        </ContextMenu>
      </TooltipProvider>,
    ),
  )
  await act(async () => {
    container
      .querySelector('[data-target]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.startsWith(label))
  expect(item, `menu item ${label}`).toBeTruthy()
  await act(async () => (item as HTMLElement).click())
  return async () => {
    await act(async () => root.unmount())
    container.remove()
  }
}

it('cuts the frames it copied, not a selection made while the clipboard write was pending', async () => {
  open([frame('a'), frame('b'), frame('c')])
  useStore.getState().selectMany(['a', 'b'])
  const close = await pickCut(<FrameContextMenu frame={frame('a')} at={{ current: { x: 0, y: 0 } }} />, 'Cut 2 frames')
  try {
    useStore.getState().selectMany(['a', 'c'])
    await act(async () => landWrite())
    await vi.waitFor(() => expect(api.deleteFrame).toHaveBeenCalledTimes(2))
    expect(
      vi
        .mocked(api.deleteFrame)
        .mock.calls.map(([id]) => id)
        .sort(),
    ).toEqual(['a', 'b'])
  } finally {
    await close()
  }
})

it('keeps a collaborator’s change made while the clipboard write was pending', async () => {
  const before = '<body><p id="x">x</p><span>keep</span></body>'
  const after = '<body><p id="x">x</p><span>keep</span><i>theirs</i></body>'
  open([frame('f', before)])
  const close = await pickCut(<ElementContextMenu frame={frame('f', before)} selector="#x" />, 'Cut')
  try {
    useStore.getState().patchFrameLocal('f', { html: after })
    await act(async () => landWrite())
    expect(useStore.getState().canvas?.frames.find((f) => f.id === 'f')?.html).toContain('<i>theirs</i>')
    expect(api.updateFrame).not.toHaveBeenCalled()
  } finally {
    await close()
  }
})
