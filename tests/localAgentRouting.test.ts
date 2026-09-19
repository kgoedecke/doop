import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ preference: vi.fn(), account: vi.fn(), online: vi.fn() }))
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: mocks.preference }))
vi.mock('../server/modelAccounts.ts', () => ({
  getAccount: mocks.account,
  withFreshToken: vi.fn(),
  accountModelFor: (account: { model?: string }) => account.model ?? 'default',
}))
vi.mock('../server/localAgentRuns.ts', () => ({ localAgentRuns: { online: mocks.online, start: vi.fn() } }))
import { pickModel } from '../server/agentModel.ts'

afterEach(() => vi.clearAllMocks())
describe('local provider routing', () => {
  it('never falls back to the connected server account when Claude is offline', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'sonnet' })
    mocks.online.mockReturnValue(false)
    expect(await pickModel('alice')).toBeNull()
    expect(mocks.account).not.toHaveBeenCalled()
  })
  it('chooses the complete local harness when connected', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'opus' })
    mocks.online.mockReturnValue(true)
    const model = await pickModel('alice')
    expect(model?.provider).toBe('claude-local')
    expect(model?.runHarness).toBeTypeOf('function')
    expect(mocks.account).not.toHaveBeenCalled()
  })
  it('retains the existing account when local execution is deselected', async () => {
    mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
    mocks.account.mockResolvedValue({ kind: 'chatgpt', userId: 'alice', connectedAt: 1 })
    expect((await pickModel('alice'))?.provider).toBe('chatgpt')
    expect(mocks.account).toHaveBeenCalledWith('alice')
  })
})
