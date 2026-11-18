// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const { useStore } = await import('../src/lib/store')

/*
 * The server renders a frame again, with no write of it, when a component it uses changes
 * its markup: the room is sent the frame with new `html`, a greater `rendered` and the
 * `updatedAt` it had. A copy of the frame that left the server before that and arrives
 * after it (a save's HTTP response, which the editor applies when it is not older than
 * what it holds) must not put the older rendering back.
 */

const frame = (patch: Partial<Frame> = {}): Frame => ({
  id: 'f1',
  canvasId: 'c1',
  name: 'Page',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '<p>old rendering</p>',
  createdAt: 1,
  updatedAt: 10,
  updatedBy: 'test',
  ...patch,
})

const held = () => useStore.getState().canvas!.frames.find((each) => each.id === 'f1')!

beforeEach(() => {
  const canvas: Canvas = { id: 'c1', name: 'Canvas', createdAt: 1, updatedAt: 1, frames: [frame()] }
  useStore.getState().setCanvas(canvas)
})

describe('a frame rendered again by the server', () => {
  it('replaces the frame the browser holds, though its version did not move', () => {
    useStore.getState().upsertFrame(frame({ html: '<p>new rendering</p>', rendered: 500 }))
    expect(held().html).toBe('<p>new rendering</p>')
    expect(held().updatedAt).toBe(10)
  })

  it('is not put back by an older copy of the same version arriving late', () => {
    useStore.getState().upsertFrame(frame({ html: '<p>new rendering</p>', rendered: 500 }))
    /* the response to a rename, answered before the re-render */
    useStore.getState().upsertFrame(frame({ name: 'Renamed' }))
    expect(held().html).toBe('<p>new rendering</p>')
    expect(held().rendered).toBe(500)
    expect(held().name).toBe('Renamed')
    /* nor by an earlier re-render overtaken by a later one */
    useStore.getState().upsertFrame(frame({ html: '<p>newer still</p>', rendered: 900 }))
    useStore.getState().upsertFrame(frame({ html: '<p>new rendering</p>', rendered: 500 }))
    expect(held().html).toBe('<p>newer still</p>')
  })

  it('gives way to any write of the frame, and to a copy rendered as late', () => {
    useStore.getState().upsertFrame(frame({ html: '<p>new rendering</p>', rendered: 500 }))
    useStore.getState().upsertFrame(frame({ html: '<p>same rendering, sent again</p>', rendered: 500 }))
    expect(held().html).toBe('<p>same rendering, sent again</p>')
    useStore.getState().upsertFrame(frame({ html: '<p>written</p>', updatedAt: 11 }))
    expect(held().html).toBe('<p>written</p>')
    expect(held().rendered).toBeUndefined()
  })
})
