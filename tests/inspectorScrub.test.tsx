// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { Inspector } from '../src/components/Inspector'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { api } from '../src/lib/api'
import { clearHistory, undo } from '../src/lib/history'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Checkout',
  x: 120,
  y: 120,
  width: 760,
  height: 560,
  html: '<h1>Checkout</h1>',
  createdAt: 1,
  updatedAt: 10,
  updatedBy: 'Designer',
}
let root: Root
let container: HTMLDivElement

function Panel() {
  const current = useStore((s) => s.canvas!.frames[0]!)
  return (
    <TooltipProvider>
      <Inspector frame={current} />
    </TooltipProvider>
  )
}
function stored() {
  return useStore.getState().canvas!.frames[0]!
}
function unitOf(label: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  const unit = input.closest('label')!.querySelector<HTMLElement>('[title]')!
  Object.assign(unit, { setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => false })
  return unit
}
function pointer(type: string, clientX: number, init: PointerEventInit = {}) {
  return new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX, bubbles: true, ...init })
}

beforeEach(() => {
  clearHistory()
  useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [frame], createdAt: 1, updatedAt: 10 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Panel />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('previews a scrubbed X in the store and saves the drag once, as one undo step', async () => {
  const update = vi.spyOn(api, 'updateFrame').mockImplementation(async (id, patch) => ({ ...stored(), ...patch, id }))
  const unit = unitOf('X position')
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 105))
  })
  expect(stored().x).toBe(125)
  expect(update).not.toHaveBeenCalled()
  act(() => {
    unit.dispatchEvent(pointer('pointermove', 110))
    unit.dispatchEvent(pointer('pointerup', 110))
  })
  expect(stored().x).toBe(130)
  expect(update).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledWith('f', { x: 130 })
  expect(container.querySelector<HTMLInputElement>('input[aria-label="X position"]')!.value).toBe('130')

  await act(() => undo())
  expect(stored().x).toBe(120)
  expect(update).toHaveBeenLastCalledWith('f', { x: 120 })
})

it('puts a cancelled scrub back and saves nothing', () => {
  const update = vi.spyOn(api, 'updateFrame')
  const unit = unitOf('Width')
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 90))
  })
  expect(stored().width).toBe(750)
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(stored().width).toBe(760)
  expect(update).not.toHaveBeenCalled()
})

it('keeps a typed width at the frame floor and commits it at once', () => {
  const update = vi.spyOn(api, 'updateFrame').mockImplementation(async (id, patch) => ({ ...stored(), ...patch, id }))
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Width"]')!
  act(() => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.blur()
  })
  expect(stored().width).toBe(1)
  expect(update).toHaveBeenCalledWith('f', { width: 1 })
})
