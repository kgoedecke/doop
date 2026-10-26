// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { FrameApprovalControl } from '../src/components/FrameApproval'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '../src/components/ui/context-menu'
import { FrameContextMenu } from '../src/components/FrameContextMenu'
import { Inspector } from '../src/components/Inspector'
import { api, ApiError } from '../src/lib/api'
import { setFramesApproval } from '../src/lib/frameApproval'
import { useStore } from '../src/lib/store'
import { useFrameSaves } from '../src/lib/frameSaves'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Checkout',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  html: '<h1>Checkout</h1>',
  createdAt: 1,
  updatedAt: 10,
  updatedBy: 'Designer',
}
const approved: Frame = {
  ...frame,
  updatedAt: 11,
  approval: {
    status: 'ready_for_dev',
    approvedBy: 'Reviewer',
    approvedByUserId: 'reviewer',
    approvedAt: 11,
    approvedFrameUpdatedAt: 10,
  },
}
let root: Root
let container: HTMLDivElement

function Control({ unsaved = false }: { unsaved?: boolean }) {
  const current = useStore((s) => s.canvas!.frames[0]!)
  return (
    <TooltipProvider delayDuration={0}>
      <FrameApprovalControl frame={current} hasUnsavedChanges={unsaved} />
    </TooltipProvider>
  )
}
function toggle() {
  return container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Mark as approved"]')!
}

beforeEach(() => {
  useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [frame], createdAt: 1, updatedAt: 10 })
  useStore.setState({ streams: {}, notice: null })
  useFrameSaves.setState({ pending: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Control />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  localStorage.removeItem('doop:inspector-html')
  vi.restoreAllMocks()
})

it('waits for confirmation, shows attribution on hover or focus, and lets a person revoke approval', async () => {
  let finish!: (result: Frame) => void
  const save = vi.spyOn(api, 'setFrameApproval').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  act(() => toggle().click())
  expect(toggle().disabled).toBe(true)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(useStore.getState().canvas!.frames[0]!.approval).toBeUndefined()
  expect(save).toHaveBeenCalledWith('f', 'ready_for_dev', 10)
  await act(async () => finish(approved))
  expect(container.textContent).not.toContain('Reviewer')
  expect(container.textContent).not.toContain(new Date(11).toLocaleString())
  expect(toggle().getAttribute('aria-checked')).toBe('true')
  await act(async () => toggle().focus())
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Approved by Reviewer')
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(new Date(11).toLocaleString())
  save.mockResolvedValueOnce({ ...approved, updatedAt: 12, approval: null })
  await act(async () => toggle().click())
  expect(save).toHaveBeenLastCalledWith('f', 'draft', 11)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
})

it('shows needs review after a remote edit and disables approval during streaming or unsaved edits', () => {
  act(() =>
    useStore.getState().upsertFrame({ ...approved, approval: { ...approved.approval!, status: 'needs_review' } }),
  )
  expect(container.textContent).toContain('This design changed after approval')
  expect(toggle().disabled).toBe(false)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  act(() => useStore.setState({ streams: { f: { name: 'Agent', color: '#000' } } }))
  expect(toggle().disabled).toBe(true)
  act(() => {
    useStore.setState({ streams: {} })
    root.render(<Control unsaved />)
  })
  expect(toggle().disabled).toBe(true)
})

it('keeps a rejected approval as draft and reports the server conflict', async () => {
  vi.spyOn(api, 'setFrameApproval').mockRejectedValueOnce(
    new ApiError(409, JSON.stringify({ error: 'Review the latest design.' })),
  )
  await act(async () => toggle().click())
  expect(useStore.getState().canvas!.frames[0]!.approval).toBeUndefined()
  expect(toggle().disabled).toBe(false)
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  expect(useStore.getState().notice?.text).toBe('Review the latest design.')
})

it('keeps a newer collaborator edit when an older approval response arrives', async () => {
  vi.spyOn(api, 'setFrameApproval').mockImplementationOnce(async () => {
    useStore.getState().upsertFrame({
      ...approved,
      html: '<h1>New design</h1>',
      updatedAt: 12,
      approval: { ...approved.approval!, status: 'needs_review' },
    })
    return approved
  })
  await act(async () => toggle().click())
  expect(useStore.getState().canvas!.frames[0]!).toMatchObject({
    html: '<h1>New design</h1>',
    updatedAt: 12,
    approval: { status: 'needs_review' },
  })
})

it('reports partial batch failures without claiming every selected screen was approved', async () => {
  const second = { ...frame, id: 'second' }
  act(() => useStore.getState().upsertFrame(second))
  vi.spyOn(api, 'setFrameApproval').mockResolvedValueOnce(approved).mockRejectedValueOnce(new Error('offline'))
  await act(async () => setFramesApproval([frame, second], 'ready_for_dev'))
  expect(useStore.getState().canvas!.frames[0]!.approval?.status).toBe('ready_for_dev')
  expect(useStore.getState().canvas!.frames[1]!.approval).toBeUndefined()
  expect(useStore.getState().notice?.text).toContain('1 of 2 screens updated.')
})

it('blocks context-menu approval from the first HTML keystroke until the debounced save completes', async () => {
  vi.useFakeTimers()
  localStorage.setItem('doop:inspector-html', '1')
  let finish!: (result: Frame) => void
  const update = vi.spyOn(api, 'updateFrame').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const approve = vi.spyOn(api, 'setFrameApproval')
  act(() =>
    root.render(
      <TooltipProvider>
        <Inspector frame={frame} />
        <ContextMenu>
          <ContextMenuTrigger>
            <span data-test-menu>Frame</span>
          </ContextMenuTrigger>
          <FrameContextMenu frame={frame} at={{ current: { x: 0, y: 0 } }} />
        </ContextMenu>
      </TooltipProvider>,
    ),
  )
  const input = container.querySelector('textarea')!
  function type(html: string) {
    act(() => {
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, html)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  type('<h1>Edited</h1>')
  type('<h1>Latest edit</h1>')
  expect(useFrameSaves.getState().pending.f).toBe(1)
  act(() =>
    container
      .querySelector('[data-test-menu]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })),
  )
  const item = () =>
    [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === 'Mark ready for dev')!
  expect(item().hasAttribute('data-disabled')).toBe(true)
  expect(toggle().disabled).toBe(true)
  await act(async () => setFramesApproval([frame], 'ready_for_dev'))
  expect(approve).not.toHaveBeenCalled()
  act(() => vi.advanceTimersByTime(700))
  expect(update).toHaveBeenCalledWith('f', { html: '<h1>Latest edit</h1>' })
  expect(item().hasAttribute('data-disabled')).toBe(true)
  await act(async () => finish({ ...frame, updatedAt: 11, html: '<h1>Latest edit</h1>' }))
  expect(useFrameSaves.getState().pending.f).toBeUndefined()
  expect(item().hasAttribute('data-disabled')).toBe(false)
})

it('keeps approval disabled until every overlapping design request has settled', async () => {
  const responses: ((response: Response) => void)[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => responses.push(resolve)))
  let first!: Promise<Frame>
  let second!: Promise<Frame>
  act(() => {
    first = api.updateFrame('f', { html: '<p>One</p>' })
    second = api.updateFrame('f', { width: 900 })
  })
  expect(toggle().disabled).toBe(true)
  await act(async () => {
    responses[0]!(new Response(JSON.stringify(frame)))
    await first
  })
  expect(toggle().disabled).toBe(true)
  await act(async () => {
    responses[1]!(new Response(JSON.stringify(frame)))
    await second
  })
  expect(toggle().disabled).toBe(false)
  vi.mocked(fetch).mockRejectedValueOnce(new Error('Offline'))
  await act(async () => {
    await expect(api.updateFrame('f', { height: 500 })).rejects.toThrow('Offline')
  })
  expect(toggle().disabled).toBe(false)
})
