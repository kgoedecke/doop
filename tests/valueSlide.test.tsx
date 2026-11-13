// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NumberField } from '../src/components/ui/property-field'
import { slidePosition, slideValue } from '../src/hooks/use-value-slide'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let commits: number[]

function Field({ start = 0 }: { start?: number }) {
  const [value, setValue] = useState(start)
  return (
    <NumberField
      label="Opacity"
      value={value}
      max={100}
      slider={[0, 100]}
      unit="%"
      onCommit={(v) => {
        commits.push(v)
        setValue(v)
      }}
    />
  )
}
function field() {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!
  const label = input.closest('label')!
  Object.assign(label, {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 100, width: 200, top: 0, height: 26, right: 300, bottom: 26 }),
  })
  return { input, label }
}
function pointer(type: string, clientX: number, init: PointerEventInit = {}) {
  return new PointerEvent(type, {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX,
    bubbles: true,
    ...init,
  })
}
function mount(start?: number) {
  act(() => root.render(<Field start={start} />))
}

beforeEach(() => {
  commits = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('moves a value by the share of the track dragged, snapped to the step', () => {
  expect(slideValue(40, 0.5, [0, 100], 1)).toBe(90)
  expect(slideValue(40, -0.123, [0, 100], 1)).toBe(28)
  expect(slideValue(40, 0.06, [0, 100], 10)).toBe(50)
  expect(slideValue(40, -1, [0, 100], 1)).toBe(0)
  expect(slideValue(0, 1, [-180, 180], 1)).toBe(180)
  // a typed value past the range is not pulled back into it
  expect(slideValue(200, 0.1, [0, 100], 1)).toBe(200)
  expect(slideValue(200, -0.1, [0, 100], 1)).toBe(190)
})

it('places the thumb at the value, pinned to the track', () => {
  expect(slidePosition(25, [0, 100])).toBe(0.25)
  expect(slidePosition(200, [0, 100])).toBe(1)
  expect(slidePosition(0, [-180, 180])).toBe(0.5)
})

it('moves the value from where it was, never jumping to the pointer', () => {
  mount(40)
  const { input, label } = field()
  const slide = () => label.querySelector<HTMLElement>('[data-slide]')!
  expect(slide().className).toContain('opacity-0')
  act(() => {
    label.dispatchEvent(pointer('pointerdown', 280))
    label.dispatchEvent(pointer('pointermove', 290))
  })
  // 10px of a 200px field is 5% of the range: 40 → 45, wherever the press was
  expect(input.value).toBe('45')
  expect(slide().className).toContain('opacity-100')
  expect((slide().firstElementChild as HTMLElement).style.width).toBe('45%')
  act(() => {
    label.dispatchEvent(pointer('pointermove', 180))
    label.dispatchEvent(pointer('pointerup', 180))
  })
  expect(commits).toEqual([45, 0])
  expect(input.value).toBe('0')
  expect(slide().className).toContain('opacity-0')
})

it('slows an Alt drag to a tenth, in 0.1 steps, and snaps a Shift drag to tens', () => {
  mount(40)
  const { input, label } = field()
  act(() => {
    label.dispatchEvent(pointer('pointerdown', 150))
    // 20px of a 200px field is 10 at full speed, 1 with Alt
    label.dispatchEvent(pointer('pointermove', 170, { altKey: true }))
  })
  expect(input.value).toBe('41')
  act(() => {
    // releasing Alt mid-drag carries on from 41, not from where full speed would be
    label.dispatchEvent(pointer('pointermove', 180))
  })
  expect(input.value).toBe('46')
  act(() => {
    label.dispatchEvent(pointer('pointermove', 188, { shiftKey: true }))
    label.dispatchEvent(pointer('pointerup', 188, { shiftKey: true }))
  })
  expect(input.value).toBe('50')
})

it('leaves a click to the text: no value change, the field focused for typing', () => {
  mount(40)
  const { input, label } = field()
  act(() => {
    label.dispatchEvent(pointer('pointerdown', 150))
    label.dispatchEvent(pointer('pointermove', 151))
    label.dispatchEvent(pointer('pointerup', 151))
  })
  expect(commits).toEqual([])
  expect(document.activeElement).toBe(input)
})

it('puts the value back on Escape', () => {
  mount(40)
  const { input, label } = field()
  act(() => {
    label.dispatchEvent(pointer('pointerdown', 150))
    label.dispatchEvent(pointer('pointermove', 250))
  })
  expect(input.value).toBe('90')
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })
  expect(commits).toEqual([90, 40])
  expect(input.value).toBe('40')
})

it('keeps the pointer for selecting text once the field is being typed into', () => {
  mount(40)
  const { input, label } = field()
  act(() => input.focus())
  act(() => {
    label.dispatchEvent(pointer('pointerdown', 150))
    label.dispatchEvent(pointer('pointermove', 280))
    label.dispatchEvent(pointer('pointerup', 280))
  })
  expect(commits).toEqual([])
})
