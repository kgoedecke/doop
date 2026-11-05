// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useValueScrub } from '../src/hooks/use-value-scrub'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function Scrubber({ value, unit, onChange }: { value: string; unit?: string; onChange: (v: string) => void }) {
  const scrub = useValueScrub({ value, unit, onChange })
  return createElement('span', { ref: scrub.attachHandle, 'data-unit': true, onPointerDown: scrub.onPointerDown })
}

function mount(value: string, unitName?: string) {
  const changes: string[] = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Scrubber, { value, unit: unitName, onChange: (v) => changes.push(v) })))
  const unit = host.querySelector('[data-unit]') as HTMLElement
  Object.assign(unit, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
  })
  return { unit, changes }
}

function pointer(type: string, clientX: number, init: PointerEventInit = {}) {
  return new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientX, bubbles: true, ...init })
}

function wheel(deltaY: number, init: WheelEventInit = {}) {
  return new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init })
}

function drag(unit: HTMLElement, dx: number, init: PointerEventInit = {}) {
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 100 + dx, init))
    unit.dispatchEvent(pointer('pointerup', 100 + dx))
  })
}

describe('useValueScrub', () => {
  it('scrubs a fractional pixel start onto even pixel values', () => {
    const { unit, changes } = mount('9.94px')
    drag(unit, 5)
    expect(changes).toEqual(['14px'])
  })

  it('scrubs pixel values strictly into even pixel values', () => {
    const { unit, changes } = mount('1220', 'px')
    act(() => {
      unit.dispatchEvent(pointer('pointerdown', 100))
      unit.dispatchEvent(pointer('pointermove', 103))
      unit.dispatchEvent(pointer('pointermove', 104))
      unit.dispatchEvent(pointer('pointermove', 105))
      unit.dispatchEvent(pointer('pointermove', 106))
      unit.dispatchEvent(pointer('pointerup', 106))
    })
    // 1220 + 3 = 1223 -> 1224; + 4 = 1224; + 5 = 1225 -> 1226; + 6 = 1226
    expect(changes).toEqual(['1224', '1226'])
  })

  it('snaps an odd starting pixel value to even pixel values on drag', () => {
    const { unit, changes } = mount('1221px')
    drag(unit, 3)
    // 1221 + 3 = 1224
    expect(changes).toEqual(['1224px'])
  })

  it('scrolls with mouse wheel on pixel sliders in even pixel values', () => {
    const { unit, changes } = mount('1220', 'px')
    act(() => {
      unit.dispatchEvent(wheel(-100)) // scroll up: +2
    })
    expect(changes).toEqual(['1222'])
    act(() => {
      unit.dispatchEvent(wheel(100)) // scroll down: -2
    })
    expect(changes).toEqual(['1222', '1218'])
  })

  it('ignores horizontal-only wheel scroll (deltaY === 0)', () => {
    const { unit, changes } = mount('1220', 'px')
    act(() => {
      unit.dispatchEvent(wheel(0, { deltaX: 100 }))
    })
    expect(changes).toEqual([])
  })

  it('ignores wheel events during an active drag so drag cancellation is preserved', () => {
    const { unit, changes } = mount('1220', 'px')
    act(() => {
      unit.dispatchEvent(pointer('pointerdown', 100))
      unit.dispatchEvent(pointer('pointermove', 104))
    })
    expect(changes).toEqual(['1224'])
    // Wheel event during active drag must be ignored
    act(() => {
      unit.dispatchEvent(wheel(-100))
    })
    expect(changes).toEqual(['1224'])
    // Escape should cancel the drag and revert to starting value
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(changes).toEqual(['1224', '1220'])
  })

  it('snaps to tens with Shift and tenths with Alt', () => {
    const shift = mount('9.94')
    drag(shift.unit, 3, { shiftKey: true })
    expect(shift.changes).toEqual(['40'])
    act(() => root?.unmount())
    host?.remove()
    const alt = mount('9.94')
    drag(alt.unit, 3, { altKey: true })
    expect(alt.changes).toEqual(['10.2'])
  })

  it('adds up fractional pointer moves instead of rounding each away for non-pixel fields', () => {
    const { unit, changes } = mount('10')
    act(() => {
      unit.dispatchEvent(pointer('pointerdown', 100))
      unit.dispatchEvent(pointer('pointermove', 103))
      for (let i = 1; i <= 10; i++) unit.dispatchEvent(pointer('pointermove', 103 + i * 0.4))
      unit.dispatchEvent(pointer('pointerup', 107))
    })
    expect(changes).toEqual(['13', '14', '15', '16', '17'])
  })

  it('leaves a whole start alone until the pointer moves', () => {
    const { unit, changes } = mount('12')
    drag(unit, 2)
    expect(changes).toEqual([])
  })
})
