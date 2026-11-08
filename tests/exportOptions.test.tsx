// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ExportOptions } from '../src/components/ExportOptions'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** a scale no preset names, so the custom field shows */
function renderCustom(onChange: (patch: { scale?: number }) => void) {
  act(() => root.render(<ExportOptions value={{ scale: 1.5, format: 'png' }} onChange={onChange} />))
  return container.querySelector<HTMLInputElement>('input[aria-label^="Custom scale"]')!
}

function type(field: HTMLInputElement, text: string) {
  field.value = text
}

it('puts an unreadable custom scale back to the one exports use', () => {
  const onChange = vi.fn()
  const field = renderCustom(onChange)
  for (const text of ['abc', '9', '0']) {
    type(field, text)
    act(() => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(field.value).toBe('1.5')
  }
  expect(onChange).not.toHaveBeenCalled()
})

it('takes a decimal comma, as Portuguese writes it', () => {
  const onChange = vi.fn()
  const field = renderCustom(onChange)
  type(field, '0,5')
  act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(onChange).toHaveBeenCalledWith({ scale: 0.5 })
})
