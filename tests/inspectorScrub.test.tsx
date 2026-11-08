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
  const current = useStore((s) => s.canvas?.frames[0])
  if (!current) return null
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

it('lets undo wait for a slow scrub save, so the inverse write never lands first', async () => {
  const order: string[] = []
  let finish!: () => void
  const update = vi.spyOn(api, 'updateFrame').mockImplementation(
    (id, patch) =>
      new Promise((resolve) => {
        const done = () => {
          order.push(`saved ${JSON.stringify(patch)}`)
          resolve({ ...stored(), ...patch, id })
        }
        if (order.length === 0) {
          order.push('scrub save started')
          finish = done
        } else done()
      }),
  )
  const unit = unitOf('X position')
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 105))
    unit.dispatchEvent(pointer('pointerup', 105))
  })
  const undone = act(() => undo())
  await Promise.resolve()
  expect(update).toHaveBeenCalledTimes(1)
  finish()
  await undone
  expect(order).toEqual(['scrub save started', 'saved {"x":125}', 'saved {"x":120}'])
})

it("leaves a teammate's move of the same frame out of the drag", async () => {
  const update = vi.spyOn(api, 'updateFrame').mockImplementation(async (id, patch) => ({ ...stored(), ...patch, id }))
  const unit = unitOf('Width')
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 110))
  })
  act(() => useStore.getState().patchFrameLocal('f', { x: 400 }))
  act(() => unit.dispatchEvent(pointer('pointerup', 110)))
  expect(update).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledWith('f', { width: 770 })
  await act(() => undo())
  expect(stored()).toMatchObject({ x: 400, width: 760 })
  expect(update).toHaveBeenLastCalledWith('f', { width: 760 })
})

it('commits a field typed before the drag on its own when Tab lands mid-drag', () => {
  const update = vi.spyOn(api, 'updateFrame').mockImplementation(async (id, patch) => ({ ...stored(), ...patch, id }))
  const x = container.querySelector<HTMLInputElement>('input[aria-label="X position"]')!
  act(() => {
    x.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(x, '200')
    x.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const unit = unitOf('Width')
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 110))
  })
  act(() => x.blur())
  expect(stored()).toMatchObject({ x: 200, width: 770 })
  expect(update).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledWith('f', { x: 200 })
  /* the room echoes that save as the server's whole frame, still at the old width */
  act(() => useStore.getState().upsertFrame({ ...frame, x: 200, updatedAt: 11 }))
  expect(stored().width).toBe(760)
  act(() => unit.dispatchEvent(pointer('pointerup', 110)))
  expect(stored().width).toBe(770)
  expect(update).toHaveBeenCalledTimes(2)
  expect(update).toHaveBeenLastCalledWith('f', { width: 770 })
})

it('records and saves nothing when a teammate deletes the frame mid-drag', async () => {
  const update = vi.spyOn(api, 'updateFrame')
  const unit = unitOf('Width')
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 110))
  })
  /* the room's delete unmounts the Inspector, which ends the gesture */
  act(() => useStore.getState().removeFrame('f'))
  expect(container.querySelector('input[aria-label="Width"]')).toBeNull()
  expect(update).not.toHaveBeenCalled()
  await act(() => undo())
  expect(update).not.toHaveBeenCalled()
})

it('puts a cancelled scrub back and saves nothing, keeping what a teammate moved', () => {
  const update = vi.spyOn(api, 'updateFrame')
  const unit = unitOf('Width')
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 90))
  })
  expect(stored().width).toBe(750)
  act(() => useStore.getState().patchFrameLocal('f', { y: 300 }))
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(stored()).toMatchObject({ width: 760, y: 300 })
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

it('scrubs rotation as one save, undoes to zero, and cancels without saving', async () => {
  const update = vi.spyOn(api, 'updateFrame').mockImplementation(async (id, patch) => ({ ...stored(), ...patch, id }))
  const unit = unitOf('Rotation')
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 130))
  })
  expect(stored().rotation).toBe(30)
  expect(update).not.toHaveBeenCalled()
  act(() => unit.dispatchEvent(pointer('pointerup', 130)))
  expect(update).toHaveBeenCalledExactlyOnceWith('f', { rotation: 30 })
  await act(() => undo())
  expect(update).toHaveBeenLastCalledWith('f', { rotation: 0 })
  expect(stored().rotation).toBe(0)
  update.mockClear()
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 145))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(stored().rotation).toBe(0)
  expect(update).not.toHaveBeenCalled()
})
