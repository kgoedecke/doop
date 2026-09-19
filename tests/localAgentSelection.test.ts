import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ save: vi.fn(), status: vi.fn(), changed: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: { setLocalAgent: mocks.save, localAgent: mocks.status },
  ApiError: class extends Error {},
}))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => ({ allowanceChanged: mocks.changed }) } }))
import { selectLocalAgent, useLocalAgent } from '../src/lib/localAgent'
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
it('selects the server without depending on native CLI status', async () => {
  const invoke = vi.fn().mockRejectedValue(new Error('CLI unavailable'))
  vi.stubGlobal('__DOOP_CLAUDE_CLI__', true)
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  useLocalAgent.setState({ preference: { enabled: true, model: 'claude-opus-5' } })
  const saved = { enabled: false, model: 'claude-opus-5' } as const
  mocks.save.mockResolvedValue(saved)
  await selectLocalAgent('alice', saved)
  expect(useLocalAgent.getState().preference).toEqual(saved)
  expect(invoke).not.toHaveBeenCalled()
  expect(mocks.status).not.toHaveBeenCalled()
  expect(mocks.changed).toHaveBeenCalledOnce()
})
it('preserves local routing state when the server rejects the switch', async () => {
  const previous = { enabled: true, model: 'claude-opus-5' } as const
  useLocalAgent.setState({ preference: previous })
  mocks.save.mockRejectedValue(new Error('Network failure'))
  await expect(selectLocalAgent('alice', { ...previous, enabled: false })).rejects.toThrow('Network failure')
  expect(useLocalAgent.getState().preference).toEqual(previous)
  expect(mocks.changed).not.toHaveBeenCalled()
})
