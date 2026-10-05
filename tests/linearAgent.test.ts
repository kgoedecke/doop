import { randomUUID, createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import express from 'express'
import type { Server } from 'node:http'
import { db } from '../server/db/index.ts'
import { linearInstallations, linearOAuthStates, linearSessions, tasks, canvases } from '../server/db/schema.ts'
import { agentToken, finishInstall, startInstall } from '../server/linear/oauth.ts'
import {
  cancelSessions,
  disconnectAgent,
  receiveSession,
  tickLinear,
  type sessionEvent,
} from '../server/linear/jobs.ts'
import { linearWebhookRouter, validSignature } from '../server/linear/webhook.ts'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { onFeedback } from '../server/resident.ts'
import { pickModel } from '../server/agentModel.ts'
import { consumeResidentTask } from '../server/allowance.ts'
import type { z } from 'zod'

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: vi.fn() }))
vi.mock('../server/agentModel.ts', () => ({ pickModel: vi.fn().mockResolvedValue({ userId: 'owner' }) }))
vi.mock('../server/allowance.ts', () => ({
  consumeResidentTask: vi.fn().mockResolvedValue({ ok: true, byoModel: true }),
  refundResidentTask: vi.fn(),
}))

const sent: { query: string; variables: Record<string, unknown>; authorization: string }[] = []
const nativeFetch = globalThis.fetch
let webhookServer: Server
let base: string
const userId = 'doop-owner'
const organizationId = 'linear-org'
const appUserId = 'doop-app'
let sessionId = ''

function event(overrides: Partial<z.infer<typeof sessionEvent>> = {}): z.infer<typeof sessionEvent> {
  return {
    type: 'AgentSessionEvent',
    action: 'created',
    organizationId,
    appUserId,
    oauthClientId: 'linear-client',
    webhookTimestamp: Date.now(),
    agentSession: {
      id: sessionId,
      appUserId,
      organizationId,
      issue: {
        id: 'issue-1',
        identifier: 'DES-12',
        title: 'Design a checkout screen',
        description: 'Use a two-column layout.',
      },
    },
    ...overrides,
  }
}

async function session() {
  const [row] = await db.select().from(linearSessions).where(eq(linearSessions.id, sessionId))
  return row!
}

beforeAll(async () => {
  // Real Postgres semantics, without starting a model or hitting Linear.
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
  const app = express()
  app.use('/webhooks/linear', linearWebhookRouter())
  webhookServer = app.listen(0)
  await new Promise<void>((resolve) => webhookServer.once('listening', resolve))
  const address = webhookServer.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  base = `http://localhost:${address.port}`
}, 30_000)

beforeEach(async () => {
  vi.stubEnv('LINEAR_CLIENT_ID', 'linear-client')
  vi.stubEnv('LINEAR_CLIENT_SECRET', 'linear-secret')
  vi.stubEnv('LINEAR_WEBHOOK_SECRET', 'webhook-secret')
  vi.stubEnv('BETTER_AUTH_URL', 'https://doop.example')
  await db.delete(linearSessions)
  await db.delete(linearInstallations)
  await db.delete(linearOAuthStates)
  await db.delete(tasks)
  await db.delete(canvases)
  store.canvases.clear()
  sessionId = randomUUID()
  sent.length = 0
  vi.clearAllMocks()
  vi.mocked(pickModel).mockResolvedValue({ userId } as Awaited<ReturnType<typeof pickModel>>)
  vi.mocked(consumeResidentTask).mockResolvedValue({ ok: true, byoModel: true } as Awaited<
    ReturnType<typeof consumeResidentTask>
  >)
  await db.insert(linearInstallations).values({
    organizationId,
    userId,
    appUserId,
    name: 'Design workspace',
    accessToken: 'oauth-secret',
    refreshToken: 'refresh-secret',
    expiresAt: Date.now() + 86_400_000,
    connectedAt: Date.now(),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, options?: RequestInit) => {
      if (String(url).includes('/oauth/token'))
        return Response.json({
          access_token: 'new-oauth-secret',
          refresh_token: 'new-refresh-secret',
          expires_in: 86_400,
        })
      const { query, variables } = JSON.parse(String(options?.body))
      sent.push({ query, variables, authorization: (options?.headers as Record<string, string>).Authorization ?? '' })
      if (query.includes('DoopAgentIdentity'))
        return Response.json({
          data: {
            viewer: { id: appUserId, name: 'Doop' },
            organization: { id: organizationId, name: 'Design workspace' },
          },
        })
      if (query.includes('DoopSessionLink')) return Response.json({ data: { agentSessionUpdate: { success: true } } })
      if (query.includes('DoopActivityExists')) return Response.json({ data: { agentActivity: { id: variables.id } } })
      return Response.json({ data: { agentActivityCreate: { success: true } } })
    }),
  )
})

afterAll(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await new Promise<void>((resolve) => webhookServer.close(() => resolve()))
})

describe('Linear agent installation', () => {
  it('requests an assignable app actor with PKCE and consumes user-bound state once', async () => {
    const { url } = await startInstall(userId)
    const params = new URL(url).searchParams
    expect(params.get('actor')).toBe('app')
    expect(params.get('scope')).toContain('app:assignable')
    expect(params.get('code_challenge_method')).toBe('S256')
    const state = params.get('state')!
    await expect(finishInstall('stranger', state, 'code')).rejects.toThrow('handoff expired')
    await finishInstall(userId, state, 'code')
    await expect(finishInstall(userId, state, 'code')).rejects.toThrow('handoff expired')
    expect(await agentToken(organizationId)).toBe('Bearer new-oauth-secret')
  })

  it('rejects expired state', async () => {
    const { url } = await startInstall(userId)
    await db.update(linearOAuthStates).set({ expiresAt: 1 })
    await expect(finishInstall(userId, new URL(url).searchParams.get('state')!, 'code')).rejects.toThrow(
      'handoff expired',
    )
  })

  it('does not transfer installation or billing to another Doop user', async () => {
    const { url } = await startInstall('stranger')
    await expect(finishInstall('stranger', new URL(url).searchParams.get('state')!, 'code')).rejects.toThrow(
      'already has a Doop installer',
    )
    expect((await db.select().from(linearInstallations))[0]?.userId).toBe(userId)
  })

  it('refreshes expiring tokens and persists the rotated refresh token', async () => {
    await db.update(linearInstallations).set({ expiresAt: 1 })
    expect(await agentToken(organizationId)).toBe('Bearer new-oauth-secret')
    expect((await db.select().from(linearInstallations))[0]?.refreshToken).toBe('new-refresh-secret')
  })
})

describe('delegation jobs', () => {
  it('queues one durable canvas/task per session, using the installer’s model account', async () => {
    await Promise.all([receiveSession(event()), receiveSession(event())])
    await Promise.all([tickLinear(), tickLinear()])
    const row = await session()
    expect(row.status).toBe('running')
    expect(await db.select().from(canvases)).toHaveLength(1)
    const cards = await db.select().from(tasks)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.queuedByUserId).toBe(userId)
    expect(cards[0]?.status).toContain('two-column')
    expect(consumeResidentTask).toHaveBeenCalledTimes(1)
    expect(onFeedback).toHaveBeenCalledWith(row.canvasId)
    expect(store.getCanvas(row.canvasId!)?.ownerId).toBe(userId)
    expect(sent.every((request) => request.authorization === 'Bearer oauth-secret')).toBe(true)
    await receiveSession(event())
    await tickLinear()
    expect(onFeedback).toHaveBeenCalledTimes(1)
  })

  it('posts a canvas link while working and a final response only after the task finishes', async () => {
    await receiveSession(event())
    await tickLinear()
    await tickLinear()
    expect(sent.some((request) => request.query.includes('DoopSessionLink'))).toBe(true)
    expect((await session()).reported).toBe(false)
    const row = await session()
    actions.completeCard(row.canvasId!, row.taskId!)
    await tickLinear()
    expect((await session()).status).toBe('complete')
    expect((await session()).reported).toBe(true)
    expect(JSON.stringify(sent)).toContain(`https://doop.example/c/${row.canvasId}`)
    const before = sent.length
    await tickLinear()
    expect(sent).toHaveLength(before)
  })

  it('does not start work without a usable model', async () => {
    vi.mocked(pickModel).mockResolvedValue(null)
    await receiveSession(event())
    await tickLinear()
    await tickLinear()
    expect((await session()).status).toBe('failed')
    expect((await session()).error).toContain('Connect a model')
    expect(onFeedback).not.toHaveBeenCalled()
    expect(consumeResidentTask).not.toHaveBeenCalled()
  })

  it('honors the task allowance', async () => {
    vi.mocked(consumeResidentTask).mockResolvedValue({ ok: false } as Awaited<ReturnType<typeof consumeResidentTask>>)
    await receiveSession(event())
    await tickLinear()
    expect((await session()).status).toBe('failed')
    expect(onFeedback).not.toHaveBeenCalled()
  })

  it('rejects mismatched workspace, app user and OAuth client', async () => {
    await receiveSession(event({ organizationId: 'other' }))
    await receiveSession(event({ appUserId: 'other' }))
    await receiveSession(event({ oauthClientId: 'other' }))
    expect(await db.select().from(linearSessions)).toHaveLength(0)
  })

  it('stops an active card on a Linear stop signal', async () => {
    await receiveSession(event())
    await tickLinear()
    await receiveSession(
      event({
        action: 'prompted',
        agentActivity: {
          id: randomUUID(),
          agentSessionId: sessionId,
          signal: 'stop',
          content: { body: '' },
        },
      }),
    )
    const row = await session()
    expect(row.status).toBe('canceled')
    expect(actions.getTasks(row.canvasId!).find((task) => task.id === row.taskId)?.failedAt).toBeTruthy()
    await tickLinear()
    expect((await session()).reported).toBe(true)
  })

  it('disconnect cancels work and future deliveries cannot start new tasks', async () => {
    await receiveSession(event())
    await disconnectAgent(userId)
    await tickLinear()
    expect((await session()).status).toBe('canceled')
    sessionId = randomUUID()
    await receiveSession(event())
    expect(await db.select().from(linearSessions)).toHaveLength(1)
    expect(onFeedback).not.toHaveBeenCalled()
  })

  it('honors stop even when delivered before the session creation event', async () => {
    await receiveSession(
      event({
        action: 'prompted',
        agentActivity: {
          id: randomUUID(),
          agentSessionId: sessionId,
          signal: 'stop',
          content: {},
        },
      }),
    )
    await receiveSession(event())
    await tickLinear()
    expect((await session()).status).toBe('canceled')
    expect(onFeedback).not.toHaveBeenCalled()
  })

  it('retries failed result delivery without dispatching or spending again', async () => {
    await receiveSession(event())
    await tickLinear()
    await tickLinear()
    const row = await session()
    actions.completeCard(row.canvasId!, row.taskId!)
    const fetcher = vi.mocked(fetch)
    const working = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async () => Response.json({ errors: [{ message: 'unavailable' }] }, { status: 503 }))
    await tickLinear()
    expect((await session()).status).toBe('complete')
    expect((await session()).reported).toBe(false)
    expect((await session()).nextAttemptAt).toBeGreaterThan(Date.now())
    fetcher.mockImplementation(working)
    await db.update(linearSessions).set({ nextAttemptAt: 0 }).where(eq(linearSessions.id, sessionId))
    await tickLinear()
    expect((await session()).reported).toBe(true)
    expect(onFeedback).toHaveBeenCalledTimes(1)
    expect(consumeResidentTask).toHaveBeenCalledTimes(1)
  })

  it('reports runner failures as errors instead of finished designs', async () => {
    await receiveSession(event())
    await tickLinear()
    const row = await session()
    actions.failCard(row.canvasId!, row.taskId!, 'Model failed')
    await tickLinear()
    expect((await session()).status).toBe('failed')
    expect((await session()).reported).toBe(true)
  })

  it('limits concurrent dispatched jobs per installer', async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID())
    for (const id of ids) {
      sessionId = id
      await receiveSession(event())
    }
    await Promise.all([tickLinear(), tickLinear()])
    const rows = await db.select().from(linearSessions)
    expect(rows.filter((row) => row.status === 'running')).toHaveLength(3)
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(2)
    expect(consumeResidentTask).toHaveBeenCalledTimes(3)
  })

  it('isolates cancellation by organization', async () => {
    await receiveSession(event())
    await cancelSessions('other-org', 'stop')
    expect((await session()).status).toBe('pending')
  })

  it('recovers interrupted preparation as a visible failure without dispatching again', async () => {
    await receiveSession(event())
    await db.update(linearSessions).set({ status: 'preparing', updatedAt: Date.now() - 180_000 })
    await tickLinear()
    expect((await session()).status).toBe('failed')
    expect((await session()).reported).toBe(true)
    expect(onFeedback).not.toHaveBeenCalled()
  })
})

describe('signed webhook boundary', () => {
  it('validates the exact bytes with constant-length signatures', () => {
    const raw = Buffer.from('{"hello":"world"}')
    const signature = createHmac('sha256', 'secret').update(raw).digest('hex')
    expect(validSignature(raw, signature, 'secret')).toBe(true)
    expect(validSignature(Buffer.from('changed'), signature, 'secret')).toBe(false)
    expect(validSignature(raw, 'short', 'secret')).toBe(false)
  })

  it('accepts a signed delivery without a browser session and wakes the runner', async () => {
    const raw = JSON.stringify(event())
    const signature = createHmac('sha256', 'webhook-secret').update(raw).digest('hex')
    const response = await nativeFetch(`${base}/webhooks/linear`, {
      method: 'POST',
      body: raw,
      headers: { 'Content-Type': 'application/json', 'linear-signature': signature },
    })
    expect(response.status).toBe(200)
    await vi.waitFor(async () => expect((await session()).status).toBe('running'))
    await vi.waitFor(() => expect(onFeedback).toHaveBeenCalledTimes(1))
  })

  it('rejects unsigned or stale requests before persisting any job', async () => {
    const raw = JSON.stringify(event({ webhookTimestamp: Date.now() - 120_000 }))
    const signature = createHmac('sha256', 'webhook-secret').update(raw).digest('hex')
    expect(
      (
        await nativeFetch(`${base}/webhooks/linear`, {
          method: 'POST',
          body: raw,
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await nativeFetch(`${base}/webhooks/linear`, {
          method: 'POST',
          body: raw,
          headers: { 'Content-Type': 'application/json', 'linear-signature': signature },
        })
      ).status,
    ).toBe(400)
    expect(await db.select().from(linearSessions)).toHaveLength(0)
  })
})
