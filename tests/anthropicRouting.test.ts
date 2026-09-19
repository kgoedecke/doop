import { afterEach, expect, it, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
const mocks = vi.hoisted(() => ({ account: vi.fn(), stream: vi.fn(), key: vi.fn(), headers: vi.fn() }))
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: async () => ({ enabled: false }) }))
vi.mock('../server/modelAccounts.ts', () => ({
  getAccount: mocks.account,
  withFreshToken: vi.fn(),
  accountModelFor: (account: { model: string }) => account.model,
}))
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@anthropic-ai/sdk')>()
  return {
    ...original,
    default: class extends original.default {
      constructor(options: { apiKey: string; defaultHeaders?: Record<string, string> }) {
        super(options)
        mocks.key(options.apiKey)
        mocks.headers(options.defaultHeaders)
        this.messages.stream = mocks.stream
      }
    },
  }
})
import { pickModel, ModelAuthError, ModelConfigurationError } from '../server/agentModel'
const request = { system: [{ text: 'Design', cache: true }], tools: [], messages: [], maxTokens: 1024 }
afterEach(() => vi.clearAllMocks())

it('uses the payer key and selected Claude model on the server without a local harness', async () => {
  mocks.account.mockResolvedValue({
    kind: 'anthropic-key',
    userId: 'alice',
    apiKey: 'sk-ant-alice',
    model: 'claude-opus-5',
  })
  mocks.stream.mockReturnValue({
    finalMessage: async () => ({ content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' }),
  })
  const model = await pickModel('alice')
  expect(model).toMatchObject({ provider: 'anthropic-key', userId: 'alice' })
  expect(model?.runHarness).toBeUndefined()
  expect(mocks.key).toHaveBeenCalledWith('sk-ant-alice')
  expect(mocks.headers).toHaveBeenCalledWith(undefined)
  expect(await model!.run(request)).toMatchObject({ stop_reason: 'end_turn' })
  expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5', max_tokens: 1024 }))
})

it('reports invalid credentials as a reconnectable account error', async () => {
  mocks.account.mockResolvedValue({
    kind: 'anthropic-key',
    userId: 'alice',
    apiKey: 'sk-ant-invalid',
    model: 'claude-sonnet-5',
  })
  mocks.stream.mockImplementation(() => {
    throw new Anthropic.APIError(401, undefined, 'Unauthorized', new Headers())
  })
  const model = await pickModel('alice')
  await expect(model!.run(request)).rejects.toBeInstanceOf(ModelAuthError)
})

it.each([400, 404])('provides actionable workspace guidance for workspace errors (%s)', async (status) => {
  mocks.account.mockResolvedValue({
    kind: 'anthropic-key',
    userId: 'alice',
    apiKey: 'sk-ant-alice',
    model: 'claude-opus-5',
  })
  mocks.stream.mockImplementation(() => {
    throw new Anthropic.APIError(
      status,
      undefined,
      'anthropic-workspace-id is required or workspace not found',
      new Headers(),
    )
  })
  const model = await pickModel('alice')
  await expect(model!.run(request)).rejects.toBeInstanceOf(ModelConfigurationError)
  await expect(model!.run(request)).rejects.toThrow('Rotate key')
})
