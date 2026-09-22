import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import api from '../src/api.js'
import { RemoteAppError, type CantelopApp } from '@cantelop/sdk/api'
import type { Command, Reply } from '../src/contracts.js'
const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const env = {
  AUTH_PUBLIC_JWK: JSON.stringify(pair.publicKey.export({ format: 'jwk' })),
  AUTH_ISSUER: 'test',
  AUTH_AUDIENCE: 'api',
}
function token(sub = 'alice', extra = {}, key = pair.privateKey) {
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const input = `${encode({ alg: 'ES256' })}.${encode({ sub, iss: 'test', aud: 'api', exp: Math.floor(Date.now() / 1000) + 300, ...extra })}`
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}
function fixture(requestError?: Error) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
  const opened: any[] = [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
    workspaces: any[] = [],
    dispatched: Command[] = []
  const requested: Command[] = [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
    requestOptions: any[] = []
  const app = {
    workspaces: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
      open: async (input: any) => {
        workspaces.push(input)
        return { id: 'ws-1', slug: input.slug }
      },
    },
    sessions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial SDK/DOM fixtures exercise runtime boundaries without implementing the platform.
      open: (input: any) => {
        opened.push(input)
        return {
          ...input,
          dispatch: async (command: Command) => {
            dispatched.push(command)
            return { id: 'receipt' }
          },
          request: async (command: Command, options: unknown) => {
            requested.push(command)
            requestOptions.push(options)
            if (requestError) throw requestError
            return command.type === 'auth.logout'
              ? { type: 'auth.status', authenticated: false }
              : command.type === 'auth.check'
                ? { type: 'auth.status', authenticated: true }
                : { type: 'session.state', configured: true, messages: [], truncated: false }
          },
          events: async (request: Request) =>
            new Response(request.headers.get('Last-Event-ID'), { headers: { 'content-type': 'text/event-stream' } }),
        }
      },
    },
  } as unknown as CantelopApp<Command, Reply>
  const router = api.create({ app, env })
  const request = async (path: string, body?: unknown, auth = token(), headers = {}) =>
    router.handle(
      new Request(`https://app.example${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${auth}`, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { request, opened, workspaces, dispatched, requested, requestOptions }
}
test('SDK allocates server-selected user Workspace and native-auth Session; repeat provisioning is stable', async () => {
  const f = fixture()
  const first = await f.request('/v1/auth', {})
  assert.equal(first.status, 200)
  const a = await first.json()
  assert.match(a.workspaceSlug, /^u-[a-f0-9]{48}$/)
  assert.equal(a.sessionId, `${a.workspaceSlug.slice(2)}:auth`)
  assert.deepEqual(f.requested, [{ type: 'auth.check' }])
  assert.equal(a.authenticated, true)
  assert.equal(a.receiptId, undefined)
  assert.equal(first.headers.get('cache-control'), 'no-store')
  assert.equal((await (await f.request('/v1/auth', {})).json()).sessionId, a.sessionId)
  assert.notEqual((await (await f.request('/v1/auth', {}, token('bob'))).json()).workspaceSlug, a.workspaceSlug)
})
test('reject invalid identity, expired JWT, wrong audience and forged signatures before provisioning', async () => {
  const f = fixture()
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  for (const value of [
    'bad',
    token('alice', { exp: 1 }),
    token('alice', { aud: 'wrong' }),
    token('alice', {}, other.privateKey),
  ])
    assert.equal((await f.request('/v1/auth', {}, value)).status, 401)
  assert.equal(f.workspaces.length, 0)
})
test('tenant ownership checked before Session dispatch and event streaming', async () => {
  const f = fixture()
  const created = await (await f.request('/v1/sessions', { tools: ['Read'] })).json()
  const count = f.opened.length
  assert.equal(
    (await f.request('/v1/messages', { sessionId: created.sessionId, text: 'steal' }, token('bob'))).status,
    404,
  )
  assert.equal((await f.request(`/v1/events?sessionId=${created.sessionId}`, undefined, token('bob'))).status, 404)
  assert.equal(f.opened.length, count)
  const response = await f.request(`/v1/events?sessionId=${created.sessionId}`, undefined, token(), {
    'Last-Event-ID': 'stream:7',
  })
  assert.equal(await response.text(), 'stream:7')
})
test('queue, steer, cancel, auth checks and per-session MCP configurations dispatch SDK messages', async () => {
  const f = fixture()
  const config = {
    tools: ['Read'],
    allowedTools: ['Read', 'mcp__docs__search'],
    mcps: { docs: { type: 'http', url: 'https://example.com/mcp' } },
  }
  const sessionId = (await (await f.request('/v1/sessions', config)).json()).sessionId
  assert.deepEqual(f.dispatched[0], { type: 'configure', config })
  const sent = await (await f.request('/v1/messages', { sessionId, text: 'first', mode: 'queue' })).json()
  assert.equal(sent.receiptId, 'receipt')
  assert.ok(sent.messageId)
  await f.request('/v1/messages', { sessionId, text: 'change direction', mode: 'steer' })
  await f.request('/v1/cancel', { sessionId, messageId: sent.messageId })
  await f.request('/v1/auth/complete', {})
  assert.deepEqual(
    f.dispatched.map((m) => m.type),
    ['configure', 'queue', 'steer', 'cancel'],
  )
  assert.deepEqual(f.requested, [{ type: 'auth.check' }])
})
test('reject credentials, invalid MCPs and oversized requests', async () => {
  const f = fixture()
  assert.equal((await f.request('/v1/auth', { claudeToken: 'secret' })).status, 400)
  assert.equal(
    (await f.request('/v1/sessions', { mcps: { x: { type: 'http', url: 'file:///etc/passwd' } } })).status,
    400,
  )
  assert.equal((await f.request('/v1/sessions', { tools: ['a,b'] })).status, 400)
  assert.equal((await f.request('/v1/sessions', { tools: ['--dangerously-skip-permissions'] })).status, 400)
  assert.equal((await f.request('/v1/auth', { data: 'x'.repeat(50000) })).status, 413)
})
test('login bridge accepts only public keys and encrypted input scoped to caller auth actor', async () => {
  const f = fixture(),
    publicKey = pair.publicKey.export({ format: 'jwk' }),
    attemptId = crypto.randomUUID()
  const r = await f.request('/v1/auth', { attemptId, publicKey })
  assert.equal(r.status, 202)
  assert.equal(f.dispatched.at(-1)?.type, 'auth.start')
  assert.equal((await f.request('/v1/auth/input', { attemptId, code: 'plaintext' })).status, 400)
  assert.equal(
    (await f.request('/v1/auth/input', { attemptId, sequence: 1, iv: 'A'.repeat(16), data: 'A'.repeat(24) })).status,
    202,
  )
  assert.match(f.opened.at(-1).id, /:auth$/)
  assert.equal((await f.request('/v1/auth/cancel', { attemptId })).status, 202)
  assert.equal((await f.request('/v1/auth', { attemptId, publicKey: { ...publicKey, d: 'private' } })).status, 400)
  assert.equal(
    (
      await f.request('/v1/auth/input', {
        attemptId,
        sessionId: 'other:auth',
        sequence: 1,
        iv: 'A'.repeat(16),
        data: 'A'.repeat(24),
      })
    ).status,
    400,
  )
})
test('login page is self-contained with restrictive CSP and no token persistence', async () => {
  const f = fixture(),
    res = await f.request('/login', undefined, '')
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /Connect your Claude subscription/)
  assert.match(res.headers.get('content-security-policy')!, /frame-ancestors 'none'/)
  assert.match(res.headers.get('content-security-policy')!, /connect-src 'self'/)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.ok(!html.includes('localStorage'))
  assert.ok(!html.includes('sessionStorage'))
})

test('execution settings dispatch with MCPs and reject invalid values before opening a session', async () => {
  const f = fixture()
  const settings = {
    model: 'claude-sonnet-5',
    systemPrompt: 'Canvas rules 😀',
    maxTurns: 24,
    tools: [],
    allowedTools: ['mcp__doop__*'],
    mcps: { doop: { type: 'http', url: 'https://doop.example/mcp', headers: { Authorization: 'Bearer run-token' } } },
  }
  assert.equal((await f.request('/v1/sessions', settings)).status, 202)
  assert.deepEqual(f.dispatched[0], { type: 'configure', config: settings })
  const count = f.opened.length
  for (const invalid of [
    { model: '' },
    { model: '--help' },
    { model: 'sonnet --help' },
    { model: 4 },
    { model: 'a'.repeat(129) },
    { systemPrompt: '' },
    { systemPrompt: '   ' },
    { systemPrompt: 12 },
    { systemPrompt: '😀'.repeat(8193) },
    { maxTurns: 0 },
    { maxTurns: 101 },
    { maxTurns: 1.5 },
    { maxTurns: '24' },
    { maxTurns: null },
  ])
    assert.equal((await f.request('/v1/sessions', invalid)).status, 400, JSON.stringify(invalid).slice(0, 80))
  assert.equal(f.opened.length, count)
  assert.equal((await f.request('/v1/sessions', { systemPrompt: 'x'.repeat(32768), maxTurns: 100 })).status, 202)
})
test('message UTF-8 limit allows larger context and preserves the encoded body limit', async () => {
  const f = fixture(),
    sessionId = (await (await f.request('/v1/sessions', {})).json()).sessionId
  const text = '😀'.repeat(8192)
  assert.equal((await f.request('/v1/messages', { sessionId, text })).status, 202)
  const dispatched = f.dispatched.at(-1)
  assert.ok(dispatched?.type === 'queue')
  assert.equal(dispatched.text, text)
  const count = f.dispatched.length
  assert.equal((await f.request('/v1/messages', { sessionId, text: text + 'x' })).status, 400)
  assert.equal((await f.request('/v1/messages', { sessionId, text: 'x'.repeat(50000) })).status, 413)
  assert.equal(f.dispatched.length, count)
})

test('all auth operations reuse the original session keep-alive contract', async () => {
  const f = fixture(),
    attemptId = crypto.randomUUID(),
    publicKey = pair.publicKey.export({ format: 'jwk' })
  const auth = await (await f.request('/v1/auth', {})).json()
  await f.request('/v1/auth', { attemptId, publicKey })
  await f.request('/v1/auth/input', { attemptId, sequence: 1, iv: 'A'.repeat(16), data: 'A'.repeat(24) })
  await f.request('/v1/auth/cancel', { attemptId })
  await f.request('/v1/auth/complete', {})
  await f.request(`/v1/events?sessionId=${auth.sessionId}`)
  assert.equal(f.opened.length, 6)
  for (const session of f.opened) {
    assert.equal(session.id, auth.sessionId)
    assert.equal(session.keepAliveSeconds, 900)
  }
  const agent = await (await f.request('/v1/sessions', {})).json()
  await f.request(`/v1/events?sessionId=${agent.sessionId}`)
  assert.equal(f.opened.at(-1).keepAliveSeconds, 300)
})

test('forced native re-login requires a valid terminal handshake', async () => {
  const f = fixture(),
    attemptId = crypto.randomUUID(),
    publicKey = pair.publicKey.export({ format: 'jwk' })
  assert.equal((await f.request('/v1/auth', { force: true })).status, 400)
  assert.equal((await f.request('/v1/auth', { attemptId, publicKey, force: 'yes' })).status, 400)
  assert.equal((await f.request('/v1/auth', { attemptId, publicKey, force: true })).status, 202)
  assert.equal((f.dispatched.at(-1) as { force?: boolean }).force, true)
})

test('status and snapshots return bounded replies without dispatch or an event subscription', async () => {
  const f = fixture()
  const sessionId = (await (await f.request('/v1/sessions', {})).json()).sessionId
  const status = await f.request('/v1/auth/complete', {})
  assert.equal(status.status, 200)
  assert.equal((await status.json()).authenticated, true)
  const snapshot = await f.request('/v1/snapshot', { sessionId })
  assert.equal(snapshot.status, 200)
  assert.deepEqual(await snapshot.json(), {
    sessionId,
    type: 'session.state',
    configured: true,
    messages: [],
    truncated: false,
  })
  assert.equal(snapshot.headers.get('cache-control'), 'no-store')
  assert.deepEqual(
    f.requested.map((c) => c.type),
    ['auth.check', 'snapshot'],
  )
  assert.deepEqual(
    f.dispatched.map((c) => c.type),
    ['configure'],
  )
  for (const options of f.requestOptions) {
    assert.equal(options.timeoutMs, 30_000)
    assert.ok(options.signal instanceof AbortSignal)
  }
  assert.equal((await f.request('/v1/snapshot', { sessionId }, token('bob'))).status, 404)
  assert.equal(f.requested.length, 2)
})

test('request timeout remains a no-store gateway timeout without exposing internal error text', async () => {
  const f = fixture(new RemoteAppError('request_wait_timeout', 504))
  const response = await f.request('/v1/auth/complete', {})
  assert.equal(response.status, 504)
  assert.deepEqual(await response.json(), { error: 'Operation failed', code: 'request_wait_timeout' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('logout uses caller auth session and waits for native sign-out', async () => {
  const f = fixture()
  const response = await f.request('/v1/auth/logout', {})
  assert.equal(response.status, 200)
  assert.equal((await response.json()).authenticated, false)
  assert.deepEqual(f.requested, [{ type: 'auth.logout' }])
  assert.match(f.opened[0].id, /:auth$/)
  assert.equal((await f.request('/v1/auth/logout', { sessionId: 'other:auth' })).status, 400)
})
