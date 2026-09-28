/* eslint-disable @typescript-eslint/no-explicit-any -- SDK fixture uses broad test doubles. */
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
function fixture(
  requestError?: Error,
  authReply: Reply = { type: 'auth.status', authenticated: true },
  stopError?: Error,
  logoutReply: Reply = { type: 'auth.status', authenticated: false },
) {
  const stopped: string[] = []
  const opened: any[] = [],
    workspaces: any[] = [],
    dispatched: Command[] = []
  const requested: Command[] = [],
    requestOptions: any[] = []
  const app = {
    workspaces: {
      open: async (input: any) => {
        workspaces.push(input)
        return { id: 'ws-1', slug: input.slug }
      },
    },
    sessions: {
      open: (input: any) => {
        opened.push(input)
        return {
          ...input,
          stop: async () => {
            assert.ok(['auth.check', 'auth.code', 'auth.logout'].includes(requested.at(-1)?.type ?? ''))
            stopped.push(input.id)
            if (stopError) throw stopError
          },
          dispatch: async (command: Command) => {
            dispatched.push(command)
            return { id: 'receipt' }
          },
          request: async (command: Command, options: unknown) => {
            requested.push(command)
            requestOptions.push(options)
            if (requestError) throw requestError
            if (command.type === 'auth.login')
              return {
                type: 'auth.login',
                attemptId: crypto.randomUUID(),
                url: 'https://claude.com/cai/oauth/authorize',
                expiresAt: 1,
              }
            if (command.type === 'auth.cancel') return { type: 'auth.cancelled', attemptId: command.attemptId }
            return command.type === 'auth.logout'
              ? logoutReply
              : command.type === 'auth.check' || command.type === 'auth.code'
                ? authReply
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
  return { request, opened, workspaces, dispatched, requested, requestOptions, stopped }
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
test('identity probe validates the application token without opening a Workspace', async () => {
  const f = fixture()
  const response = await f.request('/v1/identity')
  assert.equal(response.status, 200)
  assert.match((await response.json()).workspaceSlug, /^u-[a-f0-9]{48}$/)
  assert.deepEqual(f.opened, [])
  assert.deepEqual(f.workspaces, [])
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
  await f.request('/v1/auth', {})
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
test('login endpoints validate input, reach only the caller auth actor, and map login failures to HTTP errors', async () => {
  const f = fixture(),
    attemptId = crypto.randomUUID()
  const started = await f.request('/v1/auth/login', {})
  assert.equal(started.status, 200)
  assert.deepEqual(f.requested.at(-1), { type: 'auth.login' })
  assert.match(f.opened.at(-1).id, /:auth$/)
  assert.equal((await f.request('/v1/auth/login/code', { attemptId, code: 'abc#def' })).status, 200)
  assert.deepEqual(f.requested.at(-1), { type: 'auth.code', attemptId, code: 'abc#def' })
  for (const code of ['', 'with space', 'line\nbreak', 'tab\t', 'x'.repeat(2049), 42])
    assert.equal((await f.request('/v1/auth/login/code', { attemptId, code })).status, 400)
  assert.equal((await f.request('/v1/auth/login/code', { attemptId: 'nope', code: 'abc' })).status, 400)
  assert.equal(
    (await f.request('/v1/auth/login/code', { attemptId, code: 'abc', sessionId: 'other:auth' })).status,
    400,
  )
  assert.equal((await f.request('/v1/auth/cancel', { attemptId })).status, 200)
  assert.deepEqual(f.requested.at(-1), { type: 'auth.cancel', attemptId })
  for (const path of ['/v1/auth/input', '/v1/auth/complete']) assert.equal((await f.request(path, {})).status, 404)
  for (const [code, status] of [
    ['login_not_active', 409],
    ['code_rejected', 422],
    ['login_failed', 502],
    ['login_timeout', 504],
  ] as const) {
    const g = fixture(undefined, { type: 'error', code })
    const response = await g.request('/v1/auth/login/code', { attemptId, code: 'abc' })
    assert.equal(response.status, status)
    assert.equal((await response.json()).code, code)
    assert.deepEqual(g.stopped, [])
  }
})
test('execution settings dispatch with MCPs and reject invalid values before opening a session', async () => {
  const f = fixture()
  const settings = {
    model: 'claude-sonnet-5',
    systemPrompt: 'Project rules 😀',
    maxTurns: 24,
    tools: [],
    allowedTools: ['mcp__project__*'],
    mcps: {
      project: {
        type: 'http',
        url: 'https://tools.example.com/mcp',
        headers: { Authorization: 'Bearer session-token' },
      },
    },
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
  assert.equal((f.dispatched.at(-1) as any).text, text)
  const count = f.dispatched.length
  assert.equal((await f.request('/v1/messages', { sessionId, text: text + 'x' })).status, 400)
  assert.equal((await f.request('/v1/messages', { sessionId, text: 'x'.repeat(50000) })).status, 413)
  assert.equal(f.dispatched.length, count)
})

test('all auth operations reuse the original session keep-alive contract', async () => {
  const f = fixture(),
    attemptId = crypto.randomUUID()
  const auth = await (await f.request('/v1/auth', {})).json()
  await f.request('/v1/auth/login', {})
  await f.request('/v1/auth/login/code', { attemptId, code: 'abc' })
  await f.request('/v1/auth/cancel', { attemptId })
  await f.request(`/v1/events?sessionId=${auth.sessionId}`)
  assert.equal(f.opened.length, 5)
  for (const session of f.opened) {
    assert.equal(session.id, auth.sessionId)
    assert.equal(session.keepAliveSeconds, 900)
  }
  const agent = await (await f.request('/v1/sessions', {})).json()
  await f.request(`/v1/events?sessionId=${agent.sessionId}`)
  assert.equal(f.opened.at(-1).keepAliveSeconds, 300)
})

test('forced native re-login is an explicit boolean on the login endpoint', async () => {
  const f = fixture()
  assert.equal((await f.request('/v1/auth', { force: true })).status, 400)
  assert.equal((await f.request('/v1/auth/login', { force: 'yes' })).status, 400)
  assert.equal((await f.request('/v1/auth/login', { force: true })).status, 200)
  assert.deepEqual(f.requested.at(-1), { type: 'auth.login', force: true })
})

test('status and snapshots return bounded replies without dispatch or an event subscription', async () => {
  const f = fixture()
  const sessionId = (await (await f.request('/v1/sessions', {})).json()).sessionId
  const status = await f.request('/v1/auth', {})
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
  const response = await f.request('/v1/auth', {})
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
  assert.deepEqual(f.stopped, [f.opened[0].id])
  assert.match(f.opened[0].id, /:auth$/)
  assert.equal(f.opened[0].keepAliveSeconds, 900)
  assert.equal((await f.request('/v1/auth/logout', { sessionId: 'other:auth' })).status, 400)
})

test('logout preserves session lifetime when sign-out is unconfirmed', async () => {
  for (const reply of [
    { type: 'auth.status', authenticated: true },
    { type: 'error', code: 'logout_failed' },
  ] as Reply[]) {
    const f = fixture(undefined, undefined, undefined, reply)
    assert.equal((await f.request('/v1/auth/logout', {})).status, 200)
    assert.equal(f.opened[0].keepAliveSeconds, 900)
    assert.deepEqual(f.stopped, [])
  }
  const f = fixture(new RemoteAppError('request_wait_timeout', 504))
  assert.equal((await f.request('/v1/auth/logout', {})).status, 504)
  assert.equal(f.opened[0].keepAliveSeconds, 900)
  assert.deepEqual(f.stopped, [])
})

for (const [path, body] of [
  ['/v1/auth', {}],
  ['/v1/auth/login/code', { attemptId: crypto.randomUUID(), code: 'abc' }],
] as const) {
  test(`${path} stops only the caller's authenticated sandbox after checking native auth`, async () => {
    const f = fixture(),
      response = await f.request(path, body)
    assert.equal(response.status, 200)
    const reply = await response.json()
    assert.equal(reply.authenticated, true)
    assert.deepEqual(f.stopped, [reply.sessionId])
    assert.match(reply.sessionId, /:auth$/)
    assert.equal((await f.request(path, body, 'invalid')).status, 401)
    assert.equal(f.stopped.length, 1)
  })

  test(`${path} leaves unauthenticated and unsuccessful checks running`, async () => {
    for (const reply of [
      { type: 'auth.status', authenticated: false },
      { type: 'error', code: 'auth_session_required' },
    ] as Reply[]) {
      const f = fixture(undefined, reply)
      assert.equal((await f.request(path, body)).status, 200)
      assert.deepEqual(f.stopped, [])
    }
    const f = fixture(new RemoteAppError('request_wait_timeout', 504))
    assert.equal((await f.request(path, body)).status, 504)
    assert.deepEqual(f.stopped, [])
  })

  test(`${path} surfaces sandbox stop failures for retry`, async () => {
    const f = fixture(undefined, undefined, new RemoteAppError('stop_failed', 503))
    const response = await f.request(path, body)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'Operation failed', code: 'stop_failed' })
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })
}

function converging(failures: number) {
  let workspaceFailures = failures,
    dispatchFailures = failures,
    requestFailures = failures
  const requestIds: (string | undefined)[] = [],
    notFound = (id?: string) => new RemoteAppError('resource_not_found', 404, id)
  const app = {
    workspaces: {
      open: async ({ slug }: any) => {
        if (workspaceFailures-- > 0) throw notFound()
        return { id: 'ws-1', slug }
      },
    },
    sessions: {
      open: (input: any) => ({
        ...input,
        stop: async () => {},
        dispatch: async () => {
          if (dispatchFailures-- > 0) throw notFound()
          return { id: 'receipt' }
        },
        request: async (_command: Command, options: any) => {
          requestIds.push(options.id)
          if (requestFailures-- > 0) throw notFound('request-1')
          return { type: 'auth.status', authenticated: false }
        },
        events: async () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
      }),
    },
  } as unknown as CantelopApp<Command, Reply>
  const router = api.create({ app, env })
  const request = (path: string, body: unknown) =>
    router.handle(
      new Request(`https://app.example${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}` },
        body: JSON.stringify(body),
      }),
    )
  return { request, requestIds }
}

test('fresh Workspace resource_not_found is absorbed and requests retry under the same identity', async () => {
  const f = converging(2)
  const status = await f.request('/v1/auth', {})
  assert.equal(status.status, 200)
  assert.equal((await status.json()).authenticated, false)
  assert.deepEqual(f.requestIds, [undefined, 'request-1', 'request-1'])
  assert.equal((await f.request('/v1/sessions', {})).status, 202)
})

test('persistent resource_not_found is returned after bounded retries', async () => {
  const f = converging(Infinity)
  const response = await f.request('/v1/sessions', {})
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'Operation failed', code: 'resource_not_found' })
})
