// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const updateFrame = vi.fn(() => Promise.resolve())
vi.mock('../src/lib/api', () => ({ api: { updateFrame: () => updateFrame() } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { dropLayer } = await import('../src/lib/layerEdits')

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

function frameWith(html: string): Frame {
  return {
    id: 'f1',
    canvasId: 'c1',
    name: 'Frame',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'me',
  }
}

function holdCanvas(frame: Frame) {
  const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [frame] } as Canvas
  useStore.setState({ canvas, selectedId: null, selectedIds: [], selectedElement: null })
}

const DRAG_B = 'body:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(2)'
const INTO_SECTION = { selector: 'body:nth-of-type(1) > section:nth-of-type(1)', place: 'inside' as const }

/* a drag captures its selector at pointer-down and lands at pointer-up; the
   frame may have been edited by someone else in between */
describe('dropLayer', () => {
  beforeEach(() => updateFrame.mockClear())

  it('moves the element when the frame is as it was at pointer-down', () => {
    const pressed = frameWith(page('<div><p>A</p><p>B</p></div><section></section>'))
    holdCanvas(pressed)
    expect(dropLayer(pressed, DRAG_B, INTO_SECTION)).toBe(true)
    expect(useStore.getState().canvas?.frames[0]?.html).toContain('<section><p>B</p></section>')
    expect(updateFrame).toHaveBeenCalledTimes(1)
  })

  it('drops nothing when the frame was edited during the drag, even though the selector still resolves', () => {
    const pressed = frameWith(page('<div><p>A</p><p>B</p></div><section></section>'))
    holdCanvas(pressed)
    /* a collaborator inserts a paragraph above: p:nth-of-type(2) is now A */
    const edited = page('<div><p>NEW</p><p>A</p><p>B</p></div><section></section>')
    useStore.getState().patchFrameLocal(pressed.id, { html: edited })
    expect(dropLayer(pressed, DRAG_B, INTO_SECTION)).toBe(false)
    expect(useStore.getState().canvas?.frames[0]?.html).toBe(edited)
    expect(updateFrame).not.toHaveBeenCalled()
  })

  it('drops nothing when the frame is gone from the canvas', () => {
    const pressed = frameWith(page('<div><p>A</p><p>B</p></div><section></section>'))
    holdCanvas(pressed)
    useStore.setState({ canvas: { ...useStore.getState().canvas!, frames: [] } })
    expect(dropLayer(pressed, DRAG_B, INTO_SECTION)).toBe(false)
    expect(updateFrame).not.toHaveBeenCalled()
  })
})
