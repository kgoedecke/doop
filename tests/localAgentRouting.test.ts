import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
const mocks = vi.hoisted(() => ({ preference: vi.fn(), account: vi.fn(), online: vi.fn(), start: vi.fn() }))
/* no default marked: the fallback order decides */
vi.mock('../server/db/index.ts', () => ({ db: { select: () => ({ from: () => ({ where: async () => [] }) }) } }))
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: mocks.preference }))
vi.mock('../server/modelAccounts.ts', () => ({
  getAccount: mocks.account,
  /* the routing reads every account; a test connects one (or none) */
  getAccounts: async (userId: string) => {
    const account = (await mocks.account(userId)) as Record<string, unknown> | null | undefined
    return account ? [{ enabled: true, connectedAt: 1, ...account }] : []
  },
  withFreshToken: vi.fn(),
  accountModelFor: (account: { model?: string }) => account.model ?? 'default',
  /* the real one checks the id against the kind's menu (agentRunners.test.ts) */
  accountWithPick: (account: { kind: string }, pick?: { provider: string; model?: string }) =>
    pick && pick.provider === account.kind && pick.model ? { ...account, model: pick.model } : account,
}))
vi.mock('../server/localAgentRuns.ts', () => ({ localAgentRuns: { online: mocks.online, start: mocks.start } }))
import { pickModel } from '../server/agentModel.ts'

afterEach(() => {
  vi.clearAllMocks()
  unstubAllEnvs()
})
describe('local provider routing', () => {
  it('routes an explicitly configured pilot user through the cloud harness without touching paid API accounts', async () => {
    stubEnv(
      'DOOP_GEMINI_CLOUD_WORKERS',
      JSON.stringify({ alice: { url: 'https://worker.example', token: 'x'.repeat(32) } }),
    )
    const model = await pickModel('alice')
    expect(model).toMatchObject({ provider: 'gemini-cloud', userId: 'alice' })
    expect(model?.runHarness).toBeTypeOf('function')
    expect(mocks.preference).not.toHaveBeenCalled()
    expect(mocks.account).not.toHaveBeenCalled()
    await expect(model!.run({ system: [], messages: [], tools: [], maxTokens: 1 })).rejects.toThrow('canvas tasks only')
  })
  it('never falls back to the connected server account when Claude is offline', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'sonnet' })
    mocks.account.mockResolvedValue({ kind: 'chatgpt', userId: 'alice', connectedAt: 1 })
    mocks.online.mockReturnValue(false)
    expect(await pickModel('alice')).toBeNull()
  })
  it('chooses the complete local harness when connected', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'opus' })
    mocks.account.mockResolvedValue({ kind: 'chatgpt', userId: 'alice', connectedAt: 1 })
    mocks.online.mockReturnValue(true)
    const model = await pickModel('alice')
    expect(model?.provider).toBe('claude-local')
    expect(model?.runHarness).toBeTypeOf('function')
  })
  it('retains the existing account when local execution is deselected', async () => {
    mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
    mocks.account.mockResolvedValue({ kind: 'chatgpt', userId: 'alice', connectedAt: 1 })
    expect((await pickModel('alice'))?.provider).toBe('chatgpt')
    expect(mocks.account).toHaveBeenCalledWith('alice')
  })
})

/* The composer's pick, carried on the card: it chooses between the Plan and
   the model account, and the model on it, for that one run. */
describe('a card with a runner pick', () => {
  const harness = { canvasId: 'c', prompt: '', system: '', tools: [], maxTurns: 1, execute: vi.fn() }
  it('runs on the Plan with the picked alias and effort, leaving the preference alone', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'sonnet', effort: 'medium' })
    mocks.online.mockReturnValue(true)
    const model = await pickModel('alice', { provider: 'claude-local', model: 'opus', effort: 'max' })
    expect(model?.provider).toBe('claude-local')
    expect(model?.label).toBe('Claude CLI (opus, max effort)')
    void model?.runHarness?.(harness)
    expect(mocks.start).toHaveBeenCalledWith('alice', { model: 'opus', effort: 'max' }, harness)
  })
  it('keeps the preference model when the pick names one the Plan cannot run', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'sonnet' })
    mocks.online.mockReturnValue(true)
    const model = await pickModel('alice', { provider: 'claude-local', model: 'gpt-5.6-sol', effort: 'bogus' })
    expect(model?.label).toBe('Claude CLI (sonnet)')
  })
  it('steps past a connected Plan to the model account the pick names', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'opus' })
    mocks.online.mockReturnValue(true)
    mocks.account.mockResolvedValue({ kind: 'chatgpt', userId: 'alice', connectedAt: 1, model: 'gpt-5.6-terra' })
    const model = await pickModel('alice', { provider: 'chatgpt', model: 'gpt-5.6-sol' })
    expect(model?.provider).toBe('chatgpt')
    expect(model?.label).toContain('gpt-5.6-sol')
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('stays on the Plan when the pick names an account kind that is not connected', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'opus' })
    mocks.online.mockReturnValue(true)
    mocks.account.mockResolvedValue({ kind: 'chatgpt', userId: 'alice', connectedAt: 1 })
    const model = await pickModel('alice', { provider: 'anthropic-key', model: 'claude-opus-5-5' })
    expect(model?.provider).toBe('claude-local')
  })
  it('falls back to the account when the pick names a Plan that was disconnected', async () => {
    mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
    mocks.account.mockResolvedValue({ kind: 'chatgpt', userId: 'alice', connectedAt: 1 })
    const model = await pickModel('alice', { provider: 'claude-local', model: 'opus' })
    expect(model?.provider).toBe('chatgpt')
    expect(mocks.online).not.toHaveBeenCalled()
  })
})
