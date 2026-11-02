// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas, Frame } from '../shared/types'

const updateFrame = vi.fn((_id: string, _patch: Partial<Frame>) => Promise.resolve())
vi.mock('../src/lib/api', () => ({
  api: { updateFrame: (id: string, patch: Partial<Frame>) => updateFrame(id, patch) },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({ requestFrame: vi.fn(async () => null) }))

const { requestFrame } = await import('../src/lib/frameBridge')
const { useStore } = await import('../src/lib/store')
const { LayersPanel } = await import('../src/components/LayersPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

const frame: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'Frame',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '<!doctype html><html><head></head><body><div><p>A</p></div></body></html>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
const DIV = 'body:nth-of-type(1) > div:nth-of-type(1)'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function row(key: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-row-key="${key}"]`)
  if (!el) throw new Error(`row ${key} not rendered`)
  return el
}
function eye(key: string): HTMLButtonElement {
  const el = row(key).querySelector<HTMLButtonElement>('button[aria-label="Hide"], button[aria-label="Show"]')
  if (!el) throw new Error(`row ${key} has no eye`)
  return el
}

describe('LayersPanel eye', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [frame] } as Canvas
    useStore.getState().setCanvas(canvas)
    /* the selected frame's row opens on its own, so its layers are listed */
    useStore.setState({ selectedId: 'f1', selectedIds: ['f1'], selectedElement: null })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root.render(
        <TooltipProvider>
          <LayersPanel onAddFrame={() => {}} />
        </TooltipProvider>,
      ),
    )
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('hides a frame from the eye on its row, and the crossed eye stays', () => {
    expect(eye('f1').getAttribute('aria-label')).toBe('Hide')
    act(() => eye('f1').click())
    expect(updateFrame).toHaveBeenCalledWith('f1', { hidden: true })
    expect(useStore.getState().canvas?.frames[0]?.hidden).toBe(true)
    /* the row stays selected: the eye is not a click on the row */
    expect(useStore.getState().selectedId).toBe('f1')
    const crossed = eye('f1')
    expect(crossed.getAttribute('aria-label')).toBe('Show')
    expect(crossed.getAttribute('aria-pressed')).toBe('true')
    act(() => crossed.click())
    expect(updateFrame).toHaveBeenLastCalledWith('f1', { hidden: false })
    expect(useStore.getState().canvas?.frames[0]?.hidden).toBe(false)
  })

  it('lets ↵ press the eye rather than fly to the frame', () => {
    const button = eye('f1')
    const press = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      button.dispatchEvent(press)
    })
    /* the tree's ↵ handler would cancel the press (no click) and fly to the frame */
    expect(press.defaultPrevented).toBe(false)
    expect(useStore.getState().flyTo).toBeNull()
  })

  it('rolls a refused hide back and says so', async () => {
    updateFrame.mockRejectedValueOnce(new Error('offline'))
    act(() => eye('f1').click())
    expect(useStore.getState().canvas?.frames[0]?.hidden).toBe(true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(useStore.getState().canvas?.frames[0]?.hidden).toBe(false)
    expect(eye('f1').getAttribute('aria-label')).toBe('Hide')
    expect(useStore.getState().notice?.text).toBe('Couldn’t hide “Frame”')
  })

  it('hides a layer by marking it in the frame HTML', () => {
    const key = `f1|${DIV}`
    /* a pick inside the frame opens its row, so the layer is listed */
    act(() => useStore.getState().pickElement({ frameId: 'f1', selector: DIV }))
    act(() => eye(key).click())
    const html = useStore.getState().canvas?.frames[0]?.html ?? ''
    expect(html).toContain('<div data-doop-hidden="true" style="display: none !important;"><p>A</p></div>')
    expect(updateFrame).toHaveBeenCalledWith('f1', { html })
    expect(requestFrame).toHaveBeenCalledWith('f1', 'doop:visibility', { selector: DIV, hidden: true })
    expect(eye(key).getAttribute('aria-label')).toBe('Show')
    act(() => eye(key).click())
    const shown = useStore.getState().canvas?.frames[0]?.html ?? ''
    expect(shown).toContain('<div><p>A</p></div>')
    expect(shown).not.toContain('data-doop')
    expect(requestFrame).toHaveBeenLastCalledWith('f1', 'doop:visibility', { selector: DIV, hidden: false })
    expect(eye(key).getAttribute('aria-label')).toBe('Hide')
  })
})
