// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Panel } from '../src/components/ui/panel'

/**
 * While a panel's edge is dragged, <body> carries `data-panel-resizing`, which
 * styles.css keys the chrome's paused transitions on. Two edges can be dragged
 * at once (two fingers): the attribute stays until the last one is let go.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.removeAttribute('data-panel-resizing')
})

const resize = (label: string, edge: 'left' | 'right') => ({
  label,
  edge,
  width: 300,
  min: 200,
  max: 500,
  onResize: () => {},
})

function render() {
  act(() =>
    root.render(
      <>
        <Panel resize={resize('Resize Layers panel', 'right')} />
        <Panel resize={resize('Resize Agents panel', 'left')} />
      </>,
    ),
  )
}

const separator = (label: string) => container.querySelector<HTMLElement>(`[role="separator"][aria-label="${label}"]`)!

function pointer(el: HTMLElement, type: 'pointerdown' | 'pointerup', pointerId: number) {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId, clientX: 10 }))
  })
}

const resizing = () => document.body.hasAttribute('data-panel-resizing')

describe('panel resizing', () => {
  it('marks <body> while an edge is dragged', () => {
    render()
    const layers = separator('Resize Layers panel')
    expect(resizing()).toBe(false)
    pointer(layers, 'pointerdown', 1)
    expect(resizing()).toBe(true)
    pointer(layers, 'pointerup', 1)
    expect(resizing()).toBe(false)
  })

  it('keeps the mark until the last of two dragged edges is released', () => {
    render()
    const layers = separator('Resize Layers panel')
    const agents = separator('Resize Agents panel')
    pointer(layers, 'pointerdown', 1)
    pointer(agents, 'pointerdown', 2)
    pointer(layers, 'pointerup', 1)
    expect(resizing()).toBe(true)
    pointer(agents, 'pointerup', 2)
    expect(resizing()).toBe(false)
  })
})
