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

describe('deleteSelection on a standalone element', () => {
  const shell: Frame = {
    ...frame,
    id: 'f3',
    html: '<!doctype html><html><head></head><body data-doop-canvas-element="true"><svg><rect></rect></svg></body></html>',
  }
  const SVG = 'body:nth-of-type(1) > svg:nth-of-type(1)'
  const RECT = `${SVG} > rect:nth-of-type(1)`

  beforeEach(() => {
    updateFrame.mockClear()
    deleteFrame.mockClear()
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [shell] } as Canvas
    useStore.setState({ canvas, selectedId: 'f3', selectedIds: ['f3'], selectedElement: null })
  })

  it('deletes the shell frame along with its one layer, leaving no empty frame behind', () => {
    useStore.getState().pickElement({ frameId: 'f3', selector: SVG })
    expect(deleteSelection()).toBe(true)
    expect(deleteFrame).toHaveBeenCalledTimes(1)
    expect(updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().selectedElement).toBeNull()
  })

  it('removes only a picked child, keeping the shell and its layer', () => {
    useStore.getState().pickElement({ frameId: 'f3', selector: RECT })
    expect(deleteSelection()).toBe(true)
    expect(deleteFrame).not.toHaveBeenCalled()
    expect(updateFrame).toHaveBeenCalledTimes(1)
    const html = useStore.getState().canvas?.frames[0]?.html ?? ''
    expect(html).toContain('<svg>')
    expect(html).not.toContain('<rect>')
  })

  it('keeps a locked standalone element and its shell', () => {
    const locked: Frame = { ...shell, html: shell.html.replace('<svg>', '<svg data-doop-locked="true">') }
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [locked] } as Canvas
    useStore.setState({ canvas })
    useStore.getState().pickElement({ frameId: 'f3', selector: SVG })
    expect(deleteSelection()).toBe(true)
    expect(deleteFrame).not.toHaveBeenCalled()
    expect(updateFrame).not.toHaveBeenCalled()
  })
})

describe('deleteSelection with locked frames', () => {
  beforeEach(() => {
    updateFrame.mockClear()
    deleteFrame.mockClear()
  })

  it('skips the locked frames of a selection and deletes the rest', () => {
    const locked: Frame = { ...frame, id: 'f2', locked: true }
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [frame, locked] } as Canvas
    useStore.setState({ canvas, selectedId: 'f2', selectedIds: ['f1', 'f2'], selectedElement: null })
    expect(deleteSelection()).toBe(true)
    expect(deleteFrame).toHaveBeenCalledTimes(1)
  })

  it('leaves a selection made only of locked frames alone', () => {
    const locked: Frame = { ...frame, locked: true }
    const canvas: Canvas = { id: 'c1', name: 'Canvas', frames: [locked] } as Canvas
    useStore.setState({ canvas, selectedId: 'f1', selectedIds: ['f1'], selectedElement: null })
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
