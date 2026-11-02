// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const updateFrame = vi.fn((_id: string, _patch: Partial<Frame>) => Promise.resolve())
vi.mock('../src/lib/api', () => ({
  api: { updateFrame: (id: string, patch: Partial<Frame>) => updateFrame(id, patch) },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
/* the line to the frame's live document (there is no iframe here) */
const requestFrame = vi.fn(() => Promise.resolve(null))
vi.mock('../src/lib/frameBridge', () => ({
  requestFrame: (...args: unknown[]) => requestFrame(...(args as [])),
}))

const { useStore } = await import('../src/lib/store')
const { buildLayerTree, isElementLocked, setElementLocked, LOCK_ATTR } = await import('../src/lib/layers')
const { deleteLayer, replaceLayerHtml, setLayerLocked, shiftLayer, toggleLockSelection } =
  await import('../src/lib/layerEdits')

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`
const SECTION = 'body:nth-of-type(1) > section:nth-of-type(1)'
const INNER = 'body:nth-of-type(1) > section:nth-of-type(1) > p:nth-of-type(1)'
const OTHER = 'body:nth-of-type(1) > p:nth-of-type(1)'

const frame = (html: string): Frame => ({
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
})

function liveHtml(): string {
  return useStore.getState().canvas?.frames[0]?.html ?? ''
}

describe('the layer lock attribute', () => {
  it('toggles data-doop-locked on the element and nothing else', () => {
    const html = page('<section><p>A</p></section><p>B</p>')
    const locked = setElementLocked(html, SECTION, true)
    expect(locked).toContain(`<section ${LOCK_ATTR}="true"><p>A</p></section>`)
    expect(locked).toContain('<p>B</p>')
    expect(setElementLocked(locked!, SECTION, false)).not.toContain(LOCK_ATTR)
    expect(setElementLocked(html, 'body > nav:nth-of-type(9)', true)).toBeNull()
  })

  it('covers everything inside a locked box, while the toggle reads the element itself', () => {
    const html = setElementLocked(page('<section><p>A</p></section><p>B</p>'), SECTION, true)!
    expect(isElementLocked(html, SECTION)).toBe(true)
    expect(isElementLocked(html, INNER)).toBe(true)
    expect(isElementLocked(html, INNER, true)).toBe(false)
    expect(isElementLocked(html, OTHER)).toBe(false)
  })

  it('shows up on the layer tree', () => {
    const html = setElementLocked(page('<section><p>A</p></section><p>B</p>'), SECTION, true)!
    const [section, other] = buildLayerTree(html)
    expect(section?.locked).toBe(true)
    expect(section?.children[0]?.locked).toBe(false)
    expect(other?.locked).toBe(false)
  })
})

describe('edits on a locked layer', () => {
  const html = setElementLocked(page('<section><p>A</p></section><p>B</p>'), SECTION, true)!

  beforeEach(() => {
    updateFrame.mockClear()
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [frame(html)] } as Canvas
    useStore.setState({ canvas, selectedId: 'f1', selectedIds: ['f1'], selectedElement: null })
  })

  it('are refused, and the pick stays so it can be unlocked', () => {
    const f = frame(html)
    useStore.getState().pickElement({ frameId: 'f1', selector: SECTION })
    expect(deleteLayer(f, SECTION)).toBe(false)
    expect(deleteLayer(f, INNER)).toBe(false)
    expect(replaceLayerHtml(f, SECTION, '<section>changed</section>')).toBe(false)
    expect(shiftLayer(f, SECTION, 1)).toBe(false)
    expect(updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().selectedElement).toEqual({ frameId: 'f1', selector: SECTION })
  })

  it('still land on an unlocked sibling', () => {
    expect(deleteLayer(frame(html), OTHER)).toBe(true)
    expect(updateFrame).toHaveBeenCalledTimes(1)
    expect(liveHtml()).not.toContain('<p>B</p>')
  })

  it('resume once the layer is unlocked', () => {
    expect(setLayerLocked(frame(html), SECTION, false)).toBe(true)
    expect(liveHtml()).not.toContain(LOCK_ATTR)
    expect(deleteLayer(frame(liveHtml()), SECTION)).toBe(true)
    expect(liveHtml()).not.toContain('<section')
  })
})

describe('setLayerLocked', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    requestFrame.mockClear()
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [frame(page('<section><p>A</p></section>'))] } as Canvas
    useStore.setState({ canvas, selectedId: 'f1', selectedIds: ['f1'], selectedElement: null })
  })

  it('saves the attribute and hands the same lock to the live document', () => {
    /* a frame in text-edit mode takes no html from the store; the runtime
       has to carry the lock itself or its next text save would drop it */
    expect(setLayerLocked(frame(liveHtml()), SECTION, true)).toBe(true)
    expect(isElementLocked(liveHtml(), SECTION, true)).toBe(true)
    expect(updateFrame).toHaveBeenCalledWith('f1', { html: liveHtml() })
    expect(requestFrame).toHaveBeenCalledWith('f1', 'doop:lock', { selector: SECTION, locked: true })

    expect(setLayerLocked(frame(liveHtml()), SECTION, false)).toBe(true)
    expect(requestFrame).toHaveBeenLastCalledWith('f1', 'doop:lock', { selector: SECTION, locked: false })
  })

  it('touches nothing when the selector no longer resolves', () => {
    expect(setLayerLocked(frame(liveHtml()), 'body > nav:nth-of-type(9)', true)).toBe(false)
    expect(updateFrame).not.toHaveBeenCalled()
    expect(requestFrame).not.toHaveBeenCalled()
  })
})

describe('⌘⇧L', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    const frames = [frame(page('<section><p>A</p></section>')), { ...frame(''), id: 'f2', locked: true }]
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames } as Canvas
    useStore.setState({ canvas, selectedId: 'f1', selectedIds: ['f1'], selectedElement: null })
  })

  it('toggles the picked layer through the frame HTML', () => {
    useStore.getState().pickElement({ frameId: 'f1', selector: SECTION })
    expect(toggleLockSelection()).toBe(true)
    expect(isElementLocked(liveHtml(), SECTION, true)).toBe(true)
    expect(updateFrame).toHaveBeenLastCalledWith('f1', { html: liveHtml() })
    expect(toggleLockSelection()).toBe(true)
    expect(isElementLocked(liveHtml(), SECTION)).toBe(false)
  })

  it('locks a mixed frame selection first, then unlocks it as one', () => {
    useStore.setState({ selectedId: 'f2', selectedIds: ['f1', 'f2'] })
    expect(toggleLockSelection()).toBe(true)
    expect(updateFrame).toHaveBeenCalledTimes(1)
    expect(updateFrame).toHaveBeenCalledWith('f1', { locked: true })
    expect(useStore.getState().canvas?.frames.every((f) => f.locked)).toBe(true)

    expect(toggleLockSelection()).toBe(true)
    expect(updateFrame).toHaveBeenCalledWith('f1', { locked: false })
    expect(updateFrame).toHaveBeenCalledWith('f2', { locked: false })
    expect(useStore.getState().canvas?.frames.some((f) => f.locked)).toBe(false)
  })

  it('does nothing with no selection', () => {
    useStore.setState({ selectedId: null, selectedIds: [] })
    expect(toggleLockSelection()).toBe(false)
    expect(updateFrame).not.toHaveBeenCalled()
  })
})
