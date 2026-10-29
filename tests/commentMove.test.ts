import { describe, expect, it } from 'vitest'
import type { Canvas, ElementComment, Frame } from '../shared/types'
import { frameAtPoint, resolveCommentDrop } from '../src/lib/commentMove'
import { sameCommentAnchor } from '../shared/comments'

/** Dropping a comment pin: which frame is under it, what it re-anchors to. */

function frame(id: string, x: number, y: number, extra: Partial<Frame> = {}): Frame {
  return {
    id,
    canvasId: 'c',
    name: id,
    x,
    y,
    width: 200,
    height: 100,
    html: '<p>Hi</p>',
    updatedBy: 'User',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }
}

const canvas: Pick<Canvas, 'id' | 'pages' | 'frames'> = {
  id: 'c',
  pages: [
    { id: 'first', name: 'Main' },
    { id: 'second', name: 'Other' },
  ],
  frames: [
    frame('under', 0, 0),
    frame('over', 100, 50),
    frame('hidden', 400, 0, { hidden: true }),
    frame('elsewhere', 0, 0, { pageId: 'second' }),
  ],
}

describe('frameAtPoint', () => {
  it('takes the topmost visible frame on the page', () => {
    expect(frameAtPoint(canvas, 'first', { x: 150, y: 75 })?.id).toBe('over')
    expect(frameAtPoint(canvas, 'first', { x: 50, y: 25 })?.id).toBe('under')
    expect(frameAtPoint(canvas, 'first', { x: 450, y: 50 })).toBeUndefined()
    expect(frameAtPoint(canvas, 'first', { x: 700, y: 700 })).toBeUndefined()
    expect(frameAtPoint(canvas, 'second', { x: 50, y: 25 })?.id).toBe('elsewhere')
  })
})

describe('resolveCommentDrop', () => {
  const noElement = async () => null

  it('anchors to the element the frame finds under the point', async () => {
    const asked: unknown[] = []
    const anchor = await resolveCommentDrop(canvas, 'first', { x: 150, y: 75 }, async (frameId, x, y) => {
      asked.push([frameId, x, y])
      return { selector: '#cta', snippet: '<button id="cta">Go</button>' }
    })
    expect(asked).toEqual([['over', 50, 25]])
    /* the point rides along, for the server to fall back to the frame */
    expect(anchor).toEqual({ frameId: 'over', selector: '#cta', snippet: '<button id="cta">Go</button>', x: 50, y: 25 })
    /* an element that already wears its id says so, and is kept by it */
    const stamped = await resolveCommentDrop(canvas, 'first', { x: 150, y: 75 }, async () => ({
      selector: '#cta',
      elementId: 'cta000',
      snippet: '<button id="cta">Go</button>',
    }))
    expect(stamped).toMatchObject({ frameId: 'over', selector: '#cta', elementId: 'cta000' })
  })

  it('anchors to the frame as a whole, at the point, when nothing is under it', async () => {
    expect(await resolveCommentDrop(canvas, 'first', { x: 150, y: 75 }, noElement)).toEqual({
      frameId: 'over',
      snippet: '',
      x: 50,
      y: 25,
    })
    /* a runtime answering with the body is the same as no element */
    const onBody = await resolveCommentDrop(canvas, 'first', { x: 10, y: 10 }, async () => ({
      selector: 'body',
      snippet: '',
    }))
    expect(onBody).toEqual({ frameId: 'under', snippet: '', x: 10, y: 10 })
  })

  it('anchors to the canvas off every frame', async () => {
    let probed = false
    const anchor = await resolveCommentDrop(canvas, 'first', { x: 500, y: 500 }, async () => {
      probed = true
      return null
    })
    expect(probed).toBe(false)
    expect(anchor).toEqual({ pageId: 'first', x: 500, y: 500 })
  })
})

describe('sameCommentAnchor', () => {
  const base: ElementComment = { id: 'k', canvasId: 'c', snippet: '', from: 'A', text: 'T', at: 0 }
  it('tells a drop back onto the same anchor from a move', () => {
    const onElement = { ...base, frameId: 'f', elementId: 'aaaaaa', snippet: '<p id="a">' }
    const at = { x: 3, y: 4 }
    /* the same element wears the same id; an unstamped element is another one */
    expect(
      sameCommentAnchor(onElement, { frameId: 'f', selector: '#a', elementId: 'aaaaaa', snippet: '', ...at }),
    ).toBe(true)
    expect(
      sameCommentAnchor(onElement, { frameId: 'f', selector: '#b', elementId: 'bbbbbb', snippet: '', ...at }),
    ).toBe(false)
    expect(sameCommentAnchor(onElement, { frameId: 'f', selector: '#b', snippet: '', ...at })).toBe(false)
    expect(
      sameCommentAnchor(onElement, { frameId: 'g', selector: '#a', elementId: 'aaaaaa', snippet: '', ...at }),
    ).toBe(false)
    expect(sameCommentAnchor(onElement, { frameId: 'f', snippet: '', ...at })).toBe(false)
    expect(sameCommentAnchor(onElement, { pageId: 'first', x: 1, y: 2 })).toBe(false)
    const onFrame = { ...base, frameId: 'f', x: 10, y: 20 }
    expect(sameCommentAnchor(onFrame, { frameId: 'f', snippet: '', x: 10, y: 20 })).toBe(true)
    expect(sameCommentAnchor(onFrame, { frameId: 'f', snippet: '', x: 11, y: 20 })).toBe(false)
    expect(sameCommentAnchor(onFrame, { frameId: 'f', selector: '#a', snippet: '', x: 10, y: 20 })).toBe(false)
    const onCanvas = { ...base, pageId: 'first', x: 1, y: 2 }
    expect(sameCommentAnchor(onCanvas, { pageId: 'first', x: 1, y: 2 })).toBe(true)
    expect(sameCommentAnchor(onCanvas, { pageId: 'first', x: 1, y: 3 })).toBe(false)
    expect(sameCommentAnchor(onCanvas, { frameId: 'f', selector: 'body', snippet: '', x: 1, y: 2 })).toBe(false)
  })
})
