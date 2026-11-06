import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The queue mirrors into Postgres and broadcasts; this test only cares about
   which work a run claims. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { roleName, DEFAULT_ROLE_ID } = await import('../shared/agents.ts')
const { canvasPages } = await import('../shared/pages.ts')

const DOOP = roleName(DEFAULT_ROLE_ID)
const plan = { provider: 'claude-local' as const, model: 'opus' }
const chatgpt = { provider: 'chatgpt' as const, model: 'gpt-5.6-sol', effort: 'high' }

let canvasId: string

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  canvasId = store.createCanvas('runner queue', 'alice').id
})

describe('a card with a runner pick', () => {
  it('carries the pick the composer sent and drops a malformed one', () => {
    const picked = actions.addQueuedCard(canvasId, 'make it red', 'alice', ['doop'], [], 'alice', undefined, chatgpt)
    expect(picked?.runner).toEqual(chatgpt)
    const junk = actions.addQueuedCard(canvasId, 'make it blue', 'alice', ['doop'], [], 'alice', undefined, {
      provider: 'server',
    })
    expect(junk?.runner).toBeUndefined()
  })
  it('is not the same card as the same prompt sent to another connection', () => {
    const a = actions.addQueuedCard(canvasId, 'make it red', 'alice', ['doop'], [], 'alice', undefined, plan)
    const b = actions.addQueuedCard(canvasId, 'make it red', 'alice', ['doop'], [], 'alice', undefined, chatgpt)
    expect(b?.id).not.toBe(a?.id)
  })
})

describe('claiming work per connection', () => {
  it('works the oldest card first and claims only the cards that share its pick', () => {
    const first = actions.addQueuedCard(canvasId, 'one', 'alice', ['doop'], [], 'alice', undefined, plan)!
    const second = actions.addQueuedCard(canvasId, 'two', 'alice', ['doop'], [], 'alice', undefined, chatgpt)!
    const third = actions.addQueuedCard(canvasId, 'three', 'alice', ['doop'], [], 'alice', undefined, plan)!
    /* cards queued in one millisecond tie on age, and a tie goes to the
       newest scanned: a step apart each, so the oldest is unambiguous */
    first.startedAt -= 2
    second.startedAt -= 1
    const work = actions.nextWork(canvasId, DOOP)
    expect(work).toMatchObject({ payer: 'alice', runner: plan })
    const key = actions.workKey('alice', plan)
    expect(work?.key).toBe(key)
    const taken = actions.takeQueuedCardsFor(canvasId, DOOP, 'alice', 'claude-local|opus|')
    expect(taken.map((c) => c.id)).toEqual([third.id, first.id])
    /* the ChatGPT card waits for its own run */
    expect(actions.nextWork(canvasId, DOOP)).toMatchObject({ payer: 'alice', runner: chatgpt })
    expect(actions.takeQueuedCardsFor(canvasId, DOOP, 'alice', 'chatgpt|gpt-5.6-sol|high').map((c) => c.id)).toEqual([
      second.id,
    ])
  })
  it('keeps a card without a pick on the Settings default, apart from picked ones', () => {
    const plain = actions.addQueuedCard(canvasId, 'plain', 'alice', ['doop'], [], 'alice')!
    /* queued a beat earlier: two cards in one millisecond tie on age */
    plain.startedAt -= 1
    actions.addQueuedCard(canvasId, 'picked', 'alice', ['doop'], [], 'alice', undefined, plan)
    expect(actions.nextWork(canvasId, DOOP)).toEqual({ payer: 'alice', key: actions.workKey('alice', undefined) })
    expect(actions.takeQueuedCardsFor(canvasId, DOOP, 'alice', '').map((c) => c.id)).toEqual([plain.id])
  })
  it('skips a stalled pick and goes on to the next connection', () => {
    actions.addQueuedCard(canvasId, 'one', 'alice', ['doop'], [], 'alice', undefined, plan)
    actions.addQueuedCard(canvasId, 'two', 'alice', ['doop'], [], 'alice', undefined, chatgpt)
    const skip = new Set([actions.workKey('alice', plan)])
    expect(actions.nextWork(canvasId, DOOP, skip)?.runner).toEqual(chatgpt)
    expect(actions.nextWorkPayer(canvasId, DOOP, skip)).toBe('alice')
  })
  it('takes every card when no connection filter is given, as callers that bill but do not run do', () => {
    actions.addQueuedCard(canvasId, 'one', 'alice', ['doop'], [], 'alice', undefined, plan)
    actions.addQueuedCard(canvasId, 'two', 'alice', ['doop'], [], 'alice')
    expect(actions.takeQueuedCardsFor(canvasId, DOOP, 'alice')).toHaveLength(2)
  })
})

describe('feedback and comments', () => {
  it('runs feedback on what the task it answers ran on', () => {
    const card = actions.addQueuedCard(canvasId, 'one', 'alice', ['doop'], [], 'alice', undefined, chatgpt)!
    actions.takeQueuedCardsFor(canvasId, DOOP, 'alice')
    const fb = actions.addTaskFeedback(card.id, 'alice', 'more blue', 'alice')!
    expect(actions.nextWork(canvasId, DOOP)).toMatchObject({ payer: 'alice', runner: chatgpt })
    expect(actions.takeFeedbackFor(canvasId, DOOP, 'alice', '').map((f) => f.id)).toEqual([])
    expect(actions.takeFeedbackFor(canvasId, DOOP, 'alice', 'chatgpt|gpt-5.6-sol|high').map((f) => f.id)).toEqual([
      fb.id,
    ])
  })
  it('keeps feedback on its connection after the task leaves the history', () => {
    const card = actions.addQueuedCard(canvasId, 'one', 'alice', ['doop'], [], 'alice', undefined, chatgpt)!
    actions.takeQueuedCardsFor(canvasId, DOOP, 'alice')
    const fb = actions.addTaskFeedback(card.id, 'alice', 'more blue', 'alice')!
    expect(fb.runner).toEqual(chatgpt)
    /* newer cards push the answered task out of the trimmed history */
    const tasks = actions.getTasks(canvasId)
    tasks.splice(tasks.indexOf(card), 1)
    expect(actions.nextWork(canvasId, DOOP)).toMatchObject({ payer: 'alice', runner: chatgpt })
  })
  it('never hands an agent comment to a run on a picked connection', () => {
    const pageId = canvasPages(store.getCanvas(canvasId)!)[0]!.id
    actions.addCanvasComment(canvasId, { pageId, x: 10, y: 10, text: `@${DOOP} fix it` }, 'alice', 'alice')
    expect(actions.nextWork(canvasId, DOOP)).toMatchObject({ payer: 'alice', key: actions.workKey('alice', undefined) })
    expect(actions.takeAgentCommentsFor(canvasId, DOOP, 'alice', 'claude-local|opus|')).toEqual([])
    expect(actions.takeAgentCommentsFor(canvasId, DOOP, 'alice', '')).toHaveLength(1)
  })
})
