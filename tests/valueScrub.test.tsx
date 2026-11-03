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

function Scrubber({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const scrub = useValueScrub({ value, onChange })
  return createElement('span', { 'data-unit': true, onPointerDown: scrub.onPointerDown })
}

function mount(value: string) {
  const changes: string[] = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(createElement(Scrubber, { value, onChange: (v) => changes.push(v) })))
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

function drag(unit: HTMLElement, dx: number, init: PointerEventInit = {}) {
  act(() => {
    unit.dispatchEvent(pointer('pointerdown', 100))
    unit.dispatchEvent(pointer('pointermove', 100 + dx, init))
    unit.dispatchEvent(pointer('pointerup', 100 + dx))
  })
}

describe('useValueScrub', () => {
  it('scrubs a fractional start onto whole values', () => {
    const { unit, changes } = mount('9.94px')
    drag(unit, 5)
    expect(changes).toEqual(['15px'])
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

  it('adds up fractional pointer moves instead of rounding each away', () => {
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
