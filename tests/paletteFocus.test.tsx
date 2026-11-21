// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CanvasSearchModal } from '../src/components/CanvasSearchModal'
import { CommandPalette } from '../src/components/CommandPalette'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* ⌘K opens a palette whose search field has the keyboard at once, not the
   modal's × (the first tabbable element Radix would otherwise pick). */

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

it('the canvas search palette focuses its field', async () => {
  await act(async () => {
    root.render(<CanvasSearchModal canvases={[]} onOpen={() => {}} onClose={() => {}} />)
  })
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  expect(document.activeElement?.tagName).toBe('INPUT')
})

it('the command palette focuses its field', async () => {
  await act(async () => {
    root.render(<CommandPalette onClose={() => {}} onAsk={null} />)
  })
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  expect(document.activeElement?.tagName).toBe('INPUT')
})
