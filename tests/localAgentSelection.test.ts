import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ save: vi.fn(), status: vi.fn(), changed: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: { setLocalAgent: mocks.save, localAgent: mocks.status },
  ApiError: class extends Error {},
}))
vi.mock('../src/lib/store', () => ({ useStore: { getState: () => ({ allowanceChanged: mocks.changed }) } }))
import { selectLocalAgent, startLocalAgent, useLocalAgent } from '../src/lib/localAgent'
afterEach(() => {
  useLocalAgent.setState({ preference: null, native: null })
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

it('keeps a custom deployment ID in native storage and sends only a placeholder to the server', async () => {
  const model = 'arn:aws:bedrock:region:private-account:inference-profile/team'
  const native = { installed: true, connected: true, enabled: true, customProfile: true, model }
  const invoke = vi
    .fn()
    .mockImplementation(async (command: string) => (command === 'claude_status' ? native : undefined))
  vi.stubGlobal('__DOOP_CLAUDE_CLI__', true)
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  useLocalAgent.setState({ native })
  mocks.save.mockResolvedValue({ enabled: true, model: 'claude-sonnet-5' })
  mocks.status.mockResolvedValue({ enabled: true, model: 'claude-sonnet-5' })
  await selectLocalAgent('alice', { enabled: true, model })
  expect(invoke).toHaveBeenCalledWith('claude_set_model', { userId: 'alice', model })
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ enabled: true, model: 'default' })
  expect(useLocalAgent.getState().native?.model).toBe(model)
})
it('does not enable server routing if saving a local model fails', async () => {
  const invoke = vi.fn().mockImplementation(async (command: string) => {
    if (command === 'claude_set_model') throw new Error('Disk write failed')
  })
  vi.stubGlobal('__DOOP_CLAUDE_CLI__', true)
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  useLocalAgent.setState({ native: { installed: true, connected: true, enabled: true, customProfile: true } })
  await expect(selectLocalAgent('alice', { enabled: true, model: 'team/model' })).rejects.toThrow('Disk write failed')
  expect(mocks.save).not.toHaveBeenCalled()
})

it('loads browser routing state on startup and focus without invoking the local CLI', async () => {
  const invoke = vi.fn()
  vi.stubGlobal('__DOOP_CLAUDE_CLI__', false)
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  const browserWindow = new EventTarget()
  vi.stubGlobal('window', browserWindow)
  mocks.status.mockResolvedValue({ enabled: true, model: 'claude-sonnet-5' })
  const stop = startLocalAgent('alice')
  await vi.waitFor(() => expect(useLocalAgent.getState().preference?.enabled).toBe(true))
  expect(useLocalAgent.getState().native).toBeNull()
  mocks.status.mockResolvedValue({ enabled: false, model: 'claude-sonnet-5' })
  browserWindow.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(useLocalAgent.getState().preference?.enabled).toBe(false))
  expect(invoke).not.toHaveBeenCalled()
  stop()
  mocks.status.mockClear()
  browserWindow.dispatchEvent(new Event('focus'))
  expect(mocks.status).not.toHaveBeenCalled()
})
