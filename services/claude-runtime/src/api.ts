import { defineApi, RemoteAppError, type HttpMethod } from '@cantelop/sdk/api'
import type { Command, Reply } from './contracts.js'
import { loginPage } from './login-page.js'
import { identity } from './auth.js'
import { ApiError, config, fail, fields, readBody, uuid } from './validation.js'

const AUTH_KEEP_ALIVE_SECONDS = 900

export default defineApi<Command, Reply>(({ app, router, env }) => {
  const route = (method: HttpMethod, path: string, handle: (r: Request) => Promise<Response>) => {
    router.route(method, path, async ({ request }) => {
      try {
        return await handle(request)
      } catch (error) {
        if (error instanceof RemoteAppError) {
          return Response.json(
            { error: 'Operation failed', code: error.code },
            {
              status: error.status >= 400 && error.status <= 599 ? error.status : 502,
              headers: { 'cache-control': 'no-store' },
            },
          )
        }
        return Response.json(
          { error: error instanceof ApiError ? error.message : 'Operation failed' },
          { status: error instanceof ApiError ? error.status : 500, headers: { 'cache-control': 'no-store' } },
        )
      }
    })
  }
  const userSession = async (request: Request, sessionId: unknown) => {
    const user = await identity(request, env)
    if (typeof sessionId !== 'string' || !sessionId.startsWith(`${user.userId}:`))
      throw new ApiError(404, 'Session not found')
    const suffix = sessionId.slice(user.userId.length + 1)
    if (suffix !== 'auth') uuid(suffix)
    return app.sessions.open({
      id: sessionId,
      workspaceSlug: user.workspaceSlug,
      keepAliveSeconds: suffix === 'auth' ? AUTH_KEEP_ALIVE_SECONDS : 300,
    })
  }
  const accepted = (sessionId: string, message: { id: string }, extra = {}) =>
    Response.json(
      { sessionId, receiptId: message.id, ...extra },
      { status: 202, headers: { 'cache-control': 'no-store' } },
    )
  const result = (sessionId: string, reply: Reply, extra = {}) =>
    Response.json({ sessionId, ...reply, ...extra }, { headers: { 'cache-control': 'no-store' } })
  route('GET', '/login', async () => loginPage())
  route('GET', '/health', async () => Response.json({ ok: true }))
  route('POST', '/v1/auth', async (request) => {
    const user = await identity(request, env)
    const body = await readBody(request)
    fields(body, ['attemptId', 'publicKey', 'force'])
    if (body.force !== undefined && typeof body.force !== 'boolean') fail('Invalid force flag')
    if (body.force && !body.attemptId) fail('Login attempt required')
    let start: Command = { type: 'auth.check' }
    if (body.attemptId !== undefined || body.publicKey !== undefined) {
      const attemptId = uuid(body.attemptId)
      fields(body.publicKey, ['kty', 'crv', 'x', 'y', 'ext', 'key_ops'])
      const k = body.publicKey
      if (
        k.kty !== 'EC' ||
        k.crv !== 'P-256' ||
        typeof k.x !== 'string' ||
        typeof k.y !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(k.x) ||
        !/^[A-Za-z0-9_-]{43}$/.test(k.y)
      )
        fail('Invalid terminal public key')
      start = {
        type: 'auth.start',
        attemptId,
        ...(body.force ? { force: true } : {}),
        publicKey: { kty: 'EC', crv: 'P-256', x: k.x, y: k.y },
      }
    }
    const workspace = await app.workspaces.open({ slug: user.workspaceSlug })
    const session = app.sessions.open({
      id: `${user.userId}:auth`,
      workspaceSlug: user.workspaceSlug,
      keepAliveSeconds: AUTH_KEEP_ALIVE_SECONDS,
    })
    const metadata = {
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      workspace: '/workspace',
      loginPage: '/login',
    }
    if (start.type === 'auth.check') {
      return result(session.id, await session.request(start, { timeoutMs: 30_000, signal: request.signal }), metadata)
    }
    return accepted(session.id, await session.dispatch(start), metadata)
  })
  for (const action of ['input', 'cancel'] as const)
    route('POST', `/v1/auth/${action}`, async (request) => {
      const user = await identity(request, env),
        body = await readBody(request)
      fields(body, action === 'input' ? ['attemptId', 'sequence', 'iv', 'data'] : ['attemptId'])
      const attemptId = uuid(body.attemptId)
      let command: Command = { type: 'auth.cancel', attemptId }
      if (action === 'input') {
        if (
          !Number.isSafeInteger(body.sequence) ||
          Number(body.sequence) < 1 ||
          typeof body.iv !== 'string' ||
          !/^[A-Za-z0-9+/]{16}$/.test(body.iv) ||
          typeof body.data !== 'string' ||
          body.data.length < 24 ||
          body.data.length > 8192 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)
        )
          fail('Invalid encrypted terminal frame')
        command = { type: 'auth.input', attemptId, sequence: Number(body.sequence), iv: body.iv, data: body.data }
      }
      const session = app.sessions.open({
        id: `${user.userId}:auth`,
        workspaceSlug: user.workspaceSlug,
        keepAliveSeconds: AUTH_KEEP_ALIVE_SECONDS,
      })
      return accepted(session.id, await session.dispatch(command))
    })
  route('POST', '/v1/auth/logout', async (request) => {
    const user = await identity(request, env)
    fields(await readBody(request), [])
    const session = app.sessions.open({
      id: `${user.userId}:auth`,
      workspaceSlug: user.workspaceSlug,
      keepAliveSeconds: AUTH_KEEP_ALIVE_SECONDS,
    })
    return result(
      session.id,
      await session.request({ type: 'auth.logout' }, { timeoutMs: 45_000, signal: request.signal }),
    )
  })
  route('POST', '/v1/auth/complete', async (request) => {
    const user = await identity(request, env)
    fields(await readBody(request), [])
    const session = app.sessions.open({
      id: `${user.userId}:auth`,
      workspaceSlug: user.workspaceSlug,
      keepAliveSeconds: AUTH_KEEP_ALIVE_SECONDS,
    })
    return result(
      session.id,
      await session.request({ type: 'auth.check' }, { timeoutMs: 30_000, signal: request.signal }),
    )
  })
  route('POST', '/v1/sessions', async (request) => {
    const user = await identity(request, env),
      settings = config(await readBody(request))
    const session = app.sessions.open({
      id: `${user.userId}:${crypto.randomUUID()}`,
      workspaceSlug: user.workspaceSlug,
      keepAliveSeconds: 300,
    })
    return accepted(session.id, await session.dispatch({ type: 'configure', config: settings }))
  })
  route('POST', '/v1/messages', async (request) => {
    const b = await readBody(request)
    fields(b, ['sessionId', 'text', 'mode', 'messageId'])
    const session = await userSession(request, b.sessionId)
    if (typeof b.text !== 'string' || !b.text.trim() || new TextEncoder().encode(b.text).length > 32 * 1024)
      fail('text must contain 1–32768 UTF-8 bytes')
    if (b.mode !== undefined && b.mode !== 'queue' && b.mode !== 'steer') fail('Invalid message mode')
    const id = b.messageId === undefined ? crypto.randomUUID() : uuid(b.messageId)
    return accepted(session.id, await session.dispatch({ type: b.mode ?? 'queue', id, text: b.text }), {
      messageId: id,
    })
  })
  route('POST', '/v1/cancel', async (request) => {
    const b = await readBody(request)
    fields(b, ['sessionId', 'messageId'])
    const session = await userSession(request, b.sessionId),
      id = uuid(b.messageId)
    return accepted(session.id, await session.dispatch({ type: 'cancel', id }), { messageId: id })
  })
  route('POST', '/v1/snapshot', async (request) => {
    const b = await readBody(request)
    fields(b, ['sessionId'])
    const session = await userSession(request, b.sessionId)
    return result(
      session.id,
      await session.request({ type: 'snapshot' }, { timeoutMs: 30_000, signal: request.signal }),
    )
  })
  route('GET', '/v1/events', async (request) => {
    const session = await userSession(request, new URL(request.url).searchParams.get('sessionId'))
    return session.events(request)
  })
})
