import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

/* Replies are persisted and broadcast like any comment; these tests only
   care about what lands in the thread, so both sides are stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { replyInThread, settleComments } = await import('../server/resident.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
const CANVAS = 'canvas-1'
const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS,
  name: 'Hero',
  html: '<h1>Hi</h1><p/>',
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
  vi.spyOn(store, 'updateFrame').mockImplementation((id, patch) => {
    const f = store.getFrame(id)
    return f ? Object.assign(f, patch) : undefined
  })
})

const actor = () => actions.resolveActor({ name: AGENT, kind: 'agent' })
const run = () => ({ repliedThreads: new Set<string>() })

/** A human asks the resident agent for a change, and the run claims it. */
async function ask(text = `@${DEFAULT_ROLE_ID} make it bigger`) {
  const root = (await actions.addElementComment(FRAME.id, { selector: 'h1', snippet: '<h1>Hi</h1>', text }, 'alice'))!
  return actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice')[0] ?? root
}

const texts = (id: string) => actions.commentThread(actions.findComment(id)!).map((c) => `${c.from}: ${c.text}`)

describe('the resident agent replying in a thread', () => {
  it('posts the reply under the root as the agent and remembers the thread', async () => {
    const c = await ask()
    const state = run()
    const posted = replyInThread(c.id, 'Which size did you have in mind?', actor(), state)
    expect(posted.ok).toBe(true)
    expect(texts(c.id)).toEqual([
      `alice: @${DEFAULT_ROLE_ID} make it bigger`,
      `${AGENT}: Which size did you have in mind?`,
    ])
    expect(state.repliedThreads.has(c.id)).toBe(true)
    expect(actions.findComment(c.id)?.resolvedAt).toBeUndefined()
  })

  it('never queues work from its own words', async () => {
    const c = await ask()
    const posted = replyInThread(c.id, `@${DEFAULT_ROLE_ID} do it again`, actor(), run())
    expect(posted.ok).toBe(false)
    expect(texts(c.id)).toHaveLength(1)
    expect(actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice')).toEqual([])
  })

  it('refuses an empty reply or a closed thread', async () => {
    const c = await ask()
    expect(replyInThread(c.id, '  ', actor(), run()).ok).toBe(false)
    actions.resolveComment(c.id, 'alice')
    expect(replyInThread(c.id, 'Done', actor(), run()).ok).toBe(false)
    expect(replyInThread('missing', 'Done', actor(), run()).ok).toBe(false)
  })
})

describe('settling the comments a run was about', () => {
  it('leaves the summary in the thread and resolves it when the run finished', async () => {
    const c = await ask()
    settleComments([c], actor(), { ok: true, summary: 'Raised the heading to 48px.' }, run())
    expect(texts(c.id)).toEqual([`alice: @${DEFAULT_ROLE_ID} make it bigger`, `${AGENT}: Raised the heading to 48px.`])
    const root = actions.findComment(c.id)!
    expect(root.resolvedBy).toBe(AGENT)
    const reply = actions.commentThread(root)[1]!
    expect(reply.resolvedAt).toBeDefined()
  })

  it('leaves the reason in the thread and marks the comment failed when the run did not', async () => {
    const c = await ask()
    settleComments([c], actor(), { ok: false, reason: `${AGENT} hit a snag before finishing.` }, run())
    expect(texts(c.id)[1]).toBe(`${AGENT}: ${AGENT} hit a snag before finishing.`)
    const root = actions.findComment(c.id)!
    expect(root.resolvedAt).toBeUndefined()
    expect(root.failedAt).toBeDefined()
    expect(root.failureReason).toContain('hit a snag')
    /* the thread stays open, so a retry can answer in it again */
    expect(actions.openThread(c.id)?.root.id).toBe(c.id)
  })

  it('does not post the summary over a reply the agent already wrote', async () => {
    const c = await ask()
    const state = run()
    replyInThread(c.id, 'Set it to 48px; shout if you wanted larger.', actor(), state)
    settleComments([c], actor(), { ok: true, summary: 'Raised the heading to 48px.' }, state)
    expect(texts(c.id)).toHaveLength(2)
    expect(actions.findComment(c.id)?.resolvedAt).toBeDefined()
  })

  it('resolves without a reply when there is nothing to say', async () => {
    const c = await ask()
    settleComments([c], actor(), { ok: true, summary: '   ' }, run())
    expect(texts(c.id)).toHaveLength(1)
    expect(actions.findComment(c.id)?.resolvedAt).toBeDefined()
  })

  it('still resolves a thread the agent closed itself during the run', async () => {
    const c = await ask()
    actions.resolveComment(c.id, AGENT)
    settleComments([c], actor(), { ok: true, summary: 'Answered above.' }, run())
    expect(texts(c.id)).toHaveLength(1)
    expect(actions.findComment(c.id)?.resolvedBy).toBe(AGENT)
  })
})
