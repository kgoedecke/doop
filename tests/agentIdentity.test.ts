import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '../shared/types'
import { distinctAgentNames, isAgentsTask } from '../shared/agentIdentity'

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
 * canvas, or one person's two sessions. Each is its own agent: its own
 * presence, and its own tasks, which another agent's status or disconnect
 * never ends. shared/agentIdentity.ts
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
  it('is one agent only when account, session and name all match', () => {
    const key = mcpAgentKey('user-a', 'session-1', 'Claude')
    expect(mcpAgentKey('user-a', 'session-1', 'Claude')).toBe(key)
    expect(mcpAgentKey('user-b', 'session-1', 'Claude')).not.toBe(key)
    expect(mcpAgentKey('user-a', 'session-2', 'Claude')).not.toBe(key)
    expect(mcpAgentKey('user-a', 'session-1', 'Codex')).not.toBe(key)
    expect(mcpAgentKey('user-a', undefined, 'Claude')).not.toBe(key)
  })

  it('names nobody: an opaque, short id', () => {
    const key = mcpAgentKey('user-a', 'session-1', 'Claude')
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

describe('distinctAgentNames', () => {
  it('numbers one owner’s agents sharing a name, and leaves everyone else alone', () => {
    const names = distinctAgentNames([
      { clientId: 'a1', name: 'Claude', kind: 'agent', owner: 'Ana' },
      { clientId: 'b1', name: 'Claude', kind: 'agent', owner: 'Ben' },
      { clientId: 'a2', name: 'Claude', kind: 'agent', owner: 'Ana' },
      { clientId: 'u1', name: 'Claude', kind: 'user' },
      { clientId: 'a3', name: 'Claude', kind: 'agent', owner: 'Ana' },
    ])
    expect(Object.fromEntries(names)).toEqual({ a2: 'Claude 2', a3: 'Claude 3' })
  })
})
