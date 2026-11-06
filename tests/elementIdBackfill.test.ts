import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ElementComment } from '../shared/types.ts'

/**
 * Comments anchored by a positional CSS path before element ids: the one-off
 * backfill stamps their elements after boot. Frames live in real actors; the
 * frame write (store.updateFrame) and the comment writes are recorded so the
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
  saveCanvas: () => {},
  deleteFrameHistory: () => {},
  loadLegacyFrameIds: async () => [],
  legacyFrameCanvasId: async () => undefined,
  saveCommentNow: async (c: ElementComment) => {
    writes.push(`comment:${c.id}`)
  },
}))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

/* fixture frame names → the ids their actors were created under */
const ids = new Map<string, string>()
const id = (name: string) => ids.get(name) ?? name
const nameOf = (frameId: string) => [...ids].find(([, value]) => value === frameId)?.[0] ?? frameId
const html = async (name: string) => (await store.getFrame(id(name)))!.html

const comment = (commentId: string, frameName: string, extra: Partial<ElementComment> = {}): ElementComment => ({
  id: commentId,
  canvasId: canvas.id,
  frameId: id(frameName),
  snippet: '<p>',
  from: 'alice',
  text: commentId,
  at: 1,
  ...extra,
})

let canvas: Canvas
const broadcast = vi.fn()
const realUpdate = store.updateFrame.bind(store)

async function seed(frames: Record<string, string>) {
  /* the comment log spans canvases: the previous test's threads must not answer for this one's */
  const previous = canvas?.id
  canvas = {
    id: randomUUID(),
    name: 'Old',
    ownerId: 'alice',
    createdAt: 0,
    updatedAt: 0,
    pages: [{ id: 'p1', name: 'Home' }],
    frames: [],
  }
  store.init([canvas])
  ids.clear()
  for (const [name, markup] of Object.entries(frames)) {
    const frame = (await store.createFrame(canvas.id, { name, pageId: 'p1', html: markup, x: 0, y: 0 }, 'alice'))!
    ids.set(name, frame.id)
  }
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([
      ...(previous ? [[previous, []] as [string, ElementComment[]]] : []),
      [
        canvas.id,
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
}

beforeEach(async () => {
  writes.length = 0
  mocks.frameFails = false
  mocks.duringFrameWrite = undefined
  broadcast.mockClear()
  vi.restoreAllMocks()
  /* record annotation writes (element id stamps) as they land in the frame actor */
  vi.spyOn(store, 'updateFrame').mockImplementation(async (frameId, patch, by, actor, options) => {
    if (!options?.annotation) return realUpdate(frameId, patch, by, actor, options)
    await mocks.duringFrameWrite?.()
    if (mocks.frameFails) throw new Error('actor down')
    const saved = await realUpdate(frameId, patch, by, actor, options)
    if (saved) writes.push(`frame:${nameOf(frameId)}`)
    return saved
  })
  actions.wire(broadcast, () => {})
  await seed({ f1: '<h1>Hi</h1><p>One</p><p>Two</p>', f2: '<section><p>Deep</p></section>' })
})

describe('backfillElementIds', () => {
  it('stamps each frame once, writes it before the comments naming its ids, and broadcasts the comments', async () => {
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
    const [k1, k2, k3, k4, k5] = ['k1', 'k2', 'k3', 'k4', 'k5'].map((commentId) => actions.findComment(commentId)!)
    /* two comments on one element share its id; the reply inherits the root's */
    expect(k1!.elementId).toMatch(/^[a-z0-9]{6}$/)
    expect(k3!.elementId).toBe(k1!.elementId)
    expect(k2!.elementId).not.toBe(k1!.elementId)
    expect(k5!.elementId).toBe(k4!.elementId)
    expect(await html('f1')).toBe(
      `<h1>Hi</h1><p data-doop-id="${k1!.elementId}">One</p><p data-doop-id="${k2!.elementId}">Two</p>`,
    )
    /* the frame itself reaches viewers from its actor; the room carries the comments */
    expect(broadcast).toHaveBeenCalledWith(canvas.id, expect.objectContaining({ type: 'comment', comment: k1 }))
  })

  it('stamps as an annotation: sign-off on the frame stands', async () => {
    const approval = {
      status: 'ready_for_dev' as const,
      approvedBy: 'alice',
      approvedByUserId: 'alice',
      approvedAt: 1,
      approvedFrameUpdatedAt: 1,
    }
    await realUpdate(id('f1'), { approval }, 'alice')
    await actions.backfillElementIds(new Map([['k1', 'body > p:nth-of-type(1)']]))
    expect((await store.getFrame(id('f1')))!.approval?.status).toBe('ready_for_dev')
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
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const counts = await actions.backfillElementIds(new Map([['k1', 'body > p:nth-of-type(1)']]))
    expect(counts).toEqual({ stamped: 0, lost: 0, failed: 1 })
    expect(writes).toEqual([])
    expect(broadcast).not.toHaveBeenCalledWith(canvas.id, expect.objectContaining({ type: 'comment' }))
    error.mockRestore()
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
    expect(broadcast).not.toHaveBeenCalledWith(canvas.id, {
      type: 'comment',
      comment: expect.objectContaining({ id: 'k1', frameId: id('f1') }),
    })
  })

  it('survives frame HTML nested deeper than the call stack', async () => {
    const deep = '<div>'.repeat(20_000) + '<p>bottom</p>' + '</div>'.repeat(20_000)
    await seed({ f1: deep })
    const counts = await actions.backfillElementIds(new Map([['k1', '#nothing > p']]))
    expect(counts).toEqual({ stamped: 0, lost: 1, failed: 0 })
    /* parsing 20,000 levels takes ~1s here and several on a busy CI runner */
  }, 30_000)
})

describe('stamping an element for a new comment', () => {
  it('writes the stamped frame before the comment that names its id', async () => {
    const c = (await actions.addElementComment(
      id('f1'),
      { selector: 'body > p:nth-of-type(1)', text: 'Bigger' },
      'bob',
    ))!
    expect(c.elementId).toMatch(/^[a-z0-9]{6}$/)
    expect(writes).toEqual(['frame:f1', `comment:${c.id}`])
    expect(await html('f1')).toContain(`data-doop-id="${c.elementId}"`)
  })

  it('pins the comment to the frame at its point when the stamped frame cannot be written', async () => {
    mocks.frameFails = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = (await actions.addElementComment(
      id('f1'),
      { selector: 'body > p:nth-of-type(1)', text: 'Bigger', x: 12, y: 34 },
      'bob',
    ))!
    expect(c).toMatchObject({ frameId: id('f1'), x: 12, y: 34 })
    expect(c.elementId).toBeUndefined()
    expect(writes).toEqual([`comment:${c.id}`])
    expect(await html('f1')).not.toContain('data-doop-id')
    error.mockRestore()
  })

  it('gives two requests for the same element one id, stamped once', async () => {
    const [a, b] = await Promise.all([
      actions.ensureElementId(id('f1'), 'body > p:nth-of-type(1)', 'bob'),
      actions.ensureElementId(id('f1'), 'body > p:nth-of-type(1)', 'bob'),
    ])
    expect(a?.id).toMatch(/^[a-z0-9]{6}$/)
    expect(b?.id).toBe(a?.id)
    expect(writes).toEqual(['frame:f1'])
    expect((await html('f1')).match(/data-doop-id/g)).toHaveLength(1)
  })

  it('never stamps over an edit that landed in between', async () => {
    mocks.duringFrameWrite = async () => {
      mocks.duringFrameWrite = undefined
      await realUpdate(id('f1'), { html: '<h1>Hi</h1><p>One</p><p>Two, edited</p>' }, 'carol')
    }
    const stamped = (await actions.ensureElementId(id('f1'), 'body > p:nth-of-type(2)', 'bob'))!
    /* the stale stamp was refused by the frame actor; the retry stamped the current HTML */
    expect(await html('f1')).toBe(`<h1>Hi</h1><p>One</p><p data-doop-id="${stamped.id}">Two, edited</p>`)
  })

  it('stamps nothing after a failed write, and stamps afresh once writes work again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.frameFails = true
    const failed = await actions.ensureElementId(id('f1'), 'body > p:nth-of-type(1)', 'bob').catch(() => undefined)
    expect(failed).toBeUndefined()
    expect(await html('f1')).not.toContain('data-doop-id')
    mocks.frameFails = false
    const stamped = (await actions.ensureElementId(id('f1'), 'body > p:nth-of-type(1)', 'bob'))!
    expect(await html('f1')).toContain(`data-doop-id="${stamped.id}"`)
    expect(writes).toEqual(['frame:f1'])
    error.mockRestore()
  })

  it('takes no comment on a frame deleted while its stamp was being written', async () => {
    mocks.duringFrameWrite = async () => {
      mocks.duringFrameWrite = undefined
      await actions.deleteFrame(id('f1'), { name: 'carol', kind: 'user', color: '#000' })
    }
    const c = await actions.addElementComment(id('f1'), { selector: 'body > p:nth-of-type(1)', text: 'Bigger' }, 'bob')
    expect(c).toBeUndefined()
    expect(await store.getFrame(id('f1'))).toBeUndefined()
    const sent = broadcast.mock.calls.map(([, msg]) => (msg as { type: string }).type)
    expect(sent).not.toContain('comment')
    expect(writes).toEqual([])
  })
})
