import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Token writes persist and broadcast like any canvas change; these tests
   only care about what the run counts as delivered, so both are stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveToken: () => {},
  deleteToken: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { deliveredWork, execTool, tokenWritesIn } = await import('../server/resident.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const actor = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
const run = () => ({
  mutatedFrames: new Set<string>(),
  sourceFrames: new Set<string>(),
  verificationFrames: new Set<string>(),
  verifiedFrames: new Set<string>(),
  rewriteDrafts: new Map<string, string>(),
  vision: false,
  imagesGenerated: 0,
  repliedThreads: new Set<string>(),
  awaitingThreads: new Set<string>(),
  tokenWrites: 0,
})
const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })

let canvasId: string

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('tokens', 'kevin').id
})

describe('a run that only writes tokens has delivered its card', () => {
  it('counts nothing before any write', () => {
    expect(deliveredWork(run())).toBe(false)
  })

  it('counts a token created through create_tokens', async () => {
    const runState = run()
    const result = await execTool(
      call('create_tokens', { tokens: [{ name: '--color-ink', type: 'color', value: '#111' }] }),
      canvasId,
      actor(),
      runState,
    )
    expect(result.is_error).toBeUndefined()
    expect(runState.tokenWrites).toBe(1)
    expect(deliveredWork(runState)).toBe(true)
  })

  it('does not count a set_tokens call whose every edit was refused', async () => {
    const runState = run()
    await execTool(call('set_tokens', { tokens: [{ name: '--missing', value: '#000' }] }), canvasId, actor(), runState)
    expect(runState.tokenWrites).toBe(0)
    expect(deliveredWork(runState)).toBe(false)
  })

  it('counts the theme list being set', async () => {
    const runState = run()
    await execTool(call('set_token_themes', { themes: ['dark'] }), canvasId, actor(), runState)
    expect(deliveredWork(runState)).toBe(true)
  })

  it('counts only the results that took', () => {
    expect(
      tokenWritesIn([
        { name: '--a', result: 'created' },
        { name: '--b', result: 'error', message: 'taken' },
        { name: '--c', result: 'deleted' },
      ]),
    ).toBe(2)
  })

  it('still counts a frame of the run’s own', () => {
    const runState = run()
    runState.mutatedFrames.add('f1')
    expect(deliveredWork(runState)).toBe(true)
    runState.sourceFrames.add('f1')
    expect(deliveredWork(runState)).toBe(false)
  })
})
