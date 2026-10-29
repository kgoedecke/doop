import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ElementComment, Frame } from '../shared/types.ts'

/**
 * Comments anchored by a positional CSS path before element ids: the one-off
 * backfill stamps their elements after boot. Persistence is mocked so the
 * order of writes (frame first, then the comments naming its ids) and the
 * handling of bad rows can be asserted.
 */

const writes: string[] = []
const mocks = vi.hoisted(() => ({ frameFails: false }))
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveFrame: () => {},
  saveCanvas: () => {},
  saveFrameNow: async (f: Frame) => {
    if (mocks.frameFails) throw new Error('db down')
    writes.push(`frame:${f.id}`)
  },
  saveCommentNow: async (c: ElementComment) => {
    writes.push(`comment:${c.id}`)
  },
}))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

const frame = (id: string, html: string): Frame => ({
  id,
  canvasId: 'c1',
  pageId: 'p1',
  name: id,
  html,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
})
const comment = (id: string, frameId: string, extra: Partial<ElementComment> = {}): ElementComment => ({
  id,
  canvasId: 'c1',
  frameId,
  snippet: '<p>',
  from: 'alice',
  text: id,
  at: 1,
  ...extra,
})

let canvas: Canvas
const broadcast = vi.fn()

beforeEach(() => {
  writes.length = 0
  mocks.frameFails = false
  broadcast.mockClear()
  canvas = {
    id: 'c1',
    name: 'Old',
    ownerId: 'alice',
    createdAt: 0,
    updatedAt: 0,
    pages: [{ id: 'p1', name: 'Home' }],
    frames: [frame('f1', '<h1>Hi</h1><p>One</p><p>Two</p>'), frame('f2', '<section><p>Deep</p></section>')],
  }
  store.init([canvas])
  actions.wire(broadcast, () => {})
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([
      [
        'c1',
        [
          comment('k1', 'f1'),
          comment('k2', 'f1'),
          comment('k3', 'f1'),
          comment('k4', 'f2'),
          comment('k5', 'f2', { parentId: 'k4' }),
          comment('gone', 'f9'),
        ],
      ],
    ]),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
})

describe('backfillElementIds', () => {
  it('stamps each frame once, writes it before the comments naming its ids, and broadcasts both', async () => {
    const counts = await actions.backfillElementIds(
      new Map([
        ['k1', 'body > p:nth-of-type(1)'],
        ['k2', 'body > p:nth-of-type(2)'],
        ['k3', 'body > p:nth-of-type(1)'],
        ['k4', 'body > section > p'],
        ['k5', 'body > section > p'],
        ['gone', 'body > p'],
      ]),
    )
    expect(counts).toEqual({ stamped: 5, lost: 0, failed: 0 })
    expect(writes).toEqual([
      'frame:f1',
      'comment:k1',
      'comment:k2',
      'comment:k3',
      'frame:f2',
      'comment:k4',
      'comment:k5',
    ])
    const [k1, k2, k3, k4, k5] = ['k1', 'k2', 'k3', 'k4', 'k5'].map((id) => actions.findComment(id)!)
    /* two comments on one element share its id; the reply inherits the root's */
    expect(k1!.elementId).toMatch(/^[a-z0-9]{6}$/)
    expect(k3!.elementId).toBe(k1!.elementId)
    expect(k2!.elementId).not.toBe(k1!.elementId)
    expect(k5!.elementId).toBe(k4!.elementId)
    expect(store.getFrame('f1')!.html).toBe(
      `<h1>Hi</h1><p data-doop-id="${k1!.elementId}">One</p><p data-doop-id="${k2!.elementId}">Two</p>`,
    )
    /* sign-off would have stood: an annotation, not a design change */
    expect(broadcast).toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'frame:updated' }))
    expect(broadcast).toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'comment', comment: k1 }))
  })

  it('leaves a lost anchor where the path no longer resolves, and isolates a row that throws', async () => {
    const counts = await actions.backfillElementIds(
      new Map([
        ['k1', 'body > p:nth-of-type(7)'],
        ['k2', '#\\ffffff > p'],
        ['k3', 'body > p:nth-of-type(2)'],
      ]),
    )
    expect(counts).toEqual({ stamped: 1, lost: 2, failed: 0 })
    expect(actions.findComment('k1')!.elementId).toBeUndefined()
    expect(actions.findComment('k2')!.elementId).toBeUndefined()
    expect(actions.findComment('k3')!.elementId).toMatch(/^[a-z0-9]{6}$/)
    expect(writes).toEqual(['frame:f1', 'comment:k3', 'comment:k1', 'comment:k2'])
  })

  it('writes no comment when the frame write fails, so the selectors stay for the next boot', async () => {
    mocks.frameFails = true
    const counts = await actions.backfillElementIds(new Map([['k1', 'body > p:nth-of-type(1)']]))
    expect(counts).toEqual({ stamped: 0, lost: 0, failed: 1 })
    expect(writes).toEqual([])
    expect(broadcast).not.toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'comment' }))
  })

  it('survives frame HTML nested deeper than the call stack', async () => {
    const deep = '<div>'.repeat(20_000) + '<p>bottom</p>' + '</div>'.repeat(20_000)
    store.init([{ ...canvas, frames: [frame('f1', deep)] }])
    const counts = await actions.backfillElementIds(new Map([['k1', '#nothing > p']]))
    expect(counts).toEqual({ stamped: 0, lost: 1, failed: 0 })
  })
})
