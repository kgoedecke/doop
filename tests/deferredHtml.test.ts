import { describe, expect, it } from 'vitest'
import { canvasOpenedOn, frameHtmlBatches, openingPageId } from '../shared/frameHtml.ts'
import type { Canvas, Frame } from '../shared/types.ts'

const frame = (id: string, pageId: string | undefined, html = `<p>${id}</p>`): Frame => ({
  id,
  canvasId: 'c',
  ...(pageId ? { pageId } : {}),
  name: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'test',
})

const canvas: Canvas = {
  id: 'c',
  name: 'Canvas',
  createdAt: 1,
  updatedAt: 1,
  pages: [
    { id: 'one', name: 'One' },
    { id: 'two', name: 'Two' },
  ],
  frames: [frame('legacy', undefined), frame('a', 'one'), frame('b', 'two'), frame('c', 'two')],
}

describe('openingPageId', () => {
  it('opens on the first page unless asked otherwise', () => {
    expect(openingPageId(canvas, {})).toBe('one')
  })

  it('opens on the page asked for', () => {
    expect(openingPageId(canvas, { pageId: 'two' })).toBe('two')
  })

  it('opens on the page of a frame a link points at', () => {
    expect(openingPageId(canvas, { frameId: 'c' })).toBe('two')
    expect(openingPageId(canvas, { frameId: 'legacy' })).toBe('one')
  })

  it('lets a page win over a frame', () => {
    expect(openingPageId(canvas, { pageId: 'one', frameId: 'b' })).toBe('one')
  })

  it('ignores a page or frame this canvas does not have, and anything that is not an id', () => {
    expect(openingPageId(canvas, { pageId: 'gone', frameId: 'gone' })).toBe('one')
    expect(openingPageId(canvas, { pageId: 7, frameId: { id: 'b' } })).toBe('one')
  })
})

describe('canvasOpenedOn', () => {
  it('keeps the HTML of the page and defers every other frame', () => {
    const opened = canvasOpenedOn(canvas, 'two')
    expect(opened.frames.map((f) => [f.id, f.html, f.htmlDeferred])).toEqual([
      ['legacy', '', true],
      ['a', '', true],
      ['b', '<p>b</p>', undefined],
      ['c', '<p>c</p>', undefined],
    ])
  })

  it('counts a frame with no page as being on the first', () => {
    expect(canvasOpenedOn(canvas, 'one').frames.map((f) => f.htmlDeferred)).toEqual([undefined, undefined, true, true])
  })

  it('leaves the canvas it was given alone and keeps the rest of each frame', () => {
    const opened = canvasOpenedOn(canvas, 'one')
    expect(canvas.frames.every((f) => f.html !== '' && !f.htmlDeferred)).toBe(true)
    expect(opened.frames[2]).toMatchObject({ id: 'b', pageId: 'two', width: 100, name: 'b' })
    expect(opened.pages).toBe(canvas.pages)
  })
})

describe('frameHtmlBatches', () => {
  const sized = (id: string, size: number) => frame(id, 'one', 'x'.repeat(size))

  it('closes a batch once the next frame would overflow it', () => {
    const batches = frameHtmlBatches([sized('a', 40), sized('b', 40), sized('c', 40)], 100)
    expect(batches.map((batch) => batch.map((f) => f.id))).toEqual([['a', 'b'], ['c']])
  })

  it('gives a frame larger than a batch a batch of its own, whole', () => {
    const batches = frameHtmlBatches([sized('a', 10), sized('big', 500), sized('b', 10)], 100)
    expect(batches.map((batch) => batch.map((f) => f.id))).toEqual([['a'], ['big'], ['b']])
    expect(batches[1]![0]!.html).toHaveLength(500)
  })

  it('sends only the id and the HTML, in order, and nothing for no frames', () => {
    expect(frameHtmlBatches([frame('a', 'one', '<b>')])).toEqual([[{ id: 'a', html: '<b>' }]])
    expect(frameHtmlBatches([])).toEqual([])
  })
})
