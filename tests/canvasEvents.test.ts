import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask, Frame } from '../shared/types.ts'

/* The event bus is what email and webhooks hang off; these tests pin down
   that every mutation that should be an event is one, after the room has
   been told, and that one bad listener never reaches the mutation. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const actions = await import('../server/actions.ts')
const events = await import('../server/events.ts')
const { store } = await import('../server/store.ts')

const CANVAS = 'c1'
const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS,
  name: 'Hero',
  html: '<p/>',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}
const card = (): AgentTask => ({
  id: 't1',
  agentName: 'Doop',
  color: '#000',
  status: 'Make it pop',
  startedAt: 1,
  queuedBy: 'alice',
})

let seen: { canvasId: string; event: import('../server/events.ts').CanvasEvent }[]
let broadcasts: string[]

beforeEach(() => {
  seen = []
  broadcasts = []
  actions.wire(
    (_c, msg) => void broadcasts.push(msg.type),
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map([[CANVAS, [card()]]]),
    feedback: new Map(),
    comments: new Map([[CANVAS, []]]),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  vi.spyOn(store, 'getFrame').mockImplementation(async (id) => (id === FRAME.id ? FRAME : undefined))
  vi.spyOn(store, 'createFrame').mockResolvedValue(FRAME)
  return events.onCanvasEvent((canvasId, event) => void seen.push({ canvasId, event }))
})

const alice = { name: 'alice', kind: 'user' as const, color: '#fff' }

describe('what is an event', () => {
  it('a comment, a reply and a resolve', async () => {
    const root = (await actions.addElementComment(
      FRAME.id,
      { selector: 'h1', snippet: '<h1/>', text: 'Hi' },
      'alice',
      'alice',
    ))!
    const reply = (await actions.replyToComment(root.id, 'Yo', 'Doop', 'alice', 'agent'))!
    actions.resolveComment(root.id, 'alice')
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    expect(seen.map((s) => s.event.type)).toEqual(['comment.created', 'comment.replied', 'comment.resolved'])
    expect(seen[0]!.event).toMatchObject({ comment: { id: root.id }, frame: { id: 'f1' }, actorKind: 'user' })
    expect(seen[1]!.event).toMatchObject({ comment: { id: reply.id }, actorKind: 'agent' })
    expect(seen[2]!.event).toMatchObject({
      comment: { id: root.id, resolvedBy: 'alice' },
      by: 'alice',
      frame: { id: 'f1' },
    })
    /* resolving an already-resolved thread is not news twice */
    actions.resolveComment(root.id, 'alice')
    expect(seen).toHaveLength(3)
  })

  it('a frame being created', async () => {
    await actions.createFrame(CANVAS, { name: 'Hero' }, alice)
    expect(seen).toEqual([{ canvasId: CANVAS, event: { type: 'frame.created', frame: FRAME, actor: alice } }])
  })

  it('a board card finishing or failing — once', async () => {
    actions.completeCard(CANVAS, 't1')
    actions.completeCard(CANVAS, 't1')
    expect(seen.map((s) => s.event.type)).toEqual(['task.completed'])
    actions.hydrateLogs({
      tasks: new Map([[CANVAS, [card()]]]),
      feedback: new Map(),
      comments: new Map(),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    /* a card hydrated mid-flight is failed as interrupted at boot; a human retry reopens it */
    actions.retryCard(CANVAS, 't1', 'alice')
    actions.failCard(CANVAS, 't1', 'rate limited')
    actions.failCard(CANVAS, 't1', 'the runner gave up too') // a second report of the same failure
    expect(seen.filter((s) => s.event.type === 'task.failed')).toHaveLength(1)
    expect(seen.at(-1)!.event).toMatchObject({ type: 'task.failed', reason: 'rate limited', task: { id: 't1' } })
  })

  it('fires after the room has been told', async () => {
    let roomKnew = false
    events.onCanvasEvent(() => {
      roomKnew = broadcasts.includes('comment')
    })
    await actions.addElementComment(FRAME.id, { selector: 'h1', snippet: '<h1/>', text: 'Hi' }, 'alice', 'alice')
    expect(roomKnew).toBe(true)
  })
})

describe('listeners', () => {
  it('a throwing listener is skipped, the mutation and the next listener still happen', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off = events.onCanvasEvent(() => {
      throw new Error('boom')
    })
    const after = vi.fn()
    const offAfter = events.onCanvasEvent(after)
    const comment = await actions.addElementComment(FRAME.id, { selector: 'h1', snippet: '<h1/>', text: 'Hi' }, 'alice')
    expect(comment).toBeDefined()
    expect(after).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
    off()
    offAfter()
    error.mockRestore()
  })

  it('unsubscribing stops the calls', async () => {
    const fn = vi.fn()
    events.onCanvasEvent(fn)()
    await actions.addElementComment(FRAME.id, { selector: 'h1', snippet: '<h1/>', text: 'Hi' }, 'alice')
    expect(fn).not.toHaveBeenCalled()
  })
})
