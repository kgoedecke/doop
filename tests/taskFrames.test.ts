import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

/* Tasks mirror into Postgres and broadcast; this test only cares about the
   frames a task remembers. */
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
  it('an announced task remembers the frames edited while it was open', () => {
    actions.setAgentStatus(canvasId, agent, 'Designing the landing page')
    const hero = actions.createFrame(canvasId, { name: 'Hero', html: '<h1>Hi</h1>' }, agent)!
    const pricing = actions.createFrame(canvasId, { name: 'Pricing', html: '<p>$9</p>' }, agent)!
    const task = actions.getTasks(canvasId)[0]!
    expect(task.auto).toBeUndefined()
    expect(task.frameIds).toEqual([hero.id, pricing.id])
  })

  it('an inferred task starts with the frame that triggered it', () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero', html: '<h1>Hi</h1>' }, agent)!
    const task = actions.getTasks(canvasId)[0]!
    expect(task.auto).toBe(true)
    expect(task.frameIds).toEqual([frame.id])
  })

  it('moves a re-edited frame to the end instead of repeating it', () => {
    actions.setAgentStatus(canvasId, agent, 'Polishing')
    const a = actions.createFrame(canvasId, { name: 'A', html: '<p>a</p>' }, agent)!
    const b = actions.createFrame(canvasId, { name: 'B', html: '<p>b</p>' }, agent)!
    actions.updateFrame(a.id, { html: '<p>a2</p>' }, agent)
    expect(actions.getTasks(canvasId)[0]?.frameIds).toEqual([b.id, a.id])
  })

  it('a streamed frame lands on the open task too', () => {
    actions.setAgentStatus(canvasId, agent, 'Streaming')
    const frame = actions.createFrame(canvasId, { name: 'Stream' }, agent)!
    actions.appendFrameHtml(frame.id, '<section>one</section>', agent, { start: true })
    expect(actions.getTasks(canvasId)[0]?.frameIds).toEqual([frame.id])
  })

  it('a human editing a frame does not touch the agent task', () => {
    actions.setAgentStatus(canvasId, agent, 'Idle')
    const frame = actions.createFrame(canvasId, { name: 'Draft' }, { name: 'kevin', kind: 'user', color: '#000' })!
    actions.updateFrame(frame.id, { html: '<p>x</p>' }, { name: 'kevin', kind: 'user', color: '#000' })
    expect(actions.getTasks(canvasId)[0]?.frameIds).toBeUndefined()
  })
})

describe('a claimed card next to a status task', () => {
  it('records the frame on both open tasks, not just the newest', () => {
    /* only the role at a card's stage can claim it — that is the resident agent */
    const resident: Actor = { ...agent, name: roleName(DEFAULT_ROLE_ID) }
    actions.addQueuedCard(canvasId, 'build the hero', 'kevin')
    const [card] = actions.takeQueuedCardsFor(canvasId, resident.name)
    expect(card?.agentName).toBe(resident.name)
    actions.setAgentStatus(canvasId, resident, 'Working on the hero')
    const frame = actions.createFrame(canvasId, { name: 'Hero', html: '<h1>Hi</h1>' }, resident)!
    const tasks = actions.getTasks(canvasId)
    expect(tasks.find((t) => t.id === card?.id)?.frameIds).toEqual([frame.id])
    expect(tasks.find((t) => !t.queuedBy)?.frameIds).toEqual([frame.id])
  })
})
