import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '../shared/types.ts'
import type { AgentTurnRequest } from '../server/agentModel.ts'

const mocks = vi.hoisted(() => ({ pickModel: vi.fn() }))

vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/agentModel.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/agentModel.ts')>()),
  pickModel: mocks.pickModel,
}))

const actions = await import('../server/actions.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
const CANVAS = 'canvas-stop'

function card(id: string): AgentTask {
  return {
    id,
    agentName: '',
    color: '#000',
    status: `card ${id}`,
    startedAt: 1000,
    queuedBy: 'Ann',
    queuedByUserId: 'ann',
    stage: 0,
  }
}

function seed(tasks: AgentTask[]) {
  actions.hydrateLogs({
    tasks: new Map([[CANVAS, tasks]]),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
}

const cardById = (id: string) => actions.getTasks(CANVAS).find((t) => t.id === id)!

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  mocks.pickModel.mockReset()
})

describe('stopping a card', () => {
  it('pauses a running card with who stopped it, and Retry starts it over', () => {
    seed([card('c1')])
    actions.takeQueuedCardsFor(CANVAS, AGENT)
    actions.stopCard(CANVAS, 'c1', 'Bob')
    expect(cardById('c1')).toMatchObject({ failureReason: 'Stopped by Bob.' })
    expect(cardById('c1').failedAt).toBeTypeOf('number')

    actions.retryCard(CANVAS, 'c1', 'Bob')
    expect(cardById('c1').failedAt).toBeUndefined()
    expect(cardById('c1').agentName).toBe('')
  })

  it('leaves a finished card alone', () => {
    seed([card('c1')])
    actions.completeCard(CANVAS, 'c1')
    actions.stopCard(CANVAS, 'c1', 'Bob')
    expect(cardById('c1').failedAt).toBeUndefined()
  })

  it('is never handed down the pipeline by the run that was working it', () => {
    seed([{ ...card('c1'), pipeline: [DEFAULT_ROLE_ID, DEFAULT_ROLE_ID] }])
    actions.takeQueuedCardsFor(CANVAS, AGENT)
    actions.stopCard(CANVAS, 'c1', 'Bob')
    actions.advanceCard(CANVAS, 'c1', { name: AGENT, kind: 'agent', color: '#000' })
    expect(cardById('c1')).toMatchObject({ stage: 0, failureReason: 'Stopped by Bob.' })
  })
})

describe('a run whose card is stopped', () => {
  it('aborts the model turn in flight and does not complete the card', async () => {
    seed([card('c1')])
    let signal: AbortSignal | undefined
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const run = vi.fn(
      (req: AgentTurnRequest) =>
        new Promise((_, reject) => {
          signal = req.signal
          req.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          started()
        }),
    )
    mocks.pickModel.mockResolvedValue({ provider: 'anthropic', label: 'Test', userId: 'ann', run })

    const resident = await import('../server/resident.ts')
    resident.onFeedback(CANVAS)
    await running
    expect(cardById('c1').agentName).toBe(AGENT)

    actions.stopCard(CANVAS, 'c1', 'Bob')
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    /* the run lets go: the agent's status clears, the card stays stopped */
    await vi.waitFor(() =>
      expect(actions.getTasks(CANVAS).some((t) => t.agentName === AGENT && !t.queuedBy && !t.endedAt)).toBe(false),
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(cardById('c1')).toMatchObject({ failureReason: 'Stopped by Bob.' })
    expect(cardById('c1').endedAt).toBeUndefined()
  })

  it('stays stopped when Retry lands before the stopped run has let go', async () => {
    seed([card('c1')])
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    let finishTool!: () => void
    const pendingTool = new Promise<void>((resolve) => (finishTool = resolve))
    /* the first run is a harness still waiting on a tool call when it is
       stopped; the retried card's run never returns */
    const runHarness = vi
      .fn()
      .mockImplementationOnce(async (req: { signal?: AbortSignal }) => {
        started()
        await new Promise((resolve) => req.signal?.addEventListener('abort', resolve))
        await pendingTool
        return { success: false, text: 'Task stopped.' }
      })
      .mockImplementation(() => new Promise(() => {}))
    mocks.pickModel.mockResolvedValue({
      provider: 'claude-local',
      label: 'Test',
      userId: 'ann',
      runHarness,
      run: vi.fn(),
    })

    const resident = await import('../server/resident.ts')
    resident.onFeedback(CANVAS)
    await running
    actions.stopCard(CANVAS, 'c1', 'Bob')
    await vi.waitFor(() => expect(runHarness.mock.calls[0]?.[0].signal.aborted).toBe(true))
    actions.retryCard(CANVAS, 'c1', 'Bob')
    finishTool()

    /* the retried card is picked up afresh instead of failed by the old run */
    await vi.waitFor(() => expect(runHarness).toHaveBeenCalledTimes(2))
    expect(cardById('c1').failedAt).toBeUndefined()
  })
})
