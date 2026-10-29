import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask, ElementComment, TaskFeedback } from '../shared/types.ts'

/* The queue functions mirror every claim into Postgres and broadcast it; a
   unit test only cares about which items get claimed, so both are stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const actions = await import('../server/actions.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
const CANVAS = 'canvas-1'

/**
 * A run must bill exactly ONE person. Before this, a sweep claimed every
 * pending item for a role and ran them all on whichever connected account was
 * found first — so one collaborator's ChatGPT subscription paid for another's
 * cards. These tests pin the ordering and the isolation between requesters.
 */

function card(id: string, userId: string | undefined, at: number): AgentTask {
  return {
    id,
    agentName: '',
    color: '#000',
    status: `card ${id}`,
    startedAt: at,
    queuedBy: userId ?? 'legacy',
    ...(userId ? { queuedByUserId: userId } : {}),
    stage: 0,
  }
}

function feedback(id: string, userId: string, at: number): TaskFeedback {
  return {
    id,
    taskId: `t-${id}`,
    canvasId: CANVAS,
    agentName: AGENT,
    targetAgent: AGENT,
    from: userId,
    fromUserId: userId,
    text: id,
    at,
  }
}

function comment(id: string, userId: string, at: number): ElementComment {
  return {
    id,
    canvasId: CANVAS,
    frameId: 'f1',
    elementId: 'xx0001',
    snippet: '<p/>',
    from: userId,
    fromUserId: userId,
    text: id,
    at,
    forAgent: true,
    targetAgent: AGENT,
  }
}

function seed(opts: { tasks?: AgentTask[]; feedback?: TaskFeedback[]; comments?: ElementComment[] }) {
  actions.hydrateLogs({
    tasks: new Map([[CANVAS, opts.tasks ?? []]]),
    feedback: new Map([[CANVAS, opts.feedback ?? []]]),
    comments: new Map([[CANVAS, opts.comments ?? []]]),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
}

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  seed({})
})

describe('who pays for the next run', () => {
  it('picks the requester behind the oldest claimable item', () => {
    seed({ tasks: [card('newer', 'bob', 2000), card('older', 'alice', 1000)] })
    expect(actions.nextWorkPayer(CANVAS, AGENT)).toBe('alice')
  })

  it('compares ages across cards, comments and feedback, not within each kind', () => {
    seed({
      tasks: [card('c1', 'bob', 3000)],
      comments: [comment('m1', 'alice', 1000)],
      feedback: [feedback('f1', 'carol', 2000)],
    })
    expect(actions.nextWorkPayer(CANVAS, AGENT)).toBe('alice')
  })

  it('reports work with no recorded requester as unattributed', () => {
    seed({ tasks: [card('legacy', undefined, 1000)] })
    expect(actions.nextWorkPayer(CANVAS, AGENT)).toBe('')
  })

  it('skips a requester who cannot pay so they never block the queue behind them', () => {
    seed({ tasks: [card('c1', 'alice', 1000), card('c2', 'bob', 2000)] })
    expect(actions.nextWorkPayer(CANVAS, AGENT, new Set(['alice']))).toBe('bob')
    expect(actions.nextWorkPayer(CANVAS, AGENT, new Set(['alice', 'bob']))).toBeUndefined()
  })

  it('is undefined when nothing is waiting', () => {
    expect(actions.nextWorkPayer(CANVAS, AGENT)).toBeUndefined()
  })
})

describe('a run claims only its payer', () => {
  it('leaves other requesters cards untouched', () => {
    seed({ tasks: [card('a1', 'alice', 1000), card('b1', 'bob', 2000), card('a2', 'alice', 3000)] })
    const claimed = actions.takeQueuedCardsFor(CANVAS, AGENT, 'alice')
    expect(claimed.map((c) => c.id).sort()).toEqual(['a1', 'a2'])
    /* bob's card is still open, so the next run picks him up and bills him */
    expect(actions.nextWorkPayer(CANVAS, AGENT)).toBe('bob')
  })

  it('isolates comments and feedback by requester too', () => {
    seed({
      comments: [comment('m-alice', 'alice', 1000), comment('m-bob', 'bob', 1100)],
      feedback: [feedback('f-alice', 'alice', 1200), feedback('f-bob', 'bob', 1300)],
    })
    expect(actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice').map((c) => c.id)).toEqual(['m-alice'])
    expect(actions.takeFeedbackFor(CANVAS, AGENT, 'alice').map((f) => f.id)).toEqual(['f-alice'])
    expect(actions.nextWorkPayer(CANVAS, AGENT)).toBe('bob')
  })

  it('claims unattributed work without dragging in an identified requester', () => {
    seed({ tasks: [card('legacy', undefined, 1000), card('a1', 'alice', 2000)] })
    expect(actions.takeQueuedCardsFor(CANVAS, AGENT, '').map((c) => c.id)).toEqual(['legacy'])
    expect(actions.nextWorkPayer(CANVAS, AGENT)).toBe('alice')
  })

  it('still claims everything when no payer is given (the pre-existing callers)', () => {
    seed({ tasks: [card('a1', 'alice', 1000), card('b1', 'bob', 2000)] })
    expect(
      actions
        .takeQueuedCardsFor(CANVAS, AGENT)
        .map((c) => c.id)
        .sort(),
    ).toEqual(['a1', 'b1'])
  })
})
