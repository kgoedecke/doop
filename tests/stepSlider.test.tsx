// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StepSlider } from '../src/components/ui/step-slider'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* A drag passes several steps; only where it is let go may be saved, since a
   save per step re-rendered the menu around the slider mid-drag. */
const STEPS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'Extra high' },
]

let root: Root
let container: HTMLDivElement
const onChange = vi.fn()
const input = () => container.querySelector<HTMLInputElement>('input[type="range"]')!
const slideTo = (i: number) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), String(i))
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })

beforeEach(async () => {
  onChange.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(<StepSlider label="Reasoning effort" steps={STEPS} value="medium" onValueChange={onChange} />),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('follows a drag without saving, then saves once where it is let go', async () => {
  await slideTo(2)
  await slideTo(3)
  expect(onChange).not.toHaveBeenCalled()
  /* the label follows the thumb meanwhile */
  expect(container.textContent).toContain('Extra high')
  expect(input().getAttribute('aria-valuetext')).toBe('Extra high')
  act(() => input().dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('xhigh')
})

it('saves nothing when a drag ends where it began', async () => {
  await slideTo(2)
  await slideTo(1)
  act(() => input().dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  expect(onChange).not.toHaveBeenCalled()
})

it('saves a key step on release, and a pending step when focus leaves', async () => {
  await slideTo(0)
  act(() => input().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('low')
  onChange.mockReset()
  await slideTo(2)
  act(() => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('high')
})

it('keeps the picked step showing until its save settles, with no flash of the old one', async () => {
  let finish: () => void = () => {}
  onChange.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
  await slideTo(3)
  act(() => input().dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  /* the save is in flight and `value` is still the old step */
  expect(input().getAttribute('aria-valuetext')).toBe('Extra high')
  await act(async () => {
    root.render(<StepSlider label="Reasoning effort" steps={STEPS} value="xhigh" onValueChange={onChange} />)
    finish()
  })
  expect(input().getAttribute('aria-valuetext')).toBe('Extra high')
})

it('falls back to the saved step when the save fails', async () => {
  onChange.mockRejectedValue(new Error('nope'))
  await slideTo(0)
  await act(async () => input().dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  expect(input().getAttribute('aria-valuetext')).toBe('Medium')
})

it('holds still while a save is under way, so a second pick is never dropped', async () => {
  let finish: () => void = () => {}
  onChange.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
  await slideTo(3)
  act(() => input().dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  expect(input().disabled).toBe(true)
  await act(async () => finish())
  expect(input().disabled).toBe(false)
})
