import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

/* Replies are persisted and broadcast like any comment; the unit tests only
   care about how a thread is shaped, so both sides are stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
const CANVAS = 'canvas-1'
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

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map([[CANVAS, []]]),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === FRAME.id ? FRAME : undefined))
})

function root() {
  return actions.addElementComment(
    FRAME.id,
    { selector: '.hero h1', snippet: '<h1>Hi</h1>', text: 'Too small' },
    'alice',
  )!
}

describe('replying to a comment', () => {
  it('threads the reply under the root and inherits its element', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, 'Agreed', 'bob')!
    expect(reply.parentId).toBe(parent.id)
    expect(reply.selector).toBe(parent.selector)
    expect(reply.snippet).toBe(parent.snippet)
    expect(actions.commentThread(reply).map((c) => c.text)).toEqual(['Too small', 'Agreed'])
  })

  it('gives every message a distinct timestamp so order survives a reload', () => {
    const parent = root()
    const first = actions.replyToComment(parent.id, 'one', 'bob')!
    const second = actions.replyToComment(parent.id, 'two', 'carol')!
    expect(first.at).toBeGreaterThan(parent.at)
    expect(second.at).toBeGreaterThan(first.at)
  })

  it('re-roots a reply to a reply, keeping threads one level deep', () => {
    const parent = root()
    const first = actions.replyToComment(parent.id, 'Agreed', 'bob')!
    const second = actions.replyToComment(first.id, 'Same', 'carol')!
    expect(second.parentId).toBe(parent.id)
    expect(actions.commentThread(parent).map((c) => c.from)).toEqual(['alice', 'bob', 'carol'])
  })

  it('routes an @mention in a reply to the agent with the thread anchor', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, `@${DEFAULT_ROLE_ID} make it 48px`, 'alice', 'alice')!
    expect(reply.forAgent).toBe(true)
    expect(reply.targetAgent).toBe(AGENT)
    expect(actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice').map((c) => c.id)).toEqual([reply.id])
  })

  it('reports whether a thread can take a reply before anything is metered', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, 'Agreed', 'bob')!
    expect(actions.openThread(reply.id)?.root.id).toBe(parent.id)
    actions.resolveComment(parent.id, 'alice')
    expect(actions.openThread(reply.id)).toBeUndefined()
    expect(actions.openThread('missing')).toBeUndefined()
  })

  it('refuses replies on a resolved thread or with empty text', () => {
    const parent = root()
    expect(actions.replyToComment(parent.id, '   ', 'bob')).toBeUndefined()
    actions.resolveComment(parent.id, 'alice')
    expect(actions.replyToComment(parent.id, 'Late', 'bob')).toBeUndefined()
    expect(actions.replyToComment('missing', 'Hello', 'bob')).toBeUndefined()
  })

  it('resolving the root closes every open reply so none stays queued for an agent', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, `@${DEFAULT_ROLE_ID} bigger`, 'alice', 'alice')!
    actions.resolveComment(parent.id, 'alice')
    expect(actions.findComment(reply.id)?.resolvedAt).toBeDefined()
    expect(actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice')).toEqual([])
  })

  it('resolving a reply leaves the thread open', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, `@${DEFAULT_ROLE_ID} bigger`, 'alice', 'alice')!
    actions.resolveComment(reply.id, AGENT)
    expect(actions.findComment(parent.id)?.resolvedAt).toBeUndefined()
  })
})
