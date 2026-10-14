import { afterEach, expect, it, vi } from 'vitest'

/**
 * pickModel routing for the wide-roster keys: the right transport, the right
 * label, and — the part the resident loop keys off — a truthful vision flag,
 * resolved from the curated menu rather than assumed.
 */

const mocks = vi.hoisted(() => ({ account: vi.fn() }))
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: async () => ({ enabled: false }) }))
vi.mock('../server/modelAccounts.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/modelAccounts.ts')>()
  return { ...original, getAccount: mocks.account }
})

import { pickModel } from '../server/agentModel'

const request = { system: [{ text: 'Design', cache: true }], tools: [], messages: [], maxTokens: 2048 }
afterEach(() => {
  vi.restoreAllMocks()
  mocks.account.mockReset()
})

it('routes an OpenRouter account through the Chat Completions transport with its label', async () => {
  mocks.account.mockResolvedValue({
    kind: 'openrouter-key',
    userId: 'alice',
    apiKey: 'sk-or-alice',
    model: 'moonshotai/kimi-k2.6',
  })
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }] }), { status: 200 }))
  const model = await pickModel('alice')
  expect(model).toMatchObject({
    provider: 'openrouter-key',
    userId: 'alice',
    vision: true,
    label: 'OpenRouter (moonshotai/kimi-k2.6)',
  })
  expect(await model!.run(request)).toMatchObject({ stop_reason: 'end_turn' })
  expect(String(fetchSpy.mock.calls[0]![0])).toContain('openrouter.ai')
})

it('marks a text-only roster pick as vision: false', async () => {
  mocks.account.mockResolvedValue({ kind: 'openrouter-key', userId: 'a', apiKey: 'sk-or-a', model: 'z-ai/glm-5.3' })
  expect(await pickModel('a')).toMatchObject({ vision: false, label: 'OpenRouter (z-ai/glm-5.3)' })
})

it('treats an off-menu OpenRouter override as text-only, the safe degraded default', async () => {
  mocks.account.mockResolvedValue({ kind: 'openrouter-key', userId: 'a', apiKey: 'sk-or-a', model: 'acme/mystery-1' })
  expect(await pickModel('a')).toMatchObject({ vision: false })
})

it('routes a Gemini account with its default model and vision intact', async () => {
  mocks.account.mockResolvedValue({ kind: 'gemini-key', userId: 'bob', apiKey: 'AIzaBobKeyLongEnough123456789012' })
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'Done' } }] }), { status: 200 }))
  const model = await pickModel('bob')
  expect(model).toMatchObject({ provider: 'gemini-key', vision: true, label: 'Gemini (gemini-3.7-flash)' })
  expect(await model!.run(request)).toMatchObject({ stop_reason: 'end_turn' })
  expect(String(fetchSpy.mock.calls[0]![0])).toContain('generativelanguage.googleapis.com')
})
