import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { ClaudeSessionEvent as ClaudeEvent } from '@cantelop/sdk/harnesses/claude/protocol'
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  dispatch: vi.fn(),
  session: vi.fn(),
  workspace: vi.fn(),
  events: vi.fn(),
  preference: vi.fn(),
  requireAuth: vi.fn(),
}))
vi.mock('../server/localAgentPreferences.ts', () => ({
  getLocalAgentPreference: mocks.preference,
  requireRemoteAuth: mocks.requireAuth,
}))
vi.mock('../server/remoteClaudeClient.ts', () => ({
  remoteWorkspace: mocks.workspace,
  remoteCall: (operation: (signal: AbortSignal) => Promise<unknown>) => operation(new AbortController().signal),
  remoteEvents: mocks.events,
}))
import { runRemoteClaude } from '../server/remoteClaudeRunner.ts'
import { localAgentRuns } from '../server/localAgentRuns.ts'
beforeEach(() => {
  mocks.preference.mockResolvedValue({ remoteAuthRequired: false, remoteAuthGeneration: 3 })
  mocks.workspace.mockReturnValue({ session: mocks.session })
  mocks.session.mockReturnValue({ id: 'remote-session', request: mocks.request, dispatch: mocks.dispatch })
  mocks.request.mockResolvedValue({ type: 'session.state', configured: true, messages: [], truncated: false })
  mocks.dispatch.mockResolvedValue({ id: 'receipt' })
})
afterEach(async () => {
  await localAgentRuns.cancel('alice')
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
it.each(['https://tools.example', 'http://host.docker.internal:4400'])(
  'creates a task-scoped MCP session using %s',
  async (mcpOrigin) => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('CANTELOP_EDGE_URL', mcpOrigin.startsWith('http:') ? 'http://127.0.0.1:8787' : 'https://claude.example')
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:4300')
    vi.stubEnv('CLAUDE_REMOTE_MCP_ORIGIN', mcpOrigin)
    const prompt = 'Task '.repeat(20000)
    const execute = vi.fn()
    let messageId = ''
    let token = ''
    mocks.request.mockImplementation(async (command: { type: string; config: Record<string, unknown> }) => {
      const body = command.config
      expect(body).toMatchObject({
        model: 'claude-sonnet-5',
        systemPrompt: 'Rules',
        maxTurns: 24,
        tools: [],
        allowedTools: ['mcp__doop__edit', 'mcp__doop__get_run_context'],
      })
      const mcp = (body.mcps as { doop: { url: string; headers: { Authorization: string } } }).doop
      expect(mcp.url.startsWith(`${mcpOrigin}/local-agent/mcp/`)).toBe(true)
      messageId = mcp.url.split('/').at(-1)!
      token = mcp.headers.Authorization.slice(7)
      expect(localAgentRuns.poll('alice', 'desktop')).toBeNull()
      const result = await localAgentRuns.execute(messageId, token, 'get_run_context', {})
      expect(result.content).toBe(prompt)
      return { type: 'session.state', configured: true, messages: [], truncated: false }
    })
    mocks.events.mockImplementation(
      async (
        _session: unknown,
        _signal: AbortSignal,
        event: (event: ClaudeEvent) => void,
        open: () => Promise<void>,
      ) => {
        await open()
        event({
          type: 'claude',
          id: messageId,
          event: { type: 'result', subtype: 'success', is_error: false, result: 'Done' },
        })
        event({ type: 'message.status', id: messageId, status: 'completed' })
      },
    )
    expect(
      await runRemoteClaude('alice', 'claude-sonnet-5', {
        canvasId: 'canvas',
        prompt,
        system: 'Rules',
        maxTurns: 24,
        tools: [{ name: 'edit', input_schema: { type: 'object' } }],
        execute,
      }),
    ).toEqual({ success: true, text: 'Done' })
    expect(localAgentRuns.authorized(messageId, token)).toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
    expect(mocks.workspace).toHaveBeenCalledWith('alice')
    expect(mocks.session).toHaveBeenCalledExactlyOnceWith({ keepAliveSeconds: 300 })
    expect(mocks.events.mock.calls[0]?.[0]).toBe(mocks.session.mock.results[0]?.value)
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'queue', id: messageId }),
      expect.objectContaining({ id: `msg_${messageId.replaceAll('-', '')}` }),
    )
  },
)
it('cancels the remote message and revokes access after a stream failure', async () => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://doop.example')
  mocks.events.mockRejectedValue(new Error('History lost'))
  const result = await runRemoteClaude('alice', 'default', {
    canvasId: 'canvas',
    prompt: 'Task',
    system: 'Rules',
    maxTurns: 2,
    tools: [],
    execute: vi.fn(),
  })
  expect(result).toEqual({ success: false, text: 'History lost' })
  expect(mocks.requireAuth).not.toHaveBeenCalled()
  expect(mocks.dispatch).toHaveBeenLastCalledWith(
    { type: 'cancel', id: expect.any(String) },
    { signal: expect.any(AbortSignal) },
  )
  expect(mocks.session).toHaveBeenCalledOnce()
  expect(mocks.events.mock.calls[0]?.[0]).toBe(mocks.session.mock.results[0]?.value)
  expect(localAgentRuns.runningRemote('alice')).toBe(false)
})

it('rejects localhost before creating a hosted session and explains the tunnel setting', async () => {
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:4300')
  vi.stubEnv('CLAUDE_REMOTE_MCP_ORIGIN', undefined)
  const result = await runRemoteClaude('alice', 'default', {
    canvasId: 'canvas',
    prompt: 'Task',
    system: 'Rules',
    maxTurns: 2,
    tools: [],
    execute: vi.fn(),
  })
  expect(result.success).toBe(false)
  expect(result.text).toContain('CLAUDE_REMOTE_MCP_ORIGIN')
  expect(mocks.session).not.toHaveBeenCalled()
})

it('persists an explicit auth failure for this user and stops dispatching while blocked', async () => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://doop.example')
  let id = ''
  mocks.dispatch.mockImplementation(async (command) => {
    if (command.type === 'queue') id = command.id
    return { id: 'receipt' }
  })
  mocks.events.mockImplementation(async (_session, _signal, event, open) => {
    await open()
    await event({ type: 'auth.required', id: 'unrelated' })
    expect(mocks.requireAuth).not.toHaveBeenCalled()
    await event({ type: 'auth.required', id })
    await event({ type: 'message.status', id, status: 'failed' })
  })
  const request = { canvasId: 'canvas', prompt: 'Task', system: 'Rules', maxTurns: 2, tools: [], execute: vi.fn() }
  expect(await runRemoteClaude('alice', 'default', request)).toMatchObject({ success: false, authRequired: true })
  expect(mocks.requireAuth).toHaveBeenCalledWith('alice', 3)
  mocks.session.mockClear()
  mocks.preference.mockResolvedValue({ remoteAuthRequired: true })
  expect(await runRemoteClaude('alice', 'default', request)).toMatchObject({ authRequired: true })
  expect(mocks.session).not.toHaveBeenCalled()
})
