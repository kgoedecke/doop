import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { ClaudeEvent } from '../shared/remoteClaude.ts'
const mocks = vi.hoisted(() => ({ post: vi.fn(), events: vi.fn(), preference: vi.fn(), requireAuth: vi.fn() }))
vi.mock('../server/localAgentPreferences.ts', () => ({
  getLocalAgentPreference: mocks.preference,
  requireRemoteAuth: mocks.requireAuth,
}))
vi.mock('../server/remoteClaudeClient.ts', () => ({ remotePost: mocks.post, remoteEvents: mocks.events }))
import { runRemoteClaude } from '../server/remoteClaudeRunner.ts'
import { localAgentRuns } from '../server/localAgentRuns.ts'
beforeEach(() => {
  mocks.preference.mockResolvedValue({ remoteAuthRequired: false, remoteAuthGeneration: 3 })
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
    vi.stubEnv('CLAUDE_REMOTE_URL', mcpOrigin.startsWith('http:') ? 'http://127.0.0.1:8787' : 'https://claude.example')
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:4300')
    vi.stubEnv('CLAUDE_REMOTE_MCP_ORIGIN', mcpOrigin)
    const prompt = 'Task '.repeat(20000)
    const execute = vi.fn()
    let messageId = ''
    let token = ''
    mocks.post.mockImplementation(async (user: string, path: string, body: Record<string, unknown>) => {
      expect(user).toBe('alice')
      if (path === '/v1/sessions') {
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
      }
      if (path === '/v1/messages') expect(body).toMatchObject({ sessionId: 'remote-session', messageId, mode: 'queue' })
      return { sessionId: 'remote-session', receiptId: 'receipt' }
    })
    mocks.events.mockImplementation(
      async (
        _user: string,
        _session: string,
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
    expect(mocks.post.mock.calls.map((call) => call[1])).toEqual(['/v1/sessions', '/v1/messages'])
  },
)
it('cancels the remote message and revokes access after a stream failure', async () => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://doop.example')
  mocks.post.mockResolvedValue({ sessionId: 'session', receiptId: 'receipt' })
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
  expect(mocks.post).toHaveBeenLastCalledWith(
    'alice',
    '/v1/cancel',
    expect.objectContaining({ sessionId: 'session', messageId: expect.any(String) }),
  )
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
  expect(mocks.post).not.toHaveBeenCalled()
})

it('persists an explicit auth failure for this user and stops dispatching while blocked', async () => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://doop.example')
  let id = ''
  mocks.post.mockImplementation(async (_user, path, body) => {
    if (path === '/v1/messages') id = body.messageId
    return { sessionId: 'session', receiptId: 'receipt' }
  })
  mocks.events.mockImplementation(async (_user, _session, _signal, event, open) => {
    await open()
    await event({ type: 'auth.required', id: 'unrelated' })
    expect(mocks.requireAuth).not.toHaveBeenCalled()
    await event({ type: 'auth.required', id })
    await event({ type: 'message.status', id, status: 'failed' })
  })
  const request = { canvasId: 'canvas', prompt: 'Task', system: 'Rules', maxTurns: 2, tools: [], execute: vi.fn() }
  expect(await runRemoteClaude('alice', 'default', request)).toMatchObject({ success: false, authRequired: true })
  expect(mocks.requireAuth).toHaveBeenCalledWith('alice', 3)
  mocks.post.mockClear()
  mocks.preference.mockResolvedValue({ remoteAuthRequired: true })
  expect(await runRemoteClaude('alice', 'default', request)).toMatchObject({ authRequired: true })
  expect(mocks.post).not.toHaveBeenCalled()
})
