import { afterEach, expect, it, vi } from 'vitest'
import { accountDescriber, serverDescriber } from '../server/agentModel.ts'
import type { ModelAccount } from '../server/modelAccounts.ts'

/**
 * The describer never runs on the model a person picked for design work: each
 * provider has a small vision tier (shared/modelMenu.ts DESCRIBER_MODELS), the
 * OpenAI kinds keep their model at low effort, and a text-only pick yields
 * nothing so the caller can fall through to the server tier.
 */

/* the server tier reads its key through env at call time; a getter lets
   vi.stubEnv decide per test */
vi.mock('../server/env.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/env.ts')>()
  return {
    ...original,
    env: {
      ...original.env,
      DOOP_AGENT_PROVIDER: 'anthropic',
      get ANTHROPIC_API_KEY() {
        return process.env.ANTHROPIC_API_KEY || undefined
      },
    },
  }
})

const account = (kind: ModelAccount['kind'], extra: Partial<ModelAccount> = {}): ModelAccount => ({
  userId: 'alice',
  kind,
  apiKey: 'sk-test',
  accessToken: 'tok',
  connectedAt: 0,
  ...extra,
})

afterEach(() => vi.unstubAllEnvs())

it('drops a Claude API account to Haiku', () => {
  expect(accountDescriber(account('anthropic-key', { model: 'claude-opus-5' }))).toMatchObject({
    provider: 'anthropic-key',
    userId: 'alice',
    label: 'Claude API (claude-haiku-4-5-20251001)',
  })
})

it('drops Gemini and OpenRouter accounts to the flash tier, with vision', () => {
  expect(accountDescriber(account('gemini-key', { model: 'gemini-3.1-pro-preview' }))).toMatchObject({
    label: 'Gemini (gemini-3.7-flash)',
    vision: true,
  })
  expect(accountDescriber(account('openrouter-key', { model: 'deepseek/deepseek-v4-pro' }))).toMatchObject({
    label: 'OpenRouter (google/gemini-3.7-flash)',
    vision: true,
  })
})

it('keeps a ChatGPT or OpenAI account on its own model at low effort', () => {
  expect(accountDescriber(account('chatgpt', { model: 'gpt-5.6-terra', effort: 'xhigh' }))).toMatchObject({
    label: 'ChatGPT (gpt-5.6-terra, low effort)',
  })
  expect(accountDescriber(account('openai-key', { effort: 'high' }))?.label).toMatch(/low effort\)$/)
})

it('is null for the server tier without a key, and Haiku on the Anthropic key', () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  expect(serverDescriber()).toBeNull()
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test')
  expect(serverDescriber()).toMatchObject({ provider: 'anthropic', label: 'Doop (claude-haiku-4-5-20251001)' })
})
