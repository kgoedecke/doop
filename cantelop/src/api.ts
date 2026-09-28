import { defineApi, RemoteAppError, type HttpMethod } from '@cantelop/sdk/api'
import type { Command, Reply } from './contracts.js'
import { identity } from './auth.js'
import { ApiError, config, fail, fields, readBody, uuid } from './validation.js'

const AUTH_KEEP_ALIVE_SECONDS = 900
// The Session waits up to 20 s for Claude to print its link or finish the code exchange.
const LOGIN_WAIT_MS = 45_000
const LOGIN_ERRORS: Record<string, { status: number; message: string }> = {
  login_not_active: { status: 409, message: 'No active login attempt. Start a new one.' },
  code_rejected: { status: 422, message: 'Claude did not accept the code. Try again.' },
  login_failed: { status: 502, message: 'Claude login did not complete. Start a new attempt.' },
  login_timeout: { status: 504, message: 'Claude did not respond in time. Check the status before retrying.' },
}
// A newly created Workspace can briefly report resource_not_found while platform registration converges.
const CONVERGENCE_DELAYS_MS = [250, 500, 1000]

async function converge<T>(
  signal: AbortSignal,
  attempt: () => Promise<T>,
  failed?: (error: RemoteAppError) => void,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt()
    } catch (error) {
      if (
        !(error instanceof RemoteAppError) ||
        error.code !== 'resource_not_found' ||
        retry >= CONVERGENCE_DELAYS_MS.length
      )
        throw error
      failed?.(error)
      await new Promise((resolve) => setTimeout(resolve, CONVERGENCE_DELAYS_MS[retry]))
      signal.throwIfAborted()
    }
  }
}

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
  const openSession = (
    config: { id: string; workspaceSlug: string; keepAliveSeconds: number },
    signal: AbortSignal,
  ) => {
    const session = app.sessions.open(config)
    return {
      id: session.id,
      stop: () => session.stop(),
      dispatch: (command: Command) => converge(signal, () => session.dispatch(command)),
      request: (command: Command, timeoutMs: number) => {
        // Reuse the failed request's identity so a retry can never execute twice.
        let id: string | undefined
        return converge(
          signal,
          () => session.request(command, { timeoutMs, signal, ...(id ? { id } : {}) }),
          (error) => {
            id = error.messageId ?? id
          },
        )
      },
      events: (request: Request) => converge(signal, () => session.events(request)),
    }
  }
  const userSession = async (request: Request, sessionId: unknown) => {
    const user = await identity(request, env)
    if (typeof sessionId !== 'string' || !sessionId.startsWith(`${user.userId}:`))
      throw new ApiError(404, 'Session not found')
    const suffix = sessionId.slice(user.userId.length + 1)
    if (suffix !== 'auth') uuid(suffix)
    return openSession(
      {
        id: sessionId,
        workspaceSlug: user.workspaceSlug,
        keepAliveSeconds: suffix === 'auth' ? AUTH_KEEP_ALIVE_SECONDS : 300,
      },
      request.signal,
    )
  }
  const accepted = (sessionId: string, message: { id: string }, extra = {}) =>
    Response.json(
      { sessionId, receiptId: message.id, ...extra },
      { status: 202, headers: { 'cache-control': 'no-store' } },
    )
  const result = (sessionId: string, reply: Reply, extra = {}) => {
    const failure = reply.type === 'error' ? LOGIN_ERRORS[reply.code] : undefined
    if (failure)
      return Response.json(
        { error: failure.message, code: (reply as { code: string }).code },
        { status: failure.status, headers: { 'cache-control': 'no-store' } },
      )
    return Response.json({ sessionId, ...reply, ...extra }, { headers: { 'cache-control': 'no-store' } })
  }
  const authSession = (
    user: { userId: string; workspaceSlug: string },
    request: Request,
    keepAliveSeconds = AUTH_KEEP_ALIVE_SECONDS,
  ) => openSession({ id: `${user.userId}:auth`, workspaceSlug: user.workspaceSlug, keepAliveSeconds }, request.signal)
  const confirmed = async (session: ReturnType<typeof openSession>, reply: Reply) => {
    // Credentials live in the persistent Workspace, so release the Sandbox once native auth is confirmed.
    // Await cleanup so a platform failure is returned and the caller can retry.
    if (reply.type === 'auth.status' && reply.authenticated) await session.stop()
    return reply
  }
  route('GET', '/health', async () => Response.json({ ok: true }))
  route('GET', '/v1/identity', async (request) =>
    Response.json(await identity(request, env), { headers: { 'cache-control': 'no-store' } }),
  )
  route('POST', '/v1/auth', async (request) => {
    const user = await identity(request, env)
    fields(await readBody(request), [])
    const workspace = await converge(request.signal, () => app.workspaces.open({ slug: user.workspaceSlug }))
    const session = authSession(user, request)
    const metadata = { workspaceId: workspace.id, workspaceSlug: workspace.slug, workspace: '/workspace' }
    return result(session.id, await confirmed(session, await session.request({ type: 'auth.check' }, 30_000)), metadata)
  })
  route('POST', '/v1/auth/login', async (request) => {
    const user = await identity(request, env),
      body = await readBody(request)
    fields(body, ['force'])
    if (body.force !== undefined && typeof body.force !== 'boolean') fail('Invalid force flag')
    const session = authSession(user, request)
    return result(
      session.id,
      await confirmed(
        session,
        await session.request({ type: 'auth.login', ...(body.force ? { force: true } : {}) }, LOGIN_WAIT_MS),
      ),
    )
  })
  route('POST', '/v1/auth/login/code', async (request) => {
    const user = await identity(request, env),
      body = await readBody(request)
    fields(body, ['attemptId', 'code'])
    const attemptId = uuid(body.attemptId)
    // Printable ASCII only: the code is typed into Claude's terminal and must not carry control characters.
    if (typeof body.code !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(body.code)) fail('Invalid login code')
    const session = authSession(user, request)
    return result(
      session.id,
      await confirmed(session, await session.request({ type: 'auth.code', attemptId, code: body.code }, LOGIN_WAIT_MS)),
    )
  })
  route('POST', '/v1/auth/cancel', async (request) => {
    const user = await identity(request, env),
      body = await readBody(request)
    fields(body, ['attemptId'])
    const session = authSession(user, request)
    return result(session.id, await session.request({ type: 'auth.cancel', attemptId: uuid(body.attemptId) }, 30_000))
  })
  route('POST', '/v1/auth/logout', async (request) => {
    const user = await identity(request, env)
    fields(await readBody(request), [])
    const session = authSession(user, request)
    const reply = await session.request({ type: 'auth.logout' }, 45_000)
    if (reply.type === 'auth.status' && !reply.authenticated) await session.stop()
    return result(session.id, reply)
  })
  route('POST', '/v1/sessions', async (request) => {
    const user = await identity(request, env),
      settings = config(await readBody(request))
    const session = openSession(
      { id: `${user.userId}:${crypto.randomUUID()}`, workspaceSlug: user.workspaceSlug, keepAliveSeconds: 300 },
      request.signal,
    )
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
    return result(session.id, await session.request({ type: 'snapshot' }, 30_000))
  })
  route('GET', '/v1/events', async (request) => {
    const session = await userSession(request, new URL(request.url).searchParams.get('sessionId'))
    return session.events(request)
  })
})
