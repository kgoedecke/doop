import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * pickModel with several connections: unpicked work (a comment, an
 * automation) runs on the marked default, a switched-off account is never
 * used, and a card's pick chooses among the accounts that are on.
 */
const mocks = vi.hoisted(() => ({
  preference: vi.fn(),
  accounts: vi.fn(),
  online: vi.fn(),
  stored: vi.fn((): { provider: string }[] => []),
}))
vi.mock('../server/db/index.ts', () => ({
  db: { select: () => ({ from: () => ({ where: async () => mocks.stored() }) }) },
}))
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: mocks.preference }))
vi.mock('../server/modelAccounts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/modelAccounts.ts')>()),
  getAccounts: mocks.accounts,
}))
vi.mock('../server/localAgentRuns.ts', () => ({ localAgentRuns: { online: mocks.online, start: vi.fn() } }))
import { pickModel } from '../server/agentModel.ts'

afterEach(() => {
  vi.clearAllMocks()
  mocks.stored.mockReturnValue([])
})

const chatgpt = {
  kind: 'chatgpt',
  userId: 'alice',
  refreshToken: 'r',
  accessToken: 'a',
  model: 'gpt-5.6-terra',
  enabled: true,
  connectedAt: 1,
}
const claudeKey = {
  kind: 'anthropic-key',
  userId: 'alice',
  apiKey: 'k',
  model: 'claude-sonnet-5',
  enabled: true,
  connectedAt: 2,
}
const gemini = { kind: 'gemini-key', userId: 'alice', apiKey: 'AIza', enabled: false, connectedAt: 3 }

describe('work without a pick', () => {
  it('runs on the marked default, past a Plan that is on', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'opus' })
    mocks.online.mockReturnValue(true)
    mocks.accounts.mockResolvedValue([chatgpt, claudeKey])
    mocks.stored.mockReturnValue([{ provider: 'anthropic-key' }])
    expect((await pickModel('alice'))?.provider).toBe('anthropic-key')
  })
  it('runs on the Plan when it is the default', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'opus' })
    mocks.online.mockReturnValue(true)
    mocks.accounts.mockResolvedValue([chatgpt])
    mocks.stored.mockReturnValue([{ provider: 'claude-local' }])
    expect((await pickModel('alice'))?.provider).toBe('claude-local')
  })
  it('never runs on a switched-off default, and falls back', async () => {
    mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
    mocks.accounts.mockResolvedValue([gemini, chatgpt])
    mocks.stored.mockReturnValue([{ provider: 'gemini-key' }])
    expect((await pickModel('alice'))?.provider).toBe('chatgpt')
  })
})

describe('a card with a pick', () => {
  it('runs on the picked account with its model, though another is the default', async () => {
    mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
    mocks.accounts.mockResolvedValue([chatgpt, claudeKey])
    mocks.stored.mockReturnValue([{ provider: 'chatgpt' }])
    const model = await pickModel('alice', { provider: 'anthropic-key', model: 'claude-opus-5-5' })
    expect(model?.provider).toBe('anthropic-key')
    expect(model?.label).toContain('claude-opus-5-5')
  })
  it('does not run on a picked account that was switched off since', async () => {
    mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
    mocks.accounts.mockResolvedValue([chatgpt, gemini])
    const model = await pickModel('alice', { provider: 'gemini-key', model: 'gemini-3.7-flash' })
    expect(model?.provider).toBe('chatgpt')
    /* the pick's model belonged to Gemini, so ChatGPT runs its own */
    expect(model?.label).toContain('gpt-5.6-terra')
  })
})
