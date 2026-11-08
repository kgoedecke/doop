// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ZoomControls } from '../src/components/ZoomControls'
import { useStore } from '../src/lib/store'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The zoom pill's menu: a field to type a level, and the switches for what
   the canvas draws over the frames. */

let root: Root
let host: HTMLDivElement
const onZoomTo = vi.fn()

beforeEach(async () => {
  useStore.setState({ viewport: { x: 0, y: 0, zoom: 1.5 } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <ZoomControls
        labelRef={createRef<HTMLSpanElement>()}
        hidden={false}
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
        onZoomTo={onZoomTo}
        onFit={vi.fn()}
        onFitSelection={vi.fn()}
      />,
    )
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  onZoomTo.mockReset()
  localStorage.clear()
})

const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Zoom level"]')

async function open() {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Zoom level"]')!
  await act(async () => {
    /* Radix opens a menu on pointerdown, not click */
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

it('opens with the current level in a focused field and zooms to a typed one', async () => {
  await open()
  const input = field()!
  expect(input.value).toBe('150%')
  expect(document.activeElement).toBe(input)
  await type(input, '400')
  expect(onZoomTo).toHaveBeenCalledWith(4)
  expect(field()).toBeNull()
})

it('ignores a level it cannot read and keeps the menu open', async () => {
  await open()
  await type(field()!, 'lots')
  expect(onZoomTo).not.toHaveBeenCalled()
  expect(field()).not.toBeNull()
})

it('switches the comment pins and remembers it', async () => {
  await open()
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.startsWith('Hide comments'),
  )!
  await act(async () => {
    ;(item as HTMLElement).click()
  })
  expect(useStore.getState().viewOptions.comments).toBe(false)
  expect(JSON.parse(localStorage.getItem('doop:view-options')!)).toMatchObject({ comments: false })
  useStore.getState().toggleViewOption('comments')
})
