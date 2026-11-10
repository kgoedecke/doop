import { afterAll, beforeAll, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client, startServer, type Server } from './harness'

/**
 * Custom providers end to end: added, listed, edited, picked and removed
 * through the account routes, against a fake OpenAI-compatible endpoint on
 * loopback (which needs the operator's private-hosts switch). The key and
 * header values go in and never come back out.
 */

let server: Server
let alice: Client
let bob: Client
let endpoint: http.Server
let base = ''
const seen: { url: string; authorization?: string; tenant?: string }[] = []

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
    DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS: 'true',
  })
  alice = await new Client(server).signUp('custom-alice@example.test', 'Alice')
  bob = await new Client(server).signUp('custom-bob@example.test', 'Bob')
}, 60000)
afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => endpoint.close(() => resolve()))
})

interface Status {
  kind: string
  enabled: boolean
  model?: string
  custom?: { name: string; baseUrl: string; headerNames: string[]; hasKey: boolean; models: { id: string }[] }
}
interface View {
  accounts: Status[]
  default?: string
  menus: Record<string, { id: string; vision: boolean }[]>
  customProviders: boolean
}

const KEY = 'sk-custom-test-never-echoed'
const HEADER = 'tenant-secret-never-echoed'
const provider = {
  name: 'Acme Gateway',
  apiType: 'openai-chat',
  models: [
    { id: 'qwen3-coder', vision: true, maxOutputTokens: 8000 },
    { id: 'glm-5', vision: false },
  ],
}

const customOf = (view: View) => view.accounts.find((a) => a.kind.startsWith('custom:'))

it('lists the endpoint’s models and tests a tool call before anything is saved', async () => {
  const listed = await alice.post('/api/custom-providers/models', {
    apiType: 'openai-chat',
    baseUrl: base,
    apiKey: KEY,
  })
  expect(listed.status).toBe(200)
  expect(await listed.json()).toEqual({ models: ['qwen3-coder', 'glm-5'] })
  expect(seen.at(-1)).toEqual({ url: '/v1/models', authorization: `Bearer ${KEY}` })

  const tested = await alice.post('/api/custom-providers/test', { ...provider, baseUrl: base, apiKey: KEY })
  expect(await tested.json()).toEqual({ ok: true, model: 'qwen3-coder' })
  expect(seen.at(-1)?.url).toBe('/v1/chat/completions')
})

it('adds a provider that runs like any other connection, without ever echoing its secrets', async () => {
  const response = await alice.post('/api/custom-providers', {
    ...provider,
    baseUrl: base,
    apiKey: KEY,
    headers: { 'X-Tenant': HEADER },
  })
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).not.toContain(KEY)
  expect(text).not.toContain(HEADER)
  const view = JSON.parse(text) as View
  const account = customOf(view)!
  expect(account).toMatchObject({
    enabled: true,
    model: 'qwen3-coder',
    custom: { name: 'Acme Gateway', baseUrl: base, headerNames: ['X-Tenant'], hasKey: true },
  })
  expect(view.default).toBe(account.kind)
  expect(view.menus[account.kind]).toEqual([
    { id: 'qwen3-coder', name: 'qwen3-coder', blurb: '', vision: true },
    { id: 'glm-5', name: 'glm-5', blurb: '', vision: false },
  ])
  expect(await (await bob.get('/api/model-account')).json()).toMatchObject({ accounts: [] })

  /* the composer lists it by its name, with its own models */
  const runners = await (await alice.get('/api/agent-runners')).json()
  expect(runners.runners).toContainEqual(
    expect.objectContaining({ provider: account.kind, name: 'Acme Gateway', model: 'qwen3-coder' }),
  )
  const catalog = await (await alice.get(`/api/model-account/models?kind=${encodeURIComponent(account.kind)}`)).json()
  expect(catalog).toMatchObject({ live: true, models: [{ id: 'qwen3-coder' }, { id: 'glm-5' }] })

  /* only listed models can be picked; switching off and back works as for any account */
  const path = `/api/model-account/${encodeURIComponent(account.kind)}`
  expect((await alice.patch(path, { model: 'gpt-5.6-sol' })).status).toBe(400)
  expect(customOf(await (await alice.patch(path, { model: 'glm-5' })).json())).toMatchObject({ model: 'glm-5' })
  expect(customOf(await (await alice.patch(path, { enabled: false })).json())).toMatchObject({ enabled: false })
  expect(customOf(await (await alice.patch(path, { enabled: true })).json())).toMatchObject({ enabled: true })

  /* another person cannot edit it, nor reuse its key in a probe */
  const foreign = await bob.put(`/api/custom-providers/${encodeURIComponent(account.kind)}`, {
    ...provider,
    baseUrl: base,
  })
  expect(foreign.status).toBe(400)
  expect((await foreign.json()).error).toContain('not connected')
  await bob.post('/api/custom-providers/models', { apiType: 'openai-chat', baseUrl: base, kind: account.kind })
  expect(seen.at(-1)?.authorization).toBeUndefined()
})

it('keeps the stored key and headers on an edit unless new ones are given', async () => {
  const view = (await (await alice.get('/api/model-account')).json()) as View
  const kind = customOf(view)!.kind
  const path = `/api/custom-providers/${encodeURIComponent(kind)}`

  /* a probe on an edit uses the stored secrets when none are typed */
  await alice.post('/api/custom-providers/models', { apiType: 'openai-chat', baseUrl: base, kind })
  expect(seen.at(-1)).toMatchObject({ authorization: `Bearer ${KEY}`, tenant: HEADER })

  const renamed = (await (
    await alice.put(path, { ...provider, baseUrl: base, name: 'Acme', models: [{ id: 'kimi-k3', vision: true }] })
  ).json()) as View
  /* glm-5 is gone from the list, so the account runs on the first listed */
  expect(customOf(renamed)).toMatchObject({
    model: 'kimi-k3',
    custom: { name: 'Acme', headerNames: ['X-Tenant'], hasKey: true },
  })

  const cleared = (await (
    await alice.put(path, { ...provider, baseUrl: base, apiKey: '', headers: {} })
  ).json()) as View
  expect(customOf(cleared)).toMatchObject({ custom: { headerNames: [], hasKey: false } })
  await alice.post('/api/custom-providers/models', { apiType: 'openai-chat', baseUrl: base, kind })
  expect(seen.at(-1)?.authorization).toBeUndefined()
})

it('refuses bad descriptions and unreachable URLs with the reason', async () => {
  const bad = await alice.post('/api/custom-providers', { ...provider, baseUrl: base, models: [] })
  expect(bad.status).toBe(400)
  expect((await bad.json()).error).toContain('at least one model')
  const header = await alice.post('/api/custom-providers', { ...provider, baseUrl: base, headers: { Host: 'x' } })
  expect((await header.json()).error).toContain('Host')
  expect((await alice.post('/api/custom-providers', { ...provider, baseUrl: 'ftp://x.example' })).status).toBe(400)
})

it('disconnects it like any other account', async () => {
  const view = (await (await alice.get('/api/model-account')).json()) as View
  const kind = customOf(view)!.kind
  const after = (await (await alice.delete(`/api/model-account/${encodeURIComponent(kind)}`)).json()) as View
  expect(customOf(after)).toBeUndefined()
  expect(after.default).toBeUndefined()
})
