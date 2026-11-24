import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { AgentTask } from '../shared/types.ts'
import type { LocalAgentResult } from '../shared/localAgent.ts'
import { crashReason, failureDetail } from '../server/runFailure.ts'
import { shellResult } from '../server/localAgentRuns.ts'

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

const CANVAS = 'canvas-run-failure'

describe('failureDetail', () => {
  it('keeps a plain message as it is', () => {
    expect(failureDetail('Claude AI usage limit reached. Your limit resets at 5pm.')).toBe(
      'Claude AI usage limit reached. Your limit resets at 5pm.',
    )
  })

  it('reads the message out of an Anthropic error body, dropping the bare status', () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."},"request_id":"req_1"}'
    expect(failureDetail(raw)).toBe('Your credit balance is too low to access the Anthropic API.')
  })

  it('keeps the words before a provider body', () => {
    const raw =
      'ChatGPT rate-limited this account (429). {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"free"}}'
    expect(failureDetail(raw)).toBe('ChatGPT rate-limited this account (429). The usage limit has been reached')
  })

  it('reads an array body and unescapes the message', () => {
    const raw =
      'Gemini request failed (503). [{\n  "error": {\n    "message": "The model is \\"overloaded\\"."\n  }\n}]'
    expect(failureDetail(raw)).toBe('Gemini request failed (503). The model is "overloaded".')
  })

  it('looks past a bracket in plain text for the body', () => {
    expect(failureDetail('Request failed [retry 2/3]: {"error":{"message":"Upstream timed out"}}')).toBe(
      'Request failed [retry 2/3]: Upstream timed out',
    )
  })

  it('keeps text whose brackets hold no JSON body', () => {
    expect(failureDetail('Request failed [retry 2/3] while "message":"y"')).toBe(
      'Request failed [retry 2/3] while "message":"y"',
    )
  })

  it('caps a long message and collapses whitespace', () => {
    const detail = failureDetail(`a\n\n${'b'.repeat(1000)}`)
    expect(detail.startsWith('a b')).toBe(true)
    expect(detail.length).toBe(400)
    expect(detail.endsWith('…')).toBe(true)
  })
})

describe('crashReason', () => {
  it('falls back to the generic line without a detail', () => {
    expect(crashReason('Doop', 'Claude CLI', undefined)).toBe(
      'Doop hit a snag before finishing. Retry when you are ready.',
    )
    expect(crashReason('Doop', 'Claude CLI', '  ')).toBe('Doop hit a snag before finishing. Retry when you are ready.')
  })

  it('quotes the connection', () => {
    expect(crashReason('Doop', 'Claude CLI (sonnet)', 'Not logged in')).toBe(
      'Doop could not finish. Claude CLI (sonnet) said: “Not logged in” Retry when you are ready.',
    )
  })
})

describe('a harness run that does not succeed', () => {
  beforeEach(() => {
    actions.wire(
      () => {},
      () => {},
    )
    mocks.pickModel.mockReset()
  })

  /** one card through one desktop run answering `result`; the card once it fails */
  /** a desktop Claude connection whose run answers `result` */
  function harness(result: LocalAgentResult) {
    return {
      provider: 'claude-local',
      label: 'Claude CLI (sonnet)',
      userId: 'ann',
      runHarness: vi.fn().mockResolvedValue(result),
      run: vi.fn(),
    }
  }

  /** an API connection whose turn does `run` */
  function api(run: () => Promise<unknown>, userId: string) {
    return { provider: 'anthropic-key', label: 'Claude (sonnet)', userId, run: vi.fn(run) }
  }

  async function runCard(id: string, model: Record<string, unknown>) {
    const card: AgentTask = {
      id,
      agentName: '',
      color: '#000',
      status: 'make a grayscale variant',
      startedAt: 1000,
      queuedBy: 'Ann',
      queuedByUserId: 'ann',
      stage: 0,
    }
    actions.hydrateLogs({
      tasks: new Map([[CANVAS, [card]]]),
      feedback: new Map(),
      comments: new Map(),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    mocks.pickModel.mockResolvedValue(model)
    const resident = await import('../server/resident.ts')
    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(actions.getTasks(CANVAS).find((t) => t.id === id)?.failedAt).toBeDefined())
    return { card: actions.getTasks(CANVAS).find((t) => t.id === id)!, runHarness: model.runHarness as Mock }
  }

  it('puts what the desktop CLI said on the card', async () => {
    const { card, runHarness } = await runCard(
      'c1',
      harness({ success: false, text: 'Claude AI usage limit reached|1795500000' }),
    )
    expect(card.failureReason).toBe(
      'Doop could not finish. Claude CLI (sonnet) said: “Claude AI usage limit reached|1795500000” Retry when you are ready.',
    )
    /* the harness gets its own, wider turn limit */
    expect(runHarness.mock.calls[0]?.[0].maxTurns).toBe(200)
  })

  it('takes a run stopped at its turn limit as the step limit, not a crash', async () => {
    const { card } = await runCard(
      'c2',
      harness({ success: false, text: 'Reached maximum number of turns (200)', limitReached: true }),
    )
    expect(card.failureReason).toMatch(/hit its limit before the work was done/)
  })

  it("shows the relay's own words as they are", async () => {
    const text = 'Desktop disconnected or local run timed out. Retry the task.'
    const { card } = await runCard('c3', harness({ success: false, text, fromDoop: true }))
    expect(card.failureReason).toBe(text)
  })

  it("quotes the person's own provider", async () => {
    const { card } = await runCard(
      'c4',
      api(
        () =>
          Promise.reject(
            new Error(
              '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
            ),
          ),
        'ann',
      ),
    )
    expect(card.failureReason).toBe(
      'Doop could not finish. Claude (sonnet) said: “Your credit balance is too low to access the Anthropic API.” Retry when you are ready.',
    )
  })

  it("never quotes an error of ours as the provider's", async () => {
    /* a turn answering nothing breaks the loop itself, not the model call */
    const { card } = await runCard(
      'c6',
      api(() => Promise.resolve(undefined), 'ann'),
    )
    expect(card.failureReason).toBe('Doop hit a snag before finishing. Retry when you are ready.')
  })
})

describe('shellResult', () => {
  it("reads an older shell's fallback text as the turn limit", () => {
    expect(
      shellResult({
        success: false,
        text: 'Claude did not complete the task. Check your login and usage limits, then retry.',
      }),
    ).toMatchObject({ limitReached: true })
  })

  it('leaves an error with its own words alone', () => {
    expect(shellResult({ success: false, text: 'Not logged in · Please run /login' })).toEqual({
      success: false,
      text: 'Not logged in · Please run /login',
    })
  })

  it('believes a shell that says it was not the turn limit', () => {
    const result = {
      success: false,
      text: 'Claude did not complete the task. Check your login and usage limits, then retry.',
      limitReached: false,
    }
    expect(shellResult(result)).toEqual(result)
  })
})
