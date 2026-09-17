// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const updateFrame = vi.fn(() => Promise.resolve())
const deleteFrame = vi.fn(() => Promise.resolve())
vi.mock('../src/lib/api', () => ({
  api: { updateFrame: () => updateFrame(), deleteFrame: () => deleteFrame() },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { deleteSelection } = await import('../src/lib/layerEdits')

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

describe('deleteSelection (the canvas ⌫ shortcut)', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    deleteFrame.mockClear()
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [frame] } as Canvas
    useStore.setState({ canvas, selectedId: 'f1', selectedIds: ['f1'], selectedElement: null })
  })

  it('removes a picked element instead of the frame it lives in', () => {
    useStore.getState().pickElement({ frameId: 'f1', selector: DIV })
    expect(deleteSelection()).toBe(true)
    expect(useStore.getState().canvas?.frames[0]?.html).not.toContain('<div>')
    expect(updateFrame).toHaveBeenCalledTimes(1)
    expect(deleteFrame).not.toHaveBeenCalled()
    expect(useStore.getState().selectedElement).toBeNull()
  })

  it('deletes the selected frames when nothing inside them is picked', () => {
    expect(deleteSelection()).toBe(true)
    expect(deleteFrame).toHaveBeenCalledTimes(1)
    expect(updateFrame).not.toHaveBeenCalled()
  })

  it('does nothing with no selection', () => {
    useStore.setState({ selectedId: null, selectedIds: [] })
    expect(deleteSelection()).toBe(false)
    expect(deleteFrame).not.toHaveBeenCalled()
  })
})

describe('deleteSelection with a stale pick', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    deleteFrame.mockClear()
  })

  it('drops a pick whose frame was deleted remotely instead of deleting other selected frames', () => {
    const other: Frame = { ...frame, id: 'f2' }
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [other] } as Canvas
    useStore.setState({ canvas, selectedId: 'f2', selectedIds: ['f1', 'f2'] })
    useStore.getState().pickElement({ frameId: 'f1', selector: DIV })
    expect(deleteSelection()).toBe(true)
    expect(deleteFrame).not.toHaveBeenCalled()
    expect(useStore.getState().selectedElement).toBeNull()
  })

  it('drops a pick whose selector no longer resolves without touching the frame', () => {
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [frame] } as Canvas
    useStore.setState({ canvas, selectedId: 'f1', selectedIds: ['f1'] })
    useStore.getState().pickElement({ frameId: 'f1', selector: 'body > section:nth-of-type(9)' })
    expect(deleteSelection()).toBe(true)
    expect(deleteFrame).not.toHaveBeenCalled()
    expect(updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().selectedElement).toBeNull()
  })
})
