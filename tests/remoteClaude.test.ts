vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: vi.fn(), requireRemoteAuth: vi.fn() }))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, verify } from 'node:crypto'
import {
  remoteBearer,
  remoteIdentity,
  checkRemoteAuth,
  checkRemoteLogin,
  remoteEvents,
  remotePost,
} from '../server/remoteClaudeClient.ts'
import { consumeClaudeEvents } from '../shared/remoteClaude.ts'
import { LocalAgentRuns, type LocalHarnessRequest } from '../server/localAgentRuns.ts'
import { RemoteResult } from '../server/remoteClaudeRunner.ts'

const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
function configured() {
  vi.stubEnv('CLAUDE_REMOTE_URL', 'https://claude.example')
  vi.stubEnv('CLAUDE_REMOTE_ISSUER', 'doop')
  vi.stubEnv('CLAUDE_REMOTE_AUDIENCE', 'claude-api')
  vi.stubEnv('CLAUDE_REMOTE_SIGNING_KEY', pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
function sse(frames: unknown[]) {
  return new Response(
    frames.map((event, index) => `id: stream:${index + 1}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

describe('hosted application identity and stream', () => {
  it('signs short-lived per-user ES256 JWTs and separates workspaces', () => {
    configured()
    const [header, payload, signature] = remoteBearer('alice').split('.') as [string, string, string]
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: pair.publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(claims).toMatchObject({ sub: 'alice', iss: 'doop', aud: 'claude-api' })
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300)
    expect(remoteIdentity('alice')).not.toBe(remoteIdentity('bob'))
    vi.stubEnv('CLAUDE_REMOTE_URL', 'https://example.com/other')
    expect(() => remoteBearer('alice')).toThrow('HTTPS origin')
  })
  it.each([true, false])('reads auth status %s directly without opening an event stream', async (authenticated) => {
    configured()
    const fetcher = vi.fn(async (_url: string | URL | Request) =>
      Response.json({
        sessionId: `${remoteIdentity('alice')}:auth`,
        type: 'auth.status',
        authenticated,
      }),
    )
    vi.stubGlobal('fetch', fetcher)
    expect(await checkRemoteAuth('alice')).toBe(authenticated)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://claude.example/v1/auth')
  })
  it.each([
    { type: 'auth.status', authenticated: 'false' },
    { type: 'auth.status' },
    { type: 'error', authenticated: false },
    { type: 'auth.status', authenticated: true, sessionId: 'bob:auth' },
    { receiptId: 'old-api-receipt' },
  ])('rejects malformed, foreign, or legacy auth replies instead of reporting sign-out', async (reply) => {
    configured()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ sessionId: `${remoteIdentity('alice')}:auth`, ...reply })),
    )
    await expect(checkRemoteAuth('alice')).rejects.toThrow('invalid authentication status')
  })
  it('allows overhead beyond the API request wait and reports timeouts without leaking bodies', async () => {
    configured()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('sensitive upstream detail', { status: 504 })),
    )
    await expect(checkRemoteAuth('alice')).rejects.toThrow('does not mean you are signed out')
    expect(timeout).toHaveBeenCalledWith(45_000)
  })
  it('fails on reset without replaying a dispatched task', async () => {
    configured()
    const open = vi.fn(async () => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([{ type: 'event_cursor_expired' }])),
    )
    await expect(remoteEvents('alice', 'session', new AbortController().signal, () => {}, open)).rejects.toThrow(
      'lost its event history',
    )
    expect(open).toHaveBeenCalledOnce()
  })
  it('bounds request bodies before sending and hides upstream secrets in errors', async () => {
    configured()
    const fetcher = vi.fn(async () => new Response('Bearer secret', { status: 400 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(remotePost('alice', '/v1/sessions', { systemPrompt: 'x'.repeat(50_000) })).rejects.toThrow('48 KiB')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(remotePost('alice', '/v1/sessions', {})).rejects.toThrow('request failed (400)')
  })
  it('decodes split UTF-8 SSE frames and advances cursors after processing', async () => {
    const bytes = new TextEncoder().encode(
      'id: a:1\r\ndata: {"type":"claude","id":"run","event":{"text":"😀"}}\r\n\r\n',
    )
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
          controller.close()
        },
      }),
    )
    const events: unknown[] = []
    await consumeClaudeEvents(
      response,
      (event) => {
        events.push(event)
      },
      (cursor) => {
        events.push(cursor)
      },
    )
    expect(events).toEqual([{ type: 'claude', id: 'run', event: { text: '😀' } }, 'a:1'])
  })
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

it('verifies native login completion for the requested attempt only', async () => {
  configured()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      sse([
        { data: { type: 'auth.finished', attemptId: 'old', authenticated: true, outcome: 'succeeded' } },
        { data: { type: 'auth.finished', attemptId: 'new', authenticated: true, outcome: 'cancelled' } },
      ]),
    ),
  )
  expect(await checkRemoteLogin('alice', 'new')).toBe(false)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      sse([{ data: { type: 'auth.finished', attemptId: 'new', authenticated: true, outcome: 'succeeded' } }]),
    ),
  )
  expect(await checkRemoteLogin('alice', 'new')).toBe(true)
})
