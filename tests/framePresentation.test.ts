import { beforeEach, describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { useStore } from '../src/lib/store'

const frame: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'Desktop',
  x: 100,
  y: 200,
  width: 1440,
  height: 900,
  html: '<h1>Hello</h1>',
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'test',
}
const canvas: Canvas = { id: 'c1', name: 'Designs', createdAt: 1, updatedAt: 1, frames: [frame] }
const viewport = { x: -173, y: 81, zoom: 0.65 }

beforeEach(() => {
  const s = useStore.getState()
  s.presentFrame(null)
  s.setCanvas(canvas)
  s.select(frame.id)
  s.setInspectorOpen(true)
  s.setViewport(viewport)
})

describe('frame presentation', () => {
  it('preserves the viewport and selection, ignoring camera updates until closed', () => {
    const s = useStore.getState()
    s.setPanMode(true)
    s.presentFrame(frame.id)
    expect(useStore.getState().panMode).toBe(false)
    s.setViewport({ x: 0, y: 0, zoom: 1 })
    expect(useStore.getState().viewport).toEqual(viewport)
    s.presentFrame(null)
    expect(useStore.getState()).toMatchObject({ viewport, selectedIds: [frame.id], inspectorOpen: true })
    s.setViewport({ x: 20, y: 30, zoom: 1.2 })
    expect(useStore.getState().viewport).toEqual({ x: 20, y: 30, zoom: 1.2 })
  })

  it('keeps presenting through live edits and a reconnect', () => {
    const s = useStore.getState()
    s.presentFrame(frame.id)
    s.patchFrameLocal(frame.id, { html: '<h1>Updated</h1>', height: 1800 })
    s.setCanvas(useStore.getState().canvas)
    expect(useStore.getState().presentedFrameId).toBe(frame.id)
    expect(useStore.getState().canvas?.frames[0].height).toBe(1800)
  })

  it('closes when the presented frame is deleted remotely', () => {
    const s = useStore.getState()
    s.presentFrame(frame.id)
    s.removeFrame(frame.id)
    expect(useStore.getState().presentedFrameId).toBeNull()
    expect(useStore.getState().viewport).toEqual(viewport)
  })

  it('closes when leaving the canvas or reconnecting without the frame', () => {
    const s = useStore.getState()
    s.presentFrame(frame.id)
    s.setCanvas({ ...canvas, frames: [] })
    expect(useStore.getState().presentedFrameId).toBeNull()
    s.setCanvas(canvas)
    s.presentFrame(frame.id)
    s.setCanvas(null)
    expect(useStore.getState().presentedFrameId).toBeNull()
  })

  it('does not freeze the canvas for an unknown frame', () => {
    const s = useStore.getState()
    s.presentFrame('missing')
    expect(useStore.getState().presentedFrameId).toBeNull()
    s.setViewport({ x: 10, y: 20, zoom: 1 })
    expect(useStore.getState().viewport.zoom).toBe(1)
  })
})
