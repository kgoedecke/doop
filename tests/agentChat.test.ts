import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask, TaskFeedback } from '../shared/types'
import { chatTurns } from '../src/lib/agentChat'

/* Tasks mirror into Postgres and broadcast; these tests read what is written. */
const saved = vi.hoisted(() => ({ tasks: [] as AgentTask[], feedback: [] as TaskFeedback[] }))
vi.mock('../server/db/persist.ts', () => ({
  saveTask: (_canvasId: string, task: AgentTask) => saved.tasks.push({ ...task }),
  saveFeedback: (fb: TaskFeedback) => saved.feedback.push({ ...fb }),
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

/**
 * The Agents tab shows a chat: each prompt from the composer and the agent's
 * answer under it. The answer is the run's closing words, kept on the card
 * (and on feedback left on it) so it survives a reload.
 */

let canvasId: string
let sent: unknown[]

beforeEach(() => {
  sent = []
  saved.tasks.length = 0
  saved.feedback.length = 0
  actions.wire(
    (_canvasId: string, msg: unknown) => sent.push(msg),
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
  canvasId = store.createCanvas('chat', 'kevin').id
})

describe('recordWorkReply', () => {
  it('keeps the closing words on the card, saves and broadcasts it', () => {
    const card = actions.addQueuedCard(canvasId, 'Make the hero bolder', 'Kevin', ['doop'], [], 'u1')!
    actions.recordWorkReply(canvasId, { cardIds: [card.id], feedbackIds: [] }, '  Bolder headline, tighter hero.  ')
    expect(actions.getTasks(canvasId).find((t) => t.id === card.id)?.reply).toBe('Bolder headline, tighter hero.')
    expect(saved.tasks.at(-1)?.reply).toBe('Bolder headline, tighter hero.')
    expect(sent).toContainEqual({
      type: 'task',
      task: expect.objectContaining({ id: card.id, reply: expect.any(String) }),
    })
  })

  it('answers feedback on a card too', () => {
    const card = actions.addQueuedCard(canvasId, 'Make the hero bolder', 'Kevin', ['doop'], [], 'u1')!
    const fb = actions.addTaskFeedback(card.id, 'Kevin', 'Now try it in blue', 'u1')!
    actions.recordWorkReply(canvasId, { cardIds: [], feedbackIds: [fb.id] }, 'Switched the accent to blue.')
    expect(actions.findFeedback(fb.id)?.reply).toBe('Switched the accent to blue.')
    expect(saved.feedback.at(-1)?.reply).toBe('Switched the accent to blue.')
    expect(actions.getTasks(canvasId).find((t) => t.id === card.id)?.reply).toBeUndefined()
  })

  it('ignores empty words and bounds a runaway answer', () => {
    const card = actions.addQueuedCard(canvasId, 'Hero', 'Kevin', ['doop'], [], 'u1')!
    actions.recordWorkReply(canvasId, { cardIds: [card.id], feedbackIds: [] }, '   ')
    expect(actions.getTasks(canvasId)[0]?.reply).toBeUndefined()
    actions.recordWorkReply(canvasId, { cardIds: [card.id], feedbackIds: [] }, 'x'.repeat(5000))
    expect(actions.getTasks(canvasId)[0]?.reply).toHaveLength(4000)
  })
})

describe('chatTurns', () => {
  const card = (over: Partial<AgentTask>): AgentTask => ({
    id: 'c',
    agentName: '',
    color: '#000',
    status: 'prompt',
    startedAt: 1,
    queuedBy: 'Kevin',
    queuedByUserId: 'u1',
    ...over,
  })

  it('lists composer cards and their feedback oldest first, with who asked', () => {
    const tasks = [
      card({ id: 'b', status: 'Second', startedAt: 20, agentName: 'Doop' }),
      card({ id: 'a', status: 'First', startedAt: 10, agentName: 'Doop', endedAt: 15, reply: 'Done it.' }),
      card({ id: 'ana', status: 'Hers', startedAt: 30, queuedBy: 'Ana', queuedByUserId: 'u2' }),
    ]
    const feedback: TaskFeedback[] = [
      { id: 'f', taskId: 'a', canvasId: 'x', agentName: 'Doop', from: 'Kevin', fromUserId: 'u1', text: 'More', at: 16 },
    ]
    const turns = chatTurns(tasks, feedback, 'u1')
    expect(turns.map((t) => [t.text, t.state, t.mine])).toEqual([
      ['First', 'done', true],
      ['More', 'queued', true],
      ['Second', 'working', true],
      ['Hers', 'queued', false],
    ])
    expect(turns[0]?.reply).toBe('Done it.')
  })

  it('leaves out status tasks, structured cards and feedback on them', () => {
    const tasks = [
      card({ id: 'status', queuedBy: undefined, status: 'Working on the hero' }),
      card({ id: 'repo', kind: 'sketch' }),
    ]
    const feedback: TaskFeedback[] = [
      { id: 'f', taskId: 'status', canvasId: 'x', agentName: 'Doop', from: 'Kevin', text: 'Hm', at: 2 },
    ]
    expect(chatTurns(tasks, feedback, 'u1')).toEqual([])
  })

  it('a failed card carries its reason', () => {
    const [turn] = chatTurns([card({ agentName: 'Doop', failedAt: 5, failureReason: 'Ran out of turns' })], [], 'u1')
    expect(turn).toMatchObject({ state: 'failed', failureReason: 'Ran out of turns' })
  })
})

describe('clampRecentHeight', () => {
  it('keeps Recent tasks above its floor and the chat above its own', async () => {
    const { clampRecentHeight, MIN_CHAT_PX, MIN_RECENT_PX } = await import('../src/lib/agentsSplit')
    expect(clampRecentHeight(10, 600)).toBe(MIN_RECENT_PX)
    expect(clampRecentHeight(250.4, 600)).toBe(250)
    expect(clampRecentHeight(900, 600)).toBe(600 - MIN_CHAT_PX)
    /* a column too short for both still leaves Recent tasks its floor */
    expect(clampRecentHeight(300, 100)).toBe(MIN_RECENT_PX)
  })
})
