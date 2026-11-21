import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '../shared/types'
import { isAgentsTask } from '../shared/agentIdentity'

/* Tasks mirror into Postgres and broadcast; these tests read the log itself. */
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
const { mcpAgentKey } = await import('../server/mcp.ts')

/**
 * Two outside agents may go by one name: two people's Claude Code on a shared
 * canvas. Each is its own agent: its own presence, its own tasks, which
 * another agent's status or disconnect never ends, and first pick of the
 * feedback left on its work. shared/agentIdentity.ts
 */

let canvasId: string
let touched: { name: string; agentKey?: string }[]

beforeEach(() => {
  touched = []
  actions.wire(
    () => {},
    (_canvasId, agent) => touched.push({ name: agent.name, agentKey: agent.agentKey }),
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  canvasId = store.createCanvas('identity', 'kevin').id
})

const claude = (agentKey: string, owner: string) => ({
  ...actions.resolveActor({ name: 'Claude', kind: 'agent', owner }),
  agentKey,
})
const open = (key: string) => actions.getTasks(canvasId).filter((t) => t.agentKey === key && !t.endedAt)

describe('mcpAgentKey', () => {
  it('is one agent only when account and name both match', () => {
    const key = mcpAgentKey('user-a', 'Claude')
    expect(mcpAgentKey('user-a', 'Claude')).toBe(key)
    expect(mcpAgentKey('user-b', 'Claude')).not.toBe(key)
    expect(mcpAgentKey('user-a', 'Codex')).not.toBe(key)
    expect(mcpAgentKey(undefined, 'Claude')).not.toBe(key)
  })

  it('names nobody: an opaque, short id', () => {
    const key = mcpAgentKey('user-a', 'Claude')
    expect(key).toMatch(/^mcp:[\w-]{22}$/)
    expect(key).not.toContain('user-a')
  })
})

describe('tasks of agents sharing a name', () => {
  it('one agent posting a status leaves the other one’s task open', () => {
    const ana = claude('mcp:ana', 'Ana')
    const ben = claude('mcp:ben', 'Ben')
    actions.setAgentStatus(canvasId, ana, 'Drawing the hero')
    actions.setAgentStatus(canvasId, ben, 'Writing the pricing page')
    actions.setAgentStatus(canvasId, ana, 'Reviewing the hero')

    expect(open('mcp:ana').map((t) => t.status)).toEqual(['Reviewing the hero'])
    expect(open('mcp:ben').map((t) => t.status)).toEqual(['Writing the pricing page'])
    expect(touched.map((t) => t.agentKey)).toEqual(['mcp:ana', 'mcp:ben', 'mcp:ana'])
  })

  it('one agent going away ends only its own tasks', () => {
    const ana = claude('mcp:ana', 'Ana')
    const ben = claude('mcp:ben', 'Ben')
    actions.setAgentStatus(canvasId, ana, 'Drawing the hero')
    actions.setAgentStatus(canvasId, ben, 'Writing the pricing page')

    actions.endAgentTasks(canvasId, ana)

    expect(open('mcp:ana')).toEqual([])
    expect(open('mcp:ben').map((t) => t.status)).toEqual(['Writing the pricing page'])
  })

  it('an outside agent named like a resident role leaves the role’s work alone', () => {
    const resident = actions.resolveActor({ name: 'Doop', kind: 'agent' })
    const outside = { ...resident, agentKey: 'mcp:outsider' }
    actions.setAgentStatus(canvasId, resident, 'Polishing the nav')
    actions.endAgentTasks(canvasId, outside)
    expect(actions.getTasks(canvasId).filter((t) => !t.endedAt && !t.agentKey)).toHaveLength(1)
  })
})

describe('isAgentsTask', () => {
  const task = (fields: Partial<AgentTask>) => ({ agentName: 'Claude', ...fields })

  it('matches by key where the task has one, else by name', () => {
    expect(isAgentsTask(task({ agentKey: 'mcp:a' }), { name: 'Claude', agentKey: 'mcp:a' })).toBe(true)
    expect(isAgentsTask(task({ agentKey: 'mcp:a' }), { name: 'Claude', agentKey: 'mcp:b' })).toBe(false)
    expect(isAgentsTask(task({ agentKey: 'mcp:a' }), { name: 'Claude' })).toBe(false)
    expect(isAgentsTask(task({}), { name: 'Claude' })).toBe(true)
  })

  it('never matches an unclaimed card', () => {
    expect(isAgentsTask({ agentName: '' }, { name: '' })).toBe(false)
  })
})

describe('feedback on an agent’s work', () => {
  const taskOf = (agent: ReturnType<typeof claude>, status: string) => {
    actions.setAgentStatus(canvasId, agent, status)
    return actions.getTasks(canvasId).find((t) => t.agentKey === agent.agentKey && !t.endedAt)!
  }

  it('waits a minute for the agent whose work it is about, then goes to whoever asks', () => {
    vi.useFakeTimers()
    try {
      const ana = claude('mcp:ana', 'Ana')
      const ben = claude('mcp:ben', 'Ben')
      const fb = actions.addTaskFeedback(taskOf(ben, 'Building the footer').id, 'Kevin', 'Make it darker')!

      expect(actions.openFeedbackFor(canvasId, ana)).toEqual([])
      expect(actions.takeFeedbackFor(canvasId, ana)).toEqual([])
      vi.advanceTimersByTime(actions.OWNER_FIRST_MS)
      expect(actions.takeFeedbackFor(canvasId, ana).map((f) => f.id)).toEqual([fb.id])
      expect(actions.takeFeedbackFor(canvasId, ben)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('makes the resident agents wait the minute too', () => {
    vi.useFakeTimers()
    try {
      const ben = claude('mcp:ben', 'Ben')
      const fb = actions.addTaskFeedback(taskOf(ben, 'Building the footer').id, 'Kevin', 'Make it darker')!
      expect(actions.pendingWorkAgents(canvasId)).toEqual([])
      expect(actions.takeResidentFeedbackFor(canvasId, 'Doop')).toEqual([])
      vi.advanceTimersByTime(actions.OWNER_FIRST_MS)
      expect(actions.pendingWorkAgents(canvasId)).toEqual(['Doop'])
      expect(actions.takeResidentFeedbackFor(canvasId, 'Doop').map((f) => f.id)).toEqual([fb.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes to its own agent at once', () => {
    const ben = claude('mcp:ben', 'Ben')
    const fb = actions.addTaskFeedback(taskOf(ben, 'Building the footer').id, 'Kevin', 'Make it darker')!
    expect(actions.takeFeedbackFor(canvasId, ben).map((f) => f.id)).toEqual([fb.id])
  })
})
