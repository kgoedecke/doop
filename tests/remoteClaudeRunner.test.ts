import { afterEach, expect, it, vi } from 'vitest'
import type { ClaudeEvent } from '../shared/remoteClaude.ts'
const mocks = vi.hoisted(() => ({ post: vi.fn(), events: vi.fn() }))
vi.mock('../server/remoteClaudeClient.ts', () => ({ remotePost: mocks.post, remoteEvents: mocks.events }))
import { runRemoteClaude } from '../server/remoteClaudeRunner.ts'
import { localAgentRuns } from '../server/localAgentRuns.ts'
afterEach(async () => {
  await localAgentRuns.cancel('alice')
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
it('creates a task-scoped MCP session and delivers complete large context without a desktop', async () => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://doop.example')
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
})
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
  expect(mocks.post).toHaveBeenLastCalledWith(
    'alice',
    '/v1/cancel',
    expect.objectContaining({ sessionId: 'session', messageId: expect.any(String) }),
  )
  expect(localAgentRuns.runningRemote('alice')).toBe(false)
})
