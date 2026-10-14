vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: vi.fn(), requireRemoteAuth: vi.fn() }))
const sdkMocks = vi.hoisted(() => ({ app: undefined as unknown }))
vi.mock('../cantelop/.cantelop/client/client.mjs', () => ({
  get doopClaude() {
    return sdkMocks.app
  },
}))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CantelopClient } from '@cantelop/sdk'
import {
  remoteClaudeConfigured,
  remoteIdentity,
  checkRemoteAuth,
  remoteEvents,
  remoteWorkspace,
} from '../server/remoteClaudeClient.ts'
import { LocalAgentRuns, type LocalHarnessRequest } from '../server/localAgentRuns.ts'
import { RemoteResult } from '../server/remoteClaudeRunner.ts'
import type {
  ClaudeSessionCommand as Command,
  ClaudeSessionEvent as Event,
  ClaudeSessionReply as Reply,
} from '@cantelop/sdk/harnesses/claude/protocol'

const streamId = '1'.repeat(32)
const messageId = 'msg_' + '2'.repeat(32)
function configured() {
  vi.stubEnv('CANTELOP_APP_SLUG', 'doop-claude-runtime')
  vi.stubEnv('CANTELOP_EDGE_URL', 'https://claude.example')
  vi.stubEnv('CLAUDE_REMOTE_ISSUER', 'doop')
  vi.stubEnv('CANTELOP_INTEGRATION_TOKEN', 'integration-token')
  sdkMocks.app = new CantelopClient().app<Command, Event, Reply>({
    name: 'doop-claude-runtime',
    runtime: { receive() {} },
    auth: {
      status: () => true,
      logout() {},
      terminal() {
        throw new Error('native-only')
      },
    },
    edgeUrl: 'https://claude.example',
    accessToken: 'integration-token',
  })
}
beforeEach(configured)
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const sessionId = () => 'ses_test'
const session = () => remoteWorkspace('alice').session({ id: sessionId(), keepAliveSeconds: 300 })
function sse(frames: Event[], start = 1) {
  return new Response(
    frames
      .map((data, index) => {
        const sequence = start + index
        return `id: ${streamId}:${sequence}\ndata: ${JSON.stringify({ stream_id: streamId, sequence, session_id: sessionId(), message_id: messageId, created_at: new Date().toISOString(), data })}\n\n`
      })
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}
it('retains the old issuer-derived Workspace namespace and isolates users', () => {
  expect(remoteIdentity('alice')).toBe('eadef8c2ff8c6942fb7075e7d8317304e56a1815d3172722')
  expect(remoteIdentity('alice')).not.toBe(remoteIdentity('bob'))
  vi.stubEnv('CANTELOP_EDGE_URL', 'https://example.com/other')
  expect(remoteIdentity('alice')).toBe('eadef8c2ff8c6942fb7075e7d8317304e56a1815d3172722')
})
it('requires the native SDK configuration and allows its default hosted Edge origin', () => {
  expect(remoteClaudeConfigured()).toBe(true)
  vi.stubEnv('CANTELOP_APP_SLUG', undefined)
  expect(remoteClaudeConfigured()).toBe(false)
  vi.stubEnv('CANTELOP_APP_SLUG', 'doop-claude-runtime')
  vi.stubEnv('CANTELOP_EDGE_URL', undefined)
  expect(remoteClaudeConfigured()).toBe(true)
  expect(remoteIdentity('alice')).toBe('eadef8c2ff8c6942fb7075e7d8317304e56a1815d3172722')
})
it.each([true, false])('validates native auth status %s through real SDK requests', async (authenticated) => {
  const fetcher = vi.fn(async (request: Request) => {
    const body = await request.json()
    expect(body.command.auth).toEqual({ type: 'status' })
    expect(request.headers.get('Authorization')).toBe('Bearer integration-token')
    return Response.json({ protocolVersion: 2, id: body.id, reply: { type: 'status', authenticated } })
  })
  vi.stubGlobal('fetch', fetcher)
  expect(await checkRemoteAuth('alice')).toBe(authenticated)
  expect(fetcher).toHaveBeenCalledOnce()
})
it.each([{ type: 'status', authenticated: 'false' }, { type: 'status' }, { type: 'error', authenticated: false }])(
  'does not treat malformed native auth replies as sign-out',
  async (reply) => {
    vi.stubGlobal('fetch', async (request: Request) => {
      const body = await request.json()
      return Response.json({ protocolVersion: 2, id: body.id, reply })
    })
    await expect(checkRemoteAuth('alice')).rejects.toThrow('request failed')
  },
)
it('does not leak upstream response bodies or interpret timeouts as sign-out', async () => {
  vi.stubGlobal('fetch', async () =>
    Response.json({ error: { code: 'request_wait_timeout' }, secret: 'hidden' }, { status: 504 }),
  )
  await expect(checkRemoteAuth('alice')).rejects.toThrow('does not mean you are signed out')
})
it('creates lazy SDK sessions scoped to each user Workspace', () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const alice = remoteWorkspace('alice').session({ keepAliveSeconds: 300 })
  const bob = remoteWorkspace('bob').session({ keepAliveSeconds: 300 })
  expect(alice.workspace).toEqual({ slug: `u-${remoteIdentity('alice')}` })
  expect(bob.workspace).toEqual({ slug: `u-${remoteIdentity('bob')}` })
  expect(alice.workspace).not.toEqual(bob.workspace)
  expect(alice.id).not.toBe(bob.id)
  expect(fetcher).not.toHaveBeenCalled()
})
it('fails on stream reset without replaying a dispatched task', async () => {
  const opened = vi.fn(async () => {})
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response('event: error\ndata: {"code":"event_cursor_expired"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  )
  await expect(remoteEvents(session(), new AbortController().signal, () => {}, opened)).rejects.toThrow(
    'lost its event history',
  )
  expect(opened).toHaveBeenCalledOnce()
})

const harness: LocalHarnessRequest = {
  canvasId: 'canvas',
  prompt: 'Task',
  system: 'Rules',
  maxTurns: 2,
  tools: [{ name: 'edit', input_schema: { type: 'object' } }],
  execute: async (block) => ({ type: 'tool_result', tool_use_id: block.id, content: 'ok' }),
}
it('desktop polling cannot claim or finish a hosted run; cancellation revokes its MCP token', async () => {
  const runs = new LocalAgentRuns()
  let captured: { id: string; token: string } | undefined
  let signal: AbortSignal | undefined
  const result = runs.start('alice', 'default', harness, async (job, abort) => {
    captured = job
    signal = abort
    await new Promise<void>((resolve) => abort.addEventListener('abort', () => resolve(), { once: true }))
    return { success: false, text: 'stopped' }
  })
  await Promise.resolve()
  expect(captured).toBeDefined()
  expect(runs.poll('alice', 'desktop')).toBeNull()
  expect(runs.runningRemote('alice')).toBe(true)
  expect(runs.authorized(captured!.id, captured!.token)).toBeDefined()
  expect(await runs.finish(captured!.id, 'alice', 'desktop', { success: true, text: 'spoof' })).toBe(false)
  await runs.expire(Date.now() + 60_000)
  expect(runs.runningRemote('alice')).toBe(true)
  await runs.cancel('alice')
  expect(signal!.aborted).toBe(true)
  expect(runs.authorized(captured!.id, captured!.token)).toBeUndefined()
  expect((await result).success).toBe(false)
})
it('reassembles bounded results and rejects bad fragments without mixing messages', () => {
  const result = new RemoteResult('run')
  result.accept({
    type: 'claude',
    id: 'other',
    event: { type: 'result', is_error: false, subtype: 'success', result: 'Wrong' },
  })
  expect(result.result).toBeUndefined()
  const json = JSON.stringify({ type: 'result', is_error: false, subtype: 'success', result: 'Done 😀' })
  result.accept({ type: 'claude.fragment', id: 'run', eventId: 'e', total: 2, index: 1, json: json.slice(20) })
  result.accept({ type: 'claude.fragment', id: 'run', eventId: 'e', total: 2, index: 0, json: json.slice(0, 20) })
  expect(result.result).toEqual({ success: true, text: 'Done 😀' })
  expect(() =>
    result.accept({ type: 'claude.fragment', id: 'run', eventId: 'bad', total: 100000, index: 0, json: '' }),
  ).toThrow('Invalid')
})

it.each([429, 503])('resumes SDK stream cursors after transient HTTP %s without redispatch', async (status) => {
  const controller = new AbortController()
  const opened = vi.fn(async () => {})
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(sse([{ type: 'session.ready', sessionId: sessionId() }]))
    .mockResolvedValueOnce(new Response(null, { status }))
    .mockResolvedValueOnce(sse([{ type: 'message.status', id: 'run', status: 'completed' }], 2))
  vi.stubGlobal('fetch', fetcher)
  await remoteEvents(
    session(),
    controller.signal,
    (event) => {
      if (event.type === 'message.status') controller.abort()
    },
    opened,
  )
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(opened).toHaveBeenCalledOnce()
  const request = fetcher.mock.calls[2]?.[0] as Request
  expect((await request.json()).command.after).toEqual({ streamId, sequence: 1 })
})

it('closes a pending SDK subscription when initial dispatch fails, without retrying it', async () => {
  let aborted = false
  vi.stubGlobal(
    'fetch',
    (request: Request) =>
      new Promise<Response>((_resolve, reject) => {
        const stop = () => {
          aborted = true
          reject(request.signal.reason)
        }
        request.signal.addEventListener('abort', stop, { once: true })
        if (request.signal.aborted) stop()
      }),
  )
  const dispatch = vi.fn(async () => {
    throw new Error('Dispatch failed')
  })
  await expect(remoteEvents(session(), new AbortController().signal, () => {}, dispatch)).rejects.toThrow(
    'Dispatch failed',
  )
  expect(dispatch).toHaveBeenCalledOnce()
  expect(aborted).toBe(true)
})
