import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
const mocks = vi.hoisted(() => ({
  preference: vi.fn(),
  accounts: vi.fn(),
  online: vi.fn(),
  stored: vi.fn((): { provider: string }[] => []),
}))
/* the stored default is the only row read straight from the database here */
vi.mock('../server/db/index.ts', () => ({
  db: { select: () => ({ from: () => ({ where: async () => mocks.stored() }) }) },
}))
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: mocks.preference }))
vi.mock('../server/modelAccounts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/modelAccounts.ts')>()),
  getAccounts: mocks.accounts,
}))
vi.mock('../server/localAgentRuns.ts', () => ({ localAgentRuns: { online: mocks.online, start: vi.fn() } }))
import { accountsView, listRunners } from '../server/agentRunners.ts'
import { accountWithPick, type ModelAccount } from '../server/modelAccounts.ts'
import { resolveDefault } from '../server/agentDefaults.ts'

afterEach(() => {
  vi.clearAllMocks()
  mocks.stored.mockReturnValue([])
  unstubAllEnvs()
})

const chatgpt: ModelAccount = {
  kind: 'chatgpt',
  userId: 'alice',
  email: 'alice@example.com',
  model: 'gpt-5.6-sol',
  effort: 'low',
  enabled: true,
  connectedAt: 1,
}
const claudeKey: ModelAccount = { kind: 'anthropic-key', userId: 'alice', apiKey: 'k', enabled: true, connectedAt: 2 }
const gemini: ModelAccount = { kind: 'gemini-key', userId: 'alice', apiKey: 'AIza', enabled: false, connectedAt: 3 }

describe('resolveDefault', () => {
  const plan = true
  it('takes the marked connection while it is connected and on', () => {
    expect(resolveDefault('anthropic-key', plan, [chatgpt, claudeKey])).toBe('anthropic-key')
    expect(resolveDefault('claude-local', plan, [chatgpt])).toBe('claude-local')
  })
  it('passes over a mark on a connection that is off or gone', () => {
    expect(resolveDefault('gemini-key', plan, [chatgpt, gemini])).toBe('claude-local')
    expect(resolveDefault('openrouter-key', false, [chatgpt, claudeKey])).toBe('chatgpt')
    expect(resolveDefault('claude-local', false, [claudeKey])).toBe('anthropic-key')
  })
  it('falls back to the Plan, then the account connected first that is on', () => {
    expect(resolveDefault(undefined, plan, [chatgpt])).toBe('claude-local')
    expect(resolveDefault(undefined, false, [gemini, claudeKey])).toBe('anthropic-key')
    expect(resolveDefault(undefined, false, [gemini])).toBeUndefined()
  })
})

describe('listRunners', () => {
  it('lists the Plan and every account that is on, leaving switched-off ones out', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'opus', effort: 'high' })
    mocks.online.mockReturnValue(false)
    mocks.accounts.mockResolvedValue([chatgpt, claudeKey, gemini])
    const listed = await listRunners('alice')
    expect(listed.default).toBe('claude-local')
    expect(listed.runners.map((r) => r.provider)).toEqual(['claude-local', 'chatgpt', 'anthropic-key'])
    const [plan, gpt, claude] = listed.runners
    expect(plan).toMatchObject({ name: 'Claude Plan', online: false, model: 'opus', effort: 'high' })
    expect(plan?.models.map((m) => m.id)).toContain('sonnet')
    expect(plan?.efforts?.map((e) => e.id)).toContain('max')
    expect(gpt).toMatchObject({ name: 'ChatGPT', email: 'alice@example.com', model: 'gpt-5.6-sol', effort: 'low' })
    expect(gpt?.efforts?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    /* a key kind has no reasoning dial */
    expect(claude).toMatchObject({ name: 'Claude API' })
    expect(claude?.efforts).toBeUndefined()
  })
  it('names the marked default even while the Plan is on', async () => {
    mocks.preference.mockResolvedValue({ enabled: true, model: 'opus' })
    mocks.accounts.mockResolvedValue([chatgpt, claudeKey])
    mocks.stored.mockReturnValue([{ provider: 'anthropic-key' }])
    expect((await listRunners('alice')).default).toBe('anthropic-key')
  })
  it('has nothing to offer with no connection, and names the operator pilot as the default', async () => {
    mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
    mocks.accounts.mockResolvedValue([])
    expect(await listRunners('alice')).toEqual({ runners: [] })
    stubEnv(
      'DOOP_GEMINI_CLOUD_WORKERS',
      JSON.stringify({ alice: { url: 'https://worker.example', token: 'x'.repeat(32) } }),
    )
    expect((await listRunners('alice')).default).toBe('gemini-cloud')
  })
})

describe('accountsView', () => {
  it('shows every account to Settings, switched off ones included, with the default and no secrets', async () => {
    mocks.preference.mockResolvedValue({ enabled: false, model: 'default' })
    mocks.accounts.mockResolvedValue([chatgpt, claudeKey, gemini])
    mocks.stored.mockReturnValue([{ provider: 'anthropic-key' }])
    const view = await accountsView('alice')
    expect(view.default).toBe('anthropic-key')
    expect(view.accounts.map((a) => [a.kind, a.enabled])).toEqual([
      ['chatgpt', true],
      ['anthropic-key', true],
      ['gemini-key', false],
    ])
    expect(JSON.stringify(view)).not.toContain('AIza')
  })
})

describe('accountWithPick', () => {
  const account: ModelAccount = {
    kind: 'chatgpt',
    userId: 'alice',
    model: 'gpt-5.6-terra',
    enabled: true,
    connectedAt: 1,
  }
  it('takes a model the kind knows and an effort where the kind has the dial', () => {
    expect(accountWithPick(account, { provider: 'chatgpt', model: 'gpt-5.6-sol', effort: 'xhigh' })).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    })
  })
  it('ignores an id shaped for another provider, an unknown effort, and another connection’s pick', () => {
    expect(accountWithPick(account, { provider: 'chatgpt', model: 'claude-opus-5-5', effort: 'max' })).toEqual(account)
    expect(accountWithPick(account, { provider: 'claude-local', model: 'opus' })).toBe(account)
    expect(accountWithPick(account, undefined)).toBe(account)
    const key: ModelAccount = { kind: 'anthropic-key', userId: 'alice', enabled: true, connectedAt: 1 }
    expect(accountWithPick(key, { provider: 'anthropic-key', model: 'claude-opus-5-5', effort: 'high' })).toEqual({
      ...key,
      model: 'claude-opus-5-5',
    })
  })
})
