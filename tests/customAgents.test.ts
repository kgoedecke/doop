import { describe, expect, it, vi } from 'vitest'
import type { ElementComment, TaskFeedback } from '../shared/types.ts'
import type { CustomAgent } from '../shared/customAgents.ts'

/* the queue mirrors every claim into Postgres; only which items it claims
   matters here */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const {
  AGENT_ROLES,
  DEFAULT_ROLE_NAME,
  mentionedRoles,
  normalizePipeline,
  roleByAgentName,
  roleName,
  rosterWith,
  withoutMentions,
} = await import('../shared/agents.ts')
const { handleFor, isAgentHandle, parseCustomAgentInput, parseCustomAgentPatch } =
  await import('../shared/customAgents.ts')
const { normalizeSteps } = await import('../shared/automations.ts')
const actions = await import('../server/actions.ts')
const { systemFor } = await import('../server/resident.ts')

const seo: CustomAgent = {
  id: 'seo',
  name: 'SEO Reviewer',
  color: '#DB2777',
  blurb: 'Search copy',
  brief: 'You are the SEO reviewer. Check the headings.',
  custom: true,
  createdAt: 1,
}
const roster = rosterWith([seo])

const valid = {
  name: 'SEO Reviewer',
  handle: '@SEO',
  color: '#db2777',
  blurb: '  Titles,   headings ',
  brief: 'You are the SEO reviewer. Check the headings.',
  reviewer: true,
}

describe('parseCustomAgentInput', () => {
  it('normalises what the editor sends', () => {
    expect(parseCustomAgentInput(valid)).toEqual({
      ok: true,
      value: { ...valid, handle: 'seo', color: '#DB2777', blurb: 'Titles, headings' },
    })
  })

  it('refuses handles and names the built-in team answers to', () => {
    for (const handle of ['doop', 'copy', 'uxlead', 'usability', 'a11y'])
      expect(parseCustomAgentInput({ ...valid, handle })).toMatchObject({ ok: false })
    expect(parseCustomAgentInput({ ...valid, name: 'copywriter' })).toMatchObject({ ok: false })
  })

  it('refuses malformed fields', () => {
    expect(parseCustomAgentInput({ ...valid, handle: '9lives' })).toMatchObject({ ok: false })
    expect(parseCustomAgentInput({ ...valid, handle: 'seo-lead' })).toMatchObject({ ok: false })
    expect(parseCustomAgentInput({ ...valid, name: '@seo' })).toMatchObject({ ok: false })
    expect(parseCustomAgentInput({ ...valid, brief: 'too short' })).toMatchObject({ ok: false })
    expect(parseCustomAgentInput({ ...valid, blurb: '' })).toMatchObject({ ok: false })
    expect(parseCustomAgentInput({ ...valid, color: 'red' })).toMatchObject({ ok: false })
  })

  it('patches only what may change', () => {
    expect(parseCustomAgentPatch({ name: 'New', handle: 'new', blurb: 'B', reviewer: 1 })).toEqual({
      ok: true,
      value: { blurb: 'B', reviewer: false },
    })
  })

  it('suggests a handle from a name', () => {
    expect(handleFor('Revisão de SEO')).toBe('revisaodeseo')
    expect(handleFor('3D Artist')).toBe('dartist')
    expect(isAgentHandle(handleFor('Brand Voice'))).toBe(true)
  })
})

describe('a roster with custom agents', () => {
  it('routes @mentions of a custom handle, and only with that roster', () => {
    expect(mentionedRoles('@seo then @copy', roster).map((r) => r.id)).toEqual(['seo', 'copy'])
    expect(mentionedRoles('@seo then @copy', AGENT_ROLES).map((r) => r.id)).toEqual(['copy'])
    /* a custom agent answers to its handle, never its squashed name */
    expect(mentionedRoles('@SEOReviewer', roster)).toEqual([])
    expect(mentionedRoles('@seofix', roster)).toEqual([])
  })

  it('looks custom agents up by id and by name', () => {
    expect(roleByAgentName('seo reviewer', roster)?.id).toBe('seo')
    expect(roleName('seo', roster)).toBe('SEO Reviewer')
    expect(roleName('seo', AGENT_ROLES)).toBe(DEFAULT_ROLE_NAME)
    expect(normalizePipeline(['seo', 'gone', 'polish', 'seo'], roster)).toEqual(['seo', 'polish'])
    expect(normalizePipeline(['seo'], AGENT_ROLES)).toEqual(['doop'])
  })

  it('unlinks a custom mention in an agent’s own words', () => {
    expect(withoutMentions('asked @seo and @doop', roster)).toBe('asked seo and doop')
  })

  it('keeps a custom handle on an automation step for the canvas to judge', () => {
    const steps = normalizeSteps([
      { type: 'agent', title: 'Review', prompt: 'Check', roles: ['seo'], canvasId: 'c1' },
      { type: 'agent', title: 'Junk', prompt: 'Check', roles: ['Not A Handle!'], canvasId: 'c1' },
    ])
    expect(Array.isArray(steps) && steps.map((s) => s.type === 'agent' && s.roles)).toEqual([['seo'], ['doop']])
  })
})

describe('the resident prompt', () => {
  it('sets a custom agent’s instructions apart, under the shared rules', () => {
    const prompt = systemFor(seo, roster)
    expect(prompt).toContain('<role_instructions>\nYou are the SEO reviewer. Check the headings.\n</role_instructions>')
    expect(prompt).toContain('the rules above win')
  })

  it('sets a built-in agent’s rewritten instructions apart the same way', () => {
    const copywriter = AGENT_ROLES.find((r) => r.id === 'copy')!
    expect(systemFor(copywriter)).not.toContain('<role_instructions>')
    const rewritten = { ...copywriter, brief: 'Write like a bank: plain, exact.', briefByTeam: true }
    expect(systemFor(rewritten)).toContain(
      '<role_instructions>\nWrite like a bank: plain, exact.\n</role_instructions>',
    )
  })

  it('names the custom agents as colleagues to leave work to', () => {
    const copywriter = AGENT_ROLES.find((r) => r.id === 'copy')!
    expect(systemFor(copywriter, roster)).toContain('SEO Reviewer: search copy')
    expect(systemFor(copywriter)).not.toContain('SEO Reviewer')
  })
})

describe('work addressed to an agent the canvas no longer has', () => {
  const CANVAS = 'gone-canvas'
  const comment: ElementComment = {
    id: 'c1',
    canvasId: CANVAS,
    pageId: 'p1',
    x: 0,
    y: 0,
    snippet: '',
    from: 'Ana',
    fromUserId: 'u1',
    text: '@seo headings',
    at: 1,
    forAgent: true,
    targetAgent: 'SEO Reviewer',
  }
  const reply: TaskFeedback = {
    id: 'f1',
    taskId: 't1',
    canvasId: CANVAS,
    agentName: 'SEO Reviewer',
    targetAgent: 'SEO Reviewer',
    from: 'Ana',
    fromUserId: 'u1',
    text: 'again',
    at: 2,
  }

  it('goes to the default agent instead of waiting forever', () => {
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map([[CANVAS, [{ ...reply }]]]),
      comments: new Map([[CANVAS, [{ ...comment }]]]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    expect(actions.pendingWorkAgents(CANVAS)).toEqual([DEFAULT_ROLE_NAME])
    expect(actions.takeAgentCommentsFor(CANVAS, DEFAULT_ROLE_NAME).map((c) => c.id)).toEqual(['c1'])
    expect(actions.takeFeedbackFor(CANVAS, DEFAULT_ROLE_NAME).map((f) => f.id)).toEqual(['f1'])
  })

  it('marks which claims were a resident run’s, so a restart fails only those', () => {
    const open = (id: string): TaskFeedback => ({ ...reply, id, targetAgent: undefined, agentName: 'Claude' })
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map([[CANVAS, [open('outside')]]]),
      comments: new Map(),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    /* an outside MCP agent named like a custom agent: not the resident */
    expect(actions.takeFeedbackFor(CANVAS, 'Claude')[0]).toMatchObject({
      claimedBy: 'Claude',
      claimedByResident: false,
    })
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map([[CANVAS, [open('resident')]]]),
      comments: new Map(),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    expect(actions.takeResidentFeedbackFor(CANVAS, 'Claude')[0]).toMatchObject({ claimedByResident: true })
  })
})
