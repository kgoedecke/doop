import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, ElementComment, Frame } from '../shared/types.ts'

/* The registry writes through to the database and reads it once at boot; a
   thenable proxy stands in so every query resolves to nothing. What leaves the
   process — DNS and HTTP — is stubbed per test. */
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(async (_host: string, _opts: unknown) => [{ address: '93.184.216.34', family: 4 }]),
  fetch: vi.fn(),
  access: vi.fn((_userId: string, _canvas: unknown) => true),
  dbError: null as Error | null,
}))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('../server/db/index.ts', () => {
  const chain: unknown = new Proxy(() => {}, {
    get: (_t, prop) =>
      prop === 'then'
        ? (resolve: (v: unknown[]) => void, reject: (e: Error) => void) =>
            mocks.dbError ? reject(mocks.dbError) : resolve([])
        : () => chain,
    apply: () => chain,
  })
  return { db: chain }
})
vi.mock('../server/access.ts', () => ({ hasDurableCanvasAccess: mocks.access }))
vi.mock('../server/store.ts', () => ({
  store: { getCanvasMetadata: (id: string) => (id === 'c1' ? CANVAS : undefined) },
}))

const CANVAS: Canvas = { id: 'c1', name: 'Landing', ownerId: 'alice', createdAt: 0, updatedAt: 0, frames: [] }
const FRAME: Frame = {
  id: 'f1',
  canvasId: 'c1',
  name: 'Hero',
  html: '<h1>Hi</h1>',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}
const COMMENT: ElementComment = {
  id: 'cm1',
  canvasId: 'c1',
  frameId: 'f1',
  selector: 'h1',
  snippet: '<h1>Hi</h1>',
  from: 'Alice',
  fromUserId: 'alice',
  text: 'Bigger?',
  at: 1,
}

const webhooks = await import('../server/webhooks.ts')

function ok(status = 200) {
  return { ok: status < 300, status, body: { cancel: async () => {} } }
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  mocks.access.mockReturnValue(true)
  mocks.fetch.mockResolvedValue(ok())
  mocks.dbError = null
  vi.stubGlobal('fetch', mocks.fetch)
  delete process.env.WEBHOOK_ALLOW_PRIVATE_URLS
  await webhooks.hydrateWebhooks() // empties the registry
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const register = (userId = 'alice', events: unknown = ['comment.created'], url = 'https://hooks.example.com/doop') =>
  webhooks.createWebhook(userId, { url, events })

describe('address screening', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['::ffff:10.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:a00:1', true],
    ['::ffff:5db8:d822', false],
    ['2606:4700::1', false],
    ['93.184.216.34', false],
    ['not-an-ip', true],
  ])('%s private: %s', (ip, expected) => {
    expect(webhooks.isPrivateAddress(ip)).toBe(expected)
  })

  it('refuses schemes, credentials and local names before any lookup', () => {
    expect(webhooks.urlProblem('ftp://x.example.com/')).toMatch(/https/)
    expect(webhooks.urlProblem('https://user:pw@x.example.com/')).toMatch(/credentials/)
    expect(webhooks.urlProblem('http://localhost:5678/hook')).toMatch(/private/)
    expect(webhooks.urlProblem('http://n8n.localhost/hook')).toMatch(/private/)
    expect(webhooks.urlProblem('http://127.0.0.1/')).toMatch(/private/)
    expect(webhooks.urlProblem('http://[::1]/')).toMatch(/private/)
    /* the URL parser spells a mapped IPv4 in hex — the form the screen must catch */
    expect(new URL('http://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]')
    expect(webhooks.urlProblem('http://[::ffff:127.0.0.1]/')).toMatch(/private/)
    expect(webhooks.urlProblem('http://[::ffff:7f00:1]/')).toMatch(/private/)
    expect(webhooks.urlProblem('http://2130706433/')).toMatch(/private/)
    expect(webhooks.urlProblem('nope')).toMatch(/valid URL/)
    expect(webhooks.urlProblem('https://hooks.example.com/doop')).toBeNull()
  })

  it('refuses a public name that resolves inward, and a name that does not resolve', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }])
    expect(await webhooks.targetProblem('https://evil.example.com/')).toMatch(/private/)
    mocks.lookup.mockRejectedValueOnce(new Error('ENOTFOUND'))
    expect(await webhooks.targetProblem('https://gone.example.com/')).toMatch(/resolve/)
    expect(await webhooks.targetProblem('https://hooks.example.com/')).toBeNull()
  })

  it('lets the operator allow private targets', async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_URLS = 'true'
    expect(webhooks.urlProblem('http://n8n:5678/webhook/doop')).toBeNull()
    expect(await webhooks.targetProblem('http://localhost:5678/hook')).toBeNull()
    expect(mocks.lookup).not.toHaveBeenCalled()
  })
})

describe('registry', () => {
  it('mints a secret once and never lists it', async () => {
    const { info, secret } = await register()
    expect(secret).toMatch(/^whsec_/)
    expect(info).not.toHaveProperty('secret')
    expect(info).not.toHaveProperty('userId')
    expect(webhooks.listWebhooks('alice')).toEqual([info])
    expect(webhooks.listWebhooks('bob')).toEqual([])
  })

  it('rejects bad input as a user error', async () => {
    await expect(register('alice', [])).rejects.toBeInstanceOf(webhooks.WebhookInputError)
    await expect(register('alice', ['no.such.event'])).rejects.toThrow(/at least one event/)
    await expect(register('alice', ['comment.created'], 'http://localhost/')).rejects.toThrow(/private/)
  })

  it('caps the number of hooks per account, also under concurrent requests', async () => {
    const results = await Promise.allSettled(Array.from({ length: webhooks.MAX_WEBHOOKS + 3 }, () => register()))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(webhooks.MAX_WEBHOOKS)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3)
    expect(webhooks.listWebhooks('alice')).toHaveLength(webhooks.MAX_WEBHOOKS)
    await expect(register()).rejects.toThrow(/remove one/)
  })

  it('leaves memory untouched when the database write fails', async () => {
    const { info, secret } = await register()
    mocks.dbError = new Error('connection lost')
    await expect(register('alice', ['comment.created'], 'https://two.example.com/')).rejects.toThrow('connection lost')
    await expect(webhooks.updateWebhook('alice', info.id, { enabled: false })).rejects.toThrow('connection lost')
    await expect(webhooks.deleteWebhook('alice', info.id)).rejects.toThrow('connection lost')
    await expect(webhooks.rotateWebhookSecret('alice', info.id)).rejects.toThrow('connection lost')
    expect(webhooks.listWebhooks('alice')).toEqual([info])
    mocks.dbError = null
    webhooks.onCanvasEvent('c1', { type: 'comment.created', comment: COMMENT, frame: FRAME, actorKind: 'user' })
    await vi.advanceTimersByTimeAsync(0)
    /* the rotation that failed must not have changed the signing secret */
    const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-doop-signature']).toBe(
      webhooks.sign(secret, Number(headers['x-doop-timestamp']), String(init.body)),
    )
  })

  it('only the owner can change, rotate, test or delete a hook', async () => {
    const { info } = await register()
    expect(await webhooks.updateWebhook('bob', info.id, { enabled: false })).toBeUndefined()
    expect(await webhooks.rotateWebhookSecret('bob', info.id)).toBeUndefined()
    expect(await webhooks.testWebhook('bob', info.id)).toBeUndefined()
    expect(await webhooks.deleteWebhook('bob', info.id)).toBe(false)
    expect(await webhooks.deleteWebhook('alice', info.id)).toBe(true)
  })

  it('a settings change does not undo a failure that landed while it was saving', async () => {
    const { info } = await register()
    mocks.lookup.mockImplementationOnce(async () => {
      /* while the URL change waits on DNS, a delivery fails */
      mocks.fetch.mockResolvedValueOnce(ok(500))
      await webhooks.testWebhook('alice', info.id)
      return [{ address: '93.184.216.34', family: 4 }]
    })
    const updated = await webhooks.updateWebhook('alice', info.id, { url: 'https://moved.example.com/' })
    expect(updated).toMatchObject({ url: 'https://moved.example.com/', failures: 1, lastError: 'HTTP 500' })
  })

  it('re-enabling clears the failure history', async () => {
    const { info } = await register()
    mocks.fetch.mockResolvedValue(ok(500))
    await webhooks.testWebhook('alice', info.id)
    expect(webhooks.listWebhooks('alice')[0]?.failures).toBe(1)
    const back = await webhooks.updateWebhook('alice', info.id, { enabled: true })
    expect(back?.failures).toBe(0)
    expect(back?.lastError).toBeNull()
  })
})

describe('delivery', () => {
  const lastCall = () => {
    const call = mocks.fetch.mock.calls.at(-1) as [string, RequestInit] | undefined
    if (!call) throw new Error('fetch was not called')
    return { url: call[0], init: call[1], headers: call[1].headers as Record<string, string> }
  }

  it('signs the body over the timestamp and names the event', async () => {
    const { secret } = await register()
    webhooks.onCanvasEvent('c1', { type: 'comment.created', comment: COMMENT, frame: FRAME, actorKind: 'user' })
    await vi.advanceTimersByTimeAsync(0)
    const { url, init, headers } = lastCall()
    expect(url).toBe('https://hooks.example.com/doop')
    expect(init.redirect).toBe('manual')
    expect(headers['x-doop-event']).toBe('comment.created')
    const body = String(init.body)
    const expected =
      'sha256=' + createHmac('sha256', secret).update(`${headers['x-doop-timestamp']}.${body}`).digest('hex')
    expect(headers['x-doop-signature']).toBe(expected)
    const payload = JSON.parse(body)
    expect(payload.type).toBe('comment.created')
    expect(payload.id).toBe(headers['x-doop-delivery'])
    expect(payload.canvas).toEqual({ id: 'c1', name: 'Landing', url: 'http://localhost:4300/c/c1' })
    expect(payload.actor).toEqual({ name: 'Alice', kind: 'user' })
    expect(payload.comment.url).toBe('http://localhost:4300/c/c1?frame=f1&comment=cm1')
    expect(payload.frame).not.toHaveProperty('html')
  })

  it('fans out only to subscribed, enabled hooks whose owner can open the canvas', async () => {
    await register('alice', ['comment.created'])
    await register('alice', ['frame.created'], 'https://other.example.com/')
    const { info: off } = await register('alice', ['comment.created'], 'https://off.example.com/')
    await webhooks.updateWebhook('alice', off.id, { enabled: false })
    await register('bob', ['comment.created'], 'https://bob.example.com/')
    mocks.access.mockImplementation((userId) => userId === 'alice')
    webhooks.onCanvasEvent('c1', { type: 'comment.created', comment: COMMENT, frame: FRAME, actorKind: 'user' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetch.mock.calls.map(([u]) => u)).toEqual(['https://hooks.example.com/doop'])
  })

  it('retries a failed delivery on the schedule, then records the success', async () => {
    const { info } = await register()
    mocks.fetch.mockResolvedValueOnce(ok(502)).mockResolvedValueOnce(ok(204))
    webhooks.onCanvasEvent('c1', { type: 'comment.created', comment: COMMENT, frame: FRAME, actorKind: 'user' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(webhooks.listWebhooks('alice')[0]).toMatchObject({ failures: 1, lastStatus: 502, lastError: 'HTTP 502' })
    await vi.advanceTimersByTimeAsync(webhooks.RETRY_DELAYS_MS[0]!)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(webhooks.listWebhooks('alice')[0]).toMatchObject({ failures: 0, lastStatus: 204, lastError: null })
    const [first, second] = mocks.fetch.mock.calls as [string, RequestInit][]
    expect(second![1].body).toBe(first![1].body) // the same delivery, re-sent
    expect(info.id).toBeDefined()
  })

  it('drops the first attempt when access is lost during the lookup', async () => {
    await register()
    mocks.lookup.mockImplementationOnce(async () => {
      mocks.access.mockReturnValue(false) // removed while DNS was being asked
      return [{ address: '93.184.216.34', family: 4 }]
    })
    webhooks.onCanvasEvent('c1', { type: 'comment.created', comment: COMMENT, frame: FRAME, actorKind: 'user' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(webhooks.listWebhooks('alice')[0]).toMatchObject({ failures: 0, lastAt: null })
  })

  it('does not retry once the owner can no longer open the canvas', async () => {
    await register()
    mocks.fetch.mockResolvedValueOnce(ok(503))
    webhooks.onCanvasEvent('c1', { type: 'comment.created', comment: COMMENT, frame: FRAME, actorKind: 'user' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    mocks.access.mockReturnValue(false) // removed from the canvas during the back-off
    await vi.advanceTimersByTimeAsync(webhooks.RETRY_DELAYS_MS[0]!)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('records overlapping attempts in the order they started', async () => {
    const { info } = await register()
    let failLate: (v: unknown) => void = () => {}
    mocks.fetch
      .mockImplementationOnce(() => new Promise((resolve) => (failLate = resolve)))
      .mockResolvedValueOnce(ok(200))
    const slow = webhooks.testWebhook('alice', info.id)
    await webhooks.testWebhook('alice', info.id)
    expect(webhooks.listWebhooks('alice')[0]).toMatchObject({ failures: 0, lastStatus: 200 })
    failLate(ok(500))
    await slow
    expect(webhooks.listWebhooks('alice')[0]).toMatchObject({ failures: 0, lastStatus: 200, lastError: null })
  })

  it('gives up after the last retry and does not follow redirects', async () => {
    await register('alice', ['frame.created'])
    mocks.fetch.mockResolvedValue(ok(302))
    webhooks.onCanvasEvent('c1', {
      type: 'frame.created',
      frame: FRAME,
      actor: { name: 'Doop', kind: 'agent', color: '#000' },
    })
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of webhooks.RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(mocks.fetch).toHaveBeenCalledTimes(1 + webhooks.RETRY_DELAYS_MS.length)
    expect(webhooks.listWebhooks('alice')[0]?.lastError).toBe('redirects are not followed')
  })

  it('pauses itself after too many failures in a row', async () => {
    const { info } = await register()
    mocks.fetch.mockRejectedValue(new TypeError('fetch failed'))
    for (let i = 0; i < webhooks.DISABLE_AFTER_FAILURES; i++) await webhooks.testWebhook('alice', info.id)
    const paused = webhooks.listWebhooks('alice')[0]!
    expect(paused.enabled).toBe(false)
    expect(paused.lastError).toMatch(/^paused after/)
    mocks.fetch.mockClear()
    webhooks.onCanvasEvent('c1', { type: 'comment.created', comment: COMMENT, frame: FRAME, actorKind: 'user' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('re-screens the address at delivery time', async () => {
    const { info } = await register()
    mocks.lookup.mockResolvedValue([{ address: '192.168.0.9', family: 4 }])
    const result = await webhooks.testWebhook('alice', info.id)
    expect(result).toMatchObject({ ok: false, status: null })
    expect(result?.error).toMatch(/private/)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('reports a timeout as such', async () => {
    const { info } = await register()
    const timeout = new Error('aborted')
    timeout.name = 'TimeoutError'
    mocks.fetch.mockRejectedValue(timeout)
    expect(await webhooks.testWebhook('alice', info.id)).toMatchObject({ ok: false, error: 'no response within 10s' })
  })
})

describe('payloads', () => {
  it('shapes every event', () => {
    const task = {
      id: 't1',
      agentName: 'Doop',
      color: '#000',
      status: 'Make the hero pop',
      startedAt: 1,
      queuedBy: 'Alice',
    }
    expect(webhooks.payloadFor({ type: 'task.completed', task })).toMatchObject({
      actor: { name: 'Doop', kind: 'agent' },
      task: { id: 't1', title: 'Make the hero pop', queuedBy: 'Alice', frameIds: [] },
    })
    expect(webhooks.payloadFor({ type: 'task.failed', task, reason: 'rate limited' })).toMatchObject({
      reason: 'rate limited',
    })
    expect(
      webhooks.payloadFor({ type: 'comment.resolved', comment: COMMENT, frame: undefined, by: 'Bob' }),
    ).toMatchObject({
      actor: { name: 'Bob' },
      frame: null,
    })
    const reply = { ...COMMENT, id: 'r1', parentId: 'cm1' }
    expect(
      webhooks.payloadFor({ type: 'comment.replied', comment: reply, frame: FRAME, actorKind: 'agent' }),
    ).toMatchObject({ comment: { parentId: 'cm1', url: 'http://localhost:4300/c/c1?frame=f1&comment=cm1' } })
  })
})
