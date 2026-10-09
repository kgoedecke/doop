import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor, Frame } from '../shared/types'

/* Tasks mirror into Postgres and broadcast; this test only cares about the
   frames a task remembers. */
vi.mock('../server/db/persist.ts', () => ({
  loadLegacyFrameIds: async () => [],
  legacyFrameCanvasId: async () => undefined,
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveGuideline: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

/**
 * Clicking a task in the Agents panel flies the camera to where the agent
 * worked. That needs every task — announced or inferred — to remember the
 * frames it edited, most recent last.
 */

const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
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
  canvasId = store.createCanvas('task frames', 'kevin').id
})

describe('task frames', () => {
  it('an announced task remembers the frames edited while it was open', async () => {
    actions.setAgentStatus(canvasId, agent, 'Designing the landing page')
    const hero = (await actions.createFrame(canvasId, { name: 'Hero', html: '<h1>Hi</h1>' }, agent))!
    const pricing = (await actions.createFrame(canvasId, { name: 'Pricing', html: '<p>$9</p>' }, agent))!
    const task = actions.getTasks(canvasId)[0]!
    expect(task.auto).toBeUndefined()
    expect(task.frameIds).toEqual([hero.id, pricing.id])
  })

  it('an inferred task starts with the frame that triggered it', async () => {
    const frame = (await actions.createFrame(canvasId, { name: 'Hero', html: '<h1>Hi</h1>' }, agent))!
    const task = actions.getTasks(canvasId)[0]!
    expect(task.auto).toBe(true)
    expect(task.frameIds).toEqual([frame.id])
  })

  it('moves a re-edited frame to the end instead of repeating it', async () => {
    actions.setAgentStatus(canvasId, agent, 'Polishing')
    const a = (await actions.createFrame(canvasId, { name: 'A', html: '<p>a</p>' }, agent))!
    const b = (await actions.createFrame(canvasId, { name: 'B', html: '<p>b</p>' }, agent))!
    await actions.updateFrame(a.id, { html: '<p>a2</p>' }, agent)
    expect(actions.getTasks(canvasId)[0]?.frameIds).toEqual([b.id, a.id])
  })

  it('a streamed frame lands on the open task too', async () => {
    actions.setAgentStatus(canvasId, agent, 'Streaming')
    const frame = (await actions.createFrame(canvasId, { name: 'Stream' }, agent))!
    await actions.appendFrameHtml(frame.id, '<section>one</section>', agent, { start: true })
    expect(actions.getTasks(canvasId)[0]?.frameIds).toEqual([frame.id])
  })

  it('a human editing a frame does not touch the agent task', async () => {
    actions.setAgentStatus(canvasId, agent, 'Idle')
    const frame = (await actions.createFrame(
      canvasId,
      { name: 'Draft' },
      { name: 'kevin', kind: 'user', color: '#000' },
    ))!
    await actions.updateFrame(frame.id, { html: '<p>x</p>' }, { name: 'kevin', kind: 'user', color: '#000' })
    expect(actions.getTasks(canvasId)[0]?.frameIds).toBeUndefined()
  })
})

describe('a claimed card next to a status task', () => {
  it('records the frame on both open tasks, not just the newest', async () => {
    /* only the role at a card's stage can claim it — that is the resident agent */
    const resident: Actor = { ...agent, name: roleName(DEFAULT_ROLE_ID) }
    await actions.addQueuedCard(canvasId, 'build the hero', 'kevin')
    const [card] = actions.takeQueuedCardsFor(canvasId, resident.name)
    expect(card?.agentName).toBe(resident.name)
    actions.setAgentStatus(canvasId, resident, 'Working on the hero')
    const frame = (await actions.createFrame(canvasId, { name: 'Hero', html: '<h1>Hi</h1>' }, resident))!
    const tasks = actions.getTasks(canvasId)
    expect(tasks.find((t) => t.id === card?.id)?.frameIds).toEqual([frame.id])
    expect(tasks.find((t) => !t.queuedBy)?.frameIds).toEqual([frame.id])
  })
})

describe('task lifetime and stream ordering', () => {
  let frame: Frame
  beforeEach(async () => {
    frame = (await store.createFrame(canvasId, { name: 'Hero', html: '<p>old</p>' }, agent.name))!
    vi.useFakeTimers()
    vi.spyOn(store, 'getFrame').mockResolvedValue(frame)
    vi.spyOn(store, 'appendFrameHtml').mockResolvedValue(frame)
    vi.spyOn(store, 'updateFrame').mockResolvedValue(frame)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('refreshes the current deadline and prevents an older deadline from ending a newer task', async () => {
    await actions.updateFrame(frame.id, { html: '<p>first</p>' }, agent)
    const first = actions.getTasks(canvasId)[0]!
    await vi.advanceTimersByTimeAsync(4000)
    await actions.updateFrame(frame.id, { html: '<p>second</p>' }, agent)
    await vi.advanceTimersByTimeAsync(1000)
    expect(first.endedAt).toBeUndefined()
    actions.setAgentStatus(canvasId, agent, '')
    await actions.updateFrame(frame.id, { html: '<p>new task</p>' }, agent)
    const newer = actions.getTasks(canvasId)[0]!
    await vi.advanceTimersByTimeAsync(4000)
    expect(newer.endedAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    expect(newer.endedAt).toBeDefined()
  })

  it('keeps a task open until every stream using it finishes', async () => {
    await actions.updateFrame(frame.id, { html: '<p>first</p>' }, agent)
    await actions.appendFrameHtml(frame.id, '<p>', agent, { start: true })
    await actions.appendFrameHtml('second', '<p>', agent, { start: true })
    const task = actions.getTasks(canvasId)[0]!
    await vi.advanceTimersByTimeAsync(6000)
    expect(task.endedAt).toBeUndefined()
    await actions.appendFrameHtml(frame.id, '</p>', agent, { done: true })
    expect(task.endedAt).toBeUndefined()
    await actions.appendFrameHtml('second', '</p>', agent, { done: true })
    expect(task.endedAt).toBeDefined()
  })

  it('commits an in-flight append before finishing and starting the next stream', async () => {
    await actions.appendFrameHtml(frame.id, '<p>', agent, { start: true })
    const previous = actions.getTasks(canvasId)[0]!
    let release!: (value: Frame) => void
    vi.mocked(store.appendFrameHtml).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = actions.appendFrameHtml(frame.id, 'middle', agent)
    await vi.waitFor(() => expect(store.appendFrameHtml).toHaveBeenCalledTimes(2))
    const done = actions.appendFrameHtml(frame.id, '</p>', agent, { done: true })
    const next = actions.appendFrameHtml(frame.id, '<p>next', agent, { start: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.appendFrameHtml).toHaveBeenCalledTimes(2)
    expect(previous.endedAt).toBeUndefined()
    release(frame)
    await Promise.all([pending, done, next])
    expect(previous.endedAt).toBeDefined()
    expect(actions.getTasks(canvasId)[0]?.endedAt).toBeUndefined()
    expect(actions.getTasks(canvasId)[0]?.id).not.toBe(previous.id)
    await actions.appendFrameHtml(frame.id, '</p>', agent, { done: true })
  })

  it('rechecks guideline names and limits after asynchronous placement reads', async () => {
    vi.spyOn(store, 'syncCanvas').mockResolvedValue(store.getCanvasMetadata(canvasId))
    await Promise.all([
      store.setGuideline(canvasId, 'brand', 'First', 'Me'),
      store.setGuideline(canvasId, 'brand', 'Second', 'Me'),
    ])
    expect(store.getGuidelines(canvasId)).toMatchObject([{ name: 'brand', markdown: 'Second' }])
    for (let n = 0; n < 18; n++) await store.setGuideline(canvasId, `doc-${n}`, 'Rules', 'Me', { x: 0, y: n })
    const last = await Promise.allSettled([
      store.setGuideline(canvasId, 'last-a', 'Rules', 'Me'),
      store.setGuideline(canvasId, 'last-b', 'Rules', 'Me'),
    ])
    expect(last.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(store.getGuidelines(canvasId)).toHaveLength(actions.MAX_GUIDELINE_DOCS)
  })
})
