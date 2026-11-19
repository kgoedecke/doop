import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentRole } from '../shared/agents.ts'
import type { AgentTask, ElementComment } from '../shared/types.ts'

/* the queue mirrors every write into Postgres; only what a run reads matters here */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const body = (name: string) => `Follow the ${name} rules on every heading and label.`
const row = (scope: string, handle: string) => ({
  id: `${scope}-${handle}`,
  scope,
  handle,
  description: `${handle} rules`,
  body: body(handle),
  createdBy: 'alice',
  createdAt: 1,
  updatedAt: 1,
})

/* the skills table as two scopes have it: this workspace's and another's */
vi.mock('../server/db/index.ts', async (original) => ({
  ...(await original<object>()),
  db: {
    select: () => ({
      from: async () => [row('ws:ours', 'brand-check'), row('ws:theirs', 'legal'), row('user:alice', 'tone')],
    }),
  },
}))

const actions = await import('../server/actions.ts')
const { hydrateSkills } = await import('../server/skills.ts')
const { requestedSkillsPrompt } = await import('../server/resident.ts')

const CANVAS = 'canvas-1'
const ours = { workspaceId: 'ours', ownerId: 'alice' }

function comment(id: string, text: string, at: number, parentId?: string): ElementComment {
  return { id, canvasId: CANVAS, snippet: '', from: 'alice', text, at, ...(parentId ? { parentId } : {}) }
}

const card = (status: string) => ({ status }) as AgentTask
const none = { items: [], cards: [], comments: [] }

beforeAll(async () => {
  await hydrateSkills()
})

describe('the skills a run is given', () => {
  it('gives the skill a card names', () => {
    expect(requestedSkillsPrompt(ours, { ...none, cards: [card('/brand-check tighten the hero')] })).toContain(
      body('brand-check'),
    )
  })

  it('gives nothing for a handle the canvas has no skill for', () => {
    expect(requestedSkillsPrompt(ours, { ...none, cards: [card('try /nope on /c/abc')] })).toBeUndefined()
  })

  it('never gives another workspace’s skill, nor the owner’s on a workspace canvas', () => {
    expect(requestedSkillsPrompt(ours, { ...none, cards: [card('/legal and /tone please')] })).toBeUndefined()
    expect(requestedSkillsPrompt({ ownerId: 'alice' }, { ...none, cards: [card('/tone please')] })).toContain(
      body('tone'),
    )
  })

  it('keeps the skill a follow-up’s task named', () => {
    const items = [{ from: 'alice', text: 'make it bigger', about: '/brand-check tighten the hero' }]
    expect(requestedSkillsPrompt(ours, { ...none, items })).toContain(body('brand-check'))
  })

  it('keeps the skill named earlier in a reply’s thread, but not later in it', () => {
    const root = comment('c1', '@doop /brand-check the hero', 1)
    const reply = comment('c2', '@doop make it bigger', 2, 'c1')
    const later = comment('c3', 'done, applied /tone too', 3, 'c1')
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map([[CANVAS, [later, reply, root]]]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    expect(requestedSkillsPrompt(ours, { ...none, comments: [reply] })).toContain(body('brand-check'))
    /* alice has /tone, but only the agent's later message names it */
    expect(requestedSkillsPrompt({ ownerId: 'alice' }, { ...none, comments: [reply] })).toBeUndefined()
  })

  it('gives the skill a team named in the running agent’s instructions', () => {
    const reviewer = { id: 'reviewer', brief: 'Always apply /brand-check.' } as AgentRole
    const work = { ...none, cards: [card('tighten the hero')] }
    expect(requestedSkillsPrompt(ours, work, { ...reviewer, custom: true })).toContain(body('brand-check'))
    expect(requestedSkillsPrompt(ours, work, { ...reviewer, briefByTeam: true })).toContain(body('brand-check'))
    /* a shipped brief is never read for handles */
    expect(requestedSkillsPrompt(ours, work, reviewer)).toBeUndefined()
  })
})
