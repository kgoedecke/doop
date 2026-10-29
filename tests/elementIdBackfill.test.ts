import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ElementComment, Frame } from '../shared/types.ts'

/**
 * Comments anchored by a positional CSS path before element ids: the one-off
 * backfill stamps their elements after boot. Persistence is mocked so the
 * order of writes (frame first, then the comments naming its ids) and the
 * handling of bad rows can be asserted.
 */

const writes: string[] = []
const mocks = vi.hoisted(() => ({
  frameFails: false,
  /* runs while a frame write is out, for whatever a person does meanwhile */
  duringFrameWrite: undefined as (() => Promise<unknown>) | undefined,
}))
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: (c: ElementComment) => {
    writes.push(`comment:${c.id}`)
  },
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveFrame: () => {},
  saveCanvas: () => {},
  deleteFrame: (id: string) => {
    writes.push(`delete:${id}`)
  },
  saveFrameNow: async (f: Frame) => {
    await mocks.duringFrameWrite?.()
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
  mocks.duringFrameWrite = undefined
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

  it('leaves a thread moved while the frame write was out where it was moved to', async () => {
    mocks.duringFrameWrite = async () => {
      mocks.duringFrameWrite = undefined
      await actions.moveComment('k1', { pageId: 'p1', x: 40, y: 50 }, 'bob')
      writes.push('moved')
    }
    const counts = await actions.backfillElementIds(
      new Map([
        ['k1', 'body > p:nth-of-type(1)'],
        ['k2', 'body > p:nth-of-type(2)'],
      ]),
    )
    expect(counts).toEqual({ stamped: 1, lost: 0, failed: 0 })
    expect(writes).toEqual(['comment:k1', 'moved', 'frame:f1', 'comment:k2'])
    const k1 = actions.findComment('k1')!
    expect(k1).toMatchObject({ pageId: 'p1', x: 40, y: 50 })
    expect(k1.frameId).toBeUndefined()
    expect(k1.elementId).toBeUndefined()
    expect(broadcast).not.toHaveBeenCalledWith('c1', {
      type: 'comment',
      comment: expect.objectContaining({ id: 'k1', frameId: 'f1' }),
    })
  })

  it('survives frame HTML nested deeper than the call stack', async () => {
    const deep = '<div>'.repeat(20_000) + '<p>bottom</p>' + '</div>'.repeat(20_000)
    store.init([{ ...canvas, frames: [frame('f1', deep)] }])
    const counts = await actions.backfillElementIds(new Map([['k1', '#nothing > p']]))
    expect(counts).toEqual({ stamped: 0, lost: 1, failed: 0 })
  })
})

describe('stamping an element for a new comment', () => {
  it('writes the stamped frame before the comment that names its id', async () => {
    const c = (await actions.addElementComment('f1', { selector: 'body > p:nth-of-type(1)', text: 'Bigger' }, 'bob'))!
    expect(c.elementId).toMatch(/^[a-z0-9]{6}$/)
    expect(writes).toEqual(['frame:f1', `comment:${c.id}`])
    expect(store.getFrame('f1')!.html).toContain(`data-doop-id="${c.elementId}"`)
  })

  it('pins the comment to the frame at its point when the stamped frame cannot be written', async () => {
    mocks.frameFails = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = (await actions.addElementComment(
      'f1',
      { selector: 'body > p:nth-of-type(1)', text: 'Bigger', x: 12, y: 34 },
      'bob',
    ))!
    expect(c).toMatchObject({ frameId: 'f1', x: 12, y: 34 })
    expect(c.elementId).toBeUndefined()
    expect(writes).toEqual([`comment:${c.id}`])
    expect(broadcast).not.toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'frame:updated' }))
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('hands a second request for the same element the id only once the first write has landed', async () => {
    let release = () => {}
    mocks.duringFrameWrite = () => new Promise<void>((resolve) => (release = resolve))
    const first = actions.ensureElementId('f1', 'body > p:nth-of-type(1)', 'bob')
    const second = actions.ensureElementId('f1', 'body > p:nth-of-type(1)', 'bob')
    let answered = false
    void second.then(() => (answered = true))
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(answered).toBe(false)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(b?.id).toBe(a?.id)
    expect(writes).toEqual(['frame:f1'])
  })

  it('writes a stamp left unsaved by a failed write before handing its id out again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.frameFails = true
    expect(await actions.ensureElementId('f1', 'body > p:nth-of-type(1)', 'bob')).toBeUndefined()
    const id = /data-doop-id="(\w+)"/.exec(store.getFrame('f1')!.html)![1]!
    /* still failing: neither path names the id */
    expect(await actions.ensureElementId('f1', 'body > p:nth-of-type(1)', 'bob')).toBeUndefined()
    const c = (await actions.addElementComment('f1', { elementId: id, text: 'Bigger', x: 1, y: 2 }, 'bob'))!
    expect(c.elementId).toBeUndefined()
    mocks.frameFails = false
    expect((await actions.ensureElementId('f1', 'body > p:nth-of-type(1)', 'bob'))?.id).toBe(id)
    expect(writes).toEqual([`comment:${c.id}`, 'frame:f1'])
    error.mockRestore()
  })

  it('neither shows nor writes back a frame deleted while its stamp was being written', async () => {
    mocks.duringFrameWrite = async () => {
      mocks.duringFrameWrite = undefined
      actions.deleteFrame('f1', { name: 'carol', kind: 'user', color: '#000' })
    }
    const c = await actions.addElementComment('f1', { selector: 'body > p:nth-of-type(1)', text: 'Bigger' }, 'bob')
    expect(c).toBeUndefined()
    const sent = broadcast.mock.calls.map(([, msg]) => (msg as { type: string }).type)
    expect(sent).toContain('frame:deleted')
    expect(sent).not.toContain('frame:updated')
    expect(sent).not.toContain('comment')
    /* the stamp's write landed after the delete: the row goes again */
    expect(writes).toEqual(['delete:f1', 'frame:f1', 'delete:f1'])
  })
})
