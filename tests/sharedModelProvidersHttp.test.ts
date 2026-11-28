import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client, startServer, type Server } from './harness'

/**
 * Shared providers end to end: an admin adds a custom provider in Admin →
 * Shared models, every person sees it beside their own connections, picks a
 * model or switches it off for themselves, and can neither edit, remove nor
 * borrow its key. Against a fake OpenAI-compatible endpoint on loopback (which
 * needs the operator's private-hosts switch). The key and header values go in
 * and never come back out, not even to the admin.
 */

let server: Server
let boss: Client
let alice: Client
let bob: Client
let endpoint: http.Server
let base = ''
const seen: { url: string; authorization?: string; tenant?: string }[] = []
/* every response body any test read, checked for the secrets at the end */
const bodies: string[] = []

beforeAll(async () => {
  endpoint = http.createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      ...(typeof req.headers['x-tenant'] === 'string' ? { tenant: req.headers['x-tenant'] } : {}),
    })
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.url?.endsWith('/models'))
        return res.end(JSON.stringify({ data: [{ id: 'qwen3-coder' }, { id: 'glm-5' }] }))
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: { tool_calls: [{ id: 'c1', function: { name: 'report_ready', arguments: '{"ready":true}' } }] },
            },
          ],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`
  server = await startServer({
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    DATABASE_URL: '',
    SMTP_HOST: '',
    ADMIN_EMAILS: 'shared-boss@example.test',
    DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS: 'true',
  })
  boss = await new Client(server).signUp('shared-boss@example.test', 'Boss')
  alice = await new Client(server).signUp('shared-alice@example.test', 'Alice')
  bob = await new Client(server).signUp('shared-bob@example.test', 'Bob')
}, 60000)
afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => endpoint.close(() => resolve()))
})

interface Status {
  kind: string
  enabled: boolean
  model?: string
  shared?: true
  custom?: { name: string; baseUrl: string; headerNames: string[]; hasKey: boolean; models: { id: string }[] }
}
interface View {
  accounts: Status[]
  default?: string
  menus: Record<string, { id: string }[]>
}
interface AdminView {
  providers: { kind: string; enabled: boolean; custom: NonNullable<Status['custom']> }[]
  customProviders: boolean
}

const KEY = 'sk-shared-test-never-echoed'
const HEADER = 'tenant-shared-secret-never-echoed'
const KEY_ELSEWHERE = 'sk-shared-elsewhere-never-echoed'
const provider = {
  name: 'Acme Gateway',
  apiType: 'openai-chat',
  models: [
    { id: 'qwen3-coder', vision: true },
    { id: 'glm-5', vision: false },
  ],
}

async function read<T>(response: Response): Promise<T> {
  const text = await response.text()
  bodies.push(text)
  return JSON.parse(text) as T
}
const view = async (client: Client) => read<View>(await client.get('/api/model-account'))
const sharedOf = (v: View) => v.accounts.find((account) => account.shared)

let kind = ''

describe('the admin routes', () => {
  it('are not there for anyone else, the way every admin route is not', async () => {
    const somewhere = 'custom:0123456789abcdef01'
    const attempts = [
      alice.get('/api/admin/shared-providers'),
      alice.post('/api/admin/shared-providers', { ...provider, baseUrl: base }),
      alice.put(`/api/admin/shared-providers/${somewhere}`, { ...provider, baseUrl: base }),
      alice.patch(`/api/admin/shared-providers/${somewhere}`, { enabled: false }),
      alice.delete(`/api/admin/shared-providers/${somewhere}`),
      alice.post('/api/admin/shared-providers/models', { apiType: 'openai-chat', baseUrl: base }),
      alice.post('/api/admin/shared-providers/test', { ...provider, baseUrl: base }),
    ]
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(404)
    /* and nothing reached the endpoint */
    expect(seen).toEqual([])
  })

  it('start empty', async () => {
    expect(await read<AdminView>(await boss.get('/api/admin/shared-providers'))).toEqual({
      providers: [],
      customProviders: true,
    })
  })

  it('refuse what does not hold, saying why', async () => {
    const bad = await boss.post('/api/admin/shared-providers', { ...provider, baseUrl: base, models: [] })
    expect(bad.status).toBe(400)
    expect((await read<{ error: string }>(bad)).error).toContain('at least one model')
    expect((await boss.post('/api/admin/shared-providers', { ...provider, baseUrl: 'ftp://x' })).status).toBe(400)
    expect(
      (await boss.post('/api/admin/shared-providers', { ...provider, baseUrl: base, headers: { Host: 'x' } })).status,
    ).toBe(400)
    expect((await boss.put('/api/admin/shared-providers/openai-key', { ...provider, baseUrl: base })).status).toBe(400)
    const gone = 'custom:fedcba98765432100f'
    expect((await boss.put(`/api/admin/shared-providers/${gone}`, { ...provider, baseUrl: base })).status).toBe(404)
    expect((await boss.patch(`/api/admin/shared-providers/${gone}`, { enabled: false })).status).toBe(404)
    expect((await boss.patch(`/api/admin/shared-providers/${gone}`, { enabled: 'no' })).status).toBe(400)
    expect((await boss.delete(`/api/admin/shared-providers/${gone}`)).status).toBe(404)
  })

  it('list an endpoint’s models and test it before anything is saved', async () => {
    const listed = await boss.post('/api/admin/shared-providers/models', {
      apiType: 'openai-chat',
      baseUrl: base,
      apiKey: KEY,
    })
    expect(await read(listed)).toEqual({ models: ['qwen3-coder', 'glm-5'] })
    expect(seen.at(-1)).toEqual({ url: '/v1/models', authorization: `Bearer ${KEY}` })
    const tested = await boss.post('/api/admin/shared-providers/test', { ...provider, baseUrl: base, apiKey: KEY })
    expect(await read(tested)).toEqual({ ok: true, model: 'qwen3-coder' })
  })

  it('add a provider, telling even the admin only that a key is set', async () => {
    const added = await read<AdminView>(
      await boss.post('/api/admin/shared-providers', {
        ...provider,
        baseUrl: base,
        apiKey: KEY,
        headers: { 'X-Tenant': HEADER },
      }),
    )
    expect(added.providers).toHaveLength(1)
    const [shared] = added.providers
    expect(shared).toMatchObject({
      enabled: true,
      custom: { name: 'Acme Gateway', baseUrl: base, headerNames: ['X-Tenant'], hasKey: true },
    })
    kind = shared!.kind
    expect(kind).toMatch(/^custom:[a-f0-9]{18}$/)
  })
})

describe('a person', () => {
  it('sees it at once, read-only, as the default when they have nothing of their own', async () => {
    const v = await view(alice)
    expect(v.accounts).toHaveLength(1)
    expect(sharedOf(v)).toMatchObject({
      kind,
      shared: true,
      enabled: true,
      model: 'qwen3-coder',
      /* the origin only, and nothing about headers */
      custom: { name: 'Acme Gateway', baseUrl: new URL(base).origin, headerNames: [], hasKey: true },
    })
    expect(v.default).toBe(kind)
    expect(v.menus[kind]?.map((m) => m.id)).toEqual(['qwen3-coder', 'glm-5'])
    const runners = await read<{ runners: { provider: string; shared?: boolean }[]; default?: string }>(
      await alice.get('/api/agent-runners'),
    )
    expect(runners.runners).toEqual([expect.objectContaining({ provider: kind, name: 'Acme Gateway', shared: true })])
    expect(runners.default).toBe(kind)
    /* the company's model carries the agent: the free tier stops counting */
    expect(await read(await alice.get('/api/agent-allowance'))).toMatchObject({
      byoModel: true,
      byoName: 'Acme Gateway',
    })
  })

  it('picks a model and switches it off for themselves only', async () => {
    expect((await alice.patch(`/api/model-account/${kind}`, { model: 'not-listed' })).status).toBe(400)
    expect(
      sharedOf(await read<View>(await alice.patch(`/api/model-account/${kind}`, { model: 'glm-5' }))),
    ).toMatchObject({
      model: 'glm-5',
    })
    expect(
      sharedOf(await read<View>(await alice.patch(`/api/model-account/${kind}`, { enabled: false }))),
    ).toMatchObject({ enabled: false, model: 'glm-5' })
    /* Bob, and the definition, are untouched */
    expect(sharedOf(await view(bob))).toMatchObject({ enabled: true, model: 'qwen3-coder' })
    const admin = await read<AdminView>(await boss.get('/api/admin/shared-providers'))
    expect(admin.providers[0]).toMatchObject({ enabled: true, custom: { models: provider.models } })
    expect((await alice.patch(`/api/model-account/${kind}`, { enabled: true })).status).toBe(200)
  })

  it('makes it the default like any connection', async () => {
    const res = await alice.put('/api/agent-runners/default', { provider: kind })
    expect(res.status).toBe(200)
    expect((await read<View>(res)).default).toBe(kind)
  })

  it('cannot edit or remove it', async () => {
    const removed = await alice.delete(`/api/model-account/${kind}`)
    expect(removed.status).toBe(403)
    expect(await read(removed)).toEqual({ error: 'that provider is shared by your admin' })
    const edited = await alice.put(`/api/custom-providers/${kind}`, { ...provider, baseUrl: 'https://evil.example/v1' })
    expect(edited.status).toBe(403)
    expect(sharedOf(await view(alice))).toMatchObject({ kind, custom: { baseUrl: new URL(base).origin } })
  })

  it('cannot send its key anywhere through the set-up probes', async () => {
    const before = seen.length
    const listed = await alice.post('/api/custom-providers/models', { apiType: 'openai-chat', baseUrl: base, kind })
    expect(listed.status).toBe(200)
    await alice.post('/api/custom-providers/test', { ...provider, baseUrl: base, kind })
    const probes = seen.slice(before)
    expect(probes.length).toBeGreaterThan(0)
    for (const probe of probes) {
      expect(probe.authorization).toBeUndefined()
      expect(probe.tenant).toBeUndefined()
    }
  })

  it('keeps a personal provider of the same name apart from the shared one', async () => {
    const own = await read<View>(
      await bob.post('/api/custom-providers', { ...provider, baseUrl: base, apiKey: 'sk-bob-own-key' }),
    )
    const customs = own.accounts.filter((account) => account.kind.startsWith('custom:'))
    expect(customs.map((account) => [account.custom?.name, account.shared ?? false])).toEqual([
      ['Acme Gateway', false],
      ['Acme Gateway', true],
    ])
    expect(new Set(customs.map((account) => account.kind)).size).toBe(2)
    /* his own one, connected by him, is the default now */
    expect(own.default).toBe(customs[0]?.kind)
  })
})

describe('the admin, again', () => {
  it('edits it without the key, which keeps the key', async () => {
    const edited = await read<AdminView>(
      await boss.put(`/api/admin/shared-providers/${kind}`, { ...provider, name: 'Acme Gateway (EU)', baseUrl: base }),
    )
    expect(edited.providers[0]?.custom).toMatchObject({
      name: 'Acme Gateway (EU)',
      hasKey: true,
      headerNames: ['X-Tenant'],
    })
    /* the stored key and headers still reach the endpoint */
    await boss.post('/api/admin/shared-providers/models', { apiType: 'openai-chat', baseUrl: base, kind })
    expect(seen.at(-1)).toEqual({ url: '/v1/models', authorization: `Bearer ${KEY}`, tenant: HEADER })
    expect(sharedOf(await view(alice))?.custom?.name).toBe('Acme Gateway (EU)')
  })

  it('never sends the saved key or headers to another address', async () => {
    /* the same endpoint under another origin: reachable, and not where they were saved for */
    const elsewhere = base.replace('127.0.0.1', 'localhost')
    const before = seen.length
    const probe = await boss.post('/api/admin/shared-providers/models', {
      apiType: 'openai-chat',
      baseUrl: elsewhere,
      kind,
    })
    expect(probe.status).toBe(400)
    expect((await read<{ error: string }>(probe)).error).toContain('saved key is only sent')
    const tested = await boss.post('/api/admin/shared-providers/test', { ...provider, baseUrl: elsewhere, kind })
    expect(tested.status).toBe(400)
    expect(seen.length).toBe(before)

    const moved = await boss.put(`/api/admin/shared-providers/${kind}`, { ...provider, baseUrl: elsewhere })
    expect(moved.status).toBe(400)
    expect((await read<{ error: string }>(moved)).error).toContain('saved key is only sent')
    /* the key alone is not enough while the headers would still go along */
    const keyOnly = await boss.put(`/api/admin/shared-providers/${kind}`, {
      ...provider,
      baseUrl: elsewhere,
      apiKey: KEY_ELSEWHERE,
    })
    expect(keyOnly.status).toBe(400)
    expect((await read<{ error: string }>(keyOnly)).error).toContain('saved headers are only sent')
    const unchanged = await read<AdminView>(await boss.get('/api/admin/shared-providers'))
    expect(unchanged.providers[0]?.custom).toMatchObject({ baseUrl: base, hasKey: true, headerNames: ['X-Tenant'] })

    /* a move that brings its own key and says "no headers" goes through */
    const moving = await read<AdminView>(
      await boss.put(`/api/admin/shared-providers/${kind}`, {
        ...provider,
        baseUrl: elsewhere,
        apiKey: KEY_ELSEWHERE,
        headers: {},
      }),
    )
    expect(moving.providers[0]?.custom).toMatchObject({ baseUrl: elsewhere, hasKey: true, headerNames: [] })
    await boss.post('/api/admin/shared-providers/models', { apiType: 'openai-chat', baseUrl: elsewhere, kind })
    expect(seen.at(-1)).toEqual({ url: '/v1/models', authorization: `Bearer ${KEY_ELSEWHERE}` })
  })

  it('switches it off, and it is gone for everyone until it is back on, picks kept', async () => {
    expect((await boss.patch(`/api/admin/shared-providers/${kind}`, { enabled: false })).status).toBe(200)
    const v = await view(alice)
    expect(sharedOf(v)).toBeUndefined()
    expect(v.default).toBeUndefined()
    expect((await alice.patch(`/api/model-account/${kind}`, { model: 'qwen3-coder' })).status).toBe(400)
    expect((await read<{ runners: unknown[] }>(await alice.get('/api/agent-runners'))).runners).toEqual([])
    expect(await read(await alice.get('/api/agent-allowance'))).toMatchObject({ byoModel: false })

    expect((await boss.patch(`/api/admin/shared-providers/${kind}`, { enabled: true })).status).toBe(200)
    expect(sharedOf(await view(alice))).toMatchObject({ kind, model: 'glm-5' })
  })

  it('removes it for everyone', async () => {
    const removed = await read<AdminView>(await boss.delete(`/api/admin/shared-providers/${kind}`))
    expect(removed.providers).toEqual([])
    expect(sharedOf(await view(alice))).toBeUndefined()
    expect(sharedOf(await view(bob))).toBeUndefined()
    expect((await alice.patch(`/api/model-account/${kind}`, { enabled: true })).status).toBe(400)
  })
})

it('never sent the key or a header value back in any response', () => {
  expect(bodies.length).toBeGreaterThan(20)
  for (const body of bodies) {
    expect(body).not.toContain(KEY)
    expect(body).not.toContain(KEY_ELSEWHERE)
    expect(body).not.toContain(HEADER)
  }
})
