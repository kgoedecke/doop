import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/**
 * A connected API key's model menu comes from the provider's own catalog,
 * asked with that key, so a model released after the curated list was
 * written is on the menu without a code change. One fake provider stands in
 * for all three catalogs and pins: pagination, the family filters, the
 * curated-first merge, that a discovered id can be chosen and then runs as
 * itself, and the curated fallback when a provider is down or rejects the key.
 */

const ANTHROPIC_PAGE_ONE = {
  data: [
    {
      id: 'claude-sonnet-5',
      display_name: 'Claude Sonnet 5',
      created_at: '2026-05-01T00:00:00Z',
      max_tokens: 64000,
      capabilities: { image_input: { supported: true } },
      type: 'model',
    },
    {
      id: 'claude-opus-5-20260901',
      display_name: 'Claude Opus 5 (September)',
      created_at: '2026-09-01T00:00:00Z',
      max_tokens: 64000,
      capabilities: { image_input: { supported: true } },
      type: 'model',
    },
    /* text-only: out */
    {
      id: 'claude-ledger-5',
      display_name: 'Claude Ledger 5',
      created_at: '2026-08-01T00:00:00Z',
      max_tokens: 64000,
      capabilities: { image_input: { supported: false } },
      type: 'model',
    },
    /* too small an output window for a turn: out */
    {
      id: 'claude-haiku-4-5-20251001',
      display_name: 'Claude Haiku 4.5',
      created_at: '2025-10-01T00:00:00Z',
      max_tokens: 8192,
      capabilities: { image_input: { supported: true } },
      type: 'model',
    },
  ],
  has_more: true,
  first_id: 'claude-sonnet-5',
  last_id: 'claude-haiku-4-5-20251001',
}

const ANTHROPIC_PAGE_TWO = {
  data: [
    {
      id: 'claude-fable-5-1',
      display_name: 'Claude Fable 5.1',
      created_at: '2026-10-01T00:00:00Z',
      max_tokens: 64000,
      capabilities: null,
      type: 'model',
    },
    /* not a Claude model id: out */
    { id: 'voyage-4', display_name: 'Voyage 4', created_at: '2026-01-01T00:00:00Z', max_tokens: null, type: 'model' },
  ],
  has_more: false,
  first_id: 'claude-fable-5-1',
  last_id: 'voyage-4',
}

const OPENAI_PAGE = {
  object: 'list',
  data: [
    { id: 'gpt-5.6-terra', object: 'model', created: 1_780_000_000, owned_by: 'system' },
    { id: 'gpt-6.1-sol', object: 'model', created: 1_790_000_000, owned_by: 'system' },
    { id: 'gpt-6-astra', object: 'model', created: 1_785_000_000, owned_by: 'system' },
    { id: 'o4-mini', object: 'model', created: 1_745_000_000, owned_by: 'system' },
    /* not chat models the agent could drive: out */
    { id: 'gpt-image-2', object: 'model', created: 1_786_000_000, owned_by: 'system' },
    /* no reasoning block, which every turn sends: out */
    { id: 'gpt-4.1', object: 'model', created: 1_786_000_000, owned_by: 'system' },
    { id: 'gpt-4o-2024-11-20', object: 'model', created: 1_786_000_000, owned_by: 'system' },
    { id: 'gpt-6-chat-latest', object: 'model', created: 1_786_000_000, owned_by: 'system' },
    { id: 'gpt-6-realtime', object: 'model', created: 1_786_000_000, owned_by: 'system' },
    { id: 'text-embedding-4', object: 'model', created: 1_786_000_000, owned_by: 'system' },
    { id: 'whisper-2', object: 'model', created: 1_786_000_000, owned_by: 'system' },
  ],
}

const GEMINI_PAGE_ONE = {
  models: [
    {
      name: 'models/gemini-3.7-flash',
      displayName: 'Gemini 3.7 Flash',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
      outputTokenLimit: 65536,
    },
    {
      name: 'models/gemini-4-argon',
      displayName: 'Gemini 4 Argon',
      supportedGenerationMethods: ['generateContent'],
      outputTokenLimit: 65536,
    },
    /* image generation, embeddings, no generateContent: out */
    {
      name: 'models/gemini-3.1-flash-image',
      displayName: 'Nano Banana 2',
      supportedGenerationMethods: ['generateContent'],
    },
    { name: 'models/gemini-embedding-2', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.7-flash-tts', displayName: 'TTS', supportedGenerationMethods: ['generateContent'] },
  ],
  nextPageToken: 'page-2',
}

const GEMINI_PAGE_TWO = {
  models: [
    /* too small an output window: out */
    {
      name: 'models/gemini-2.0-flash-lite',
      displayName: 'Gemini 2.0 Flash-Lite',
      supportedGenerationMethods: ['generateContent'],
      outputTokenLimit: 8192,
    },
  ],
}

let mode: 'catalog' | 'down' | 'rejects' = 'catalog'
const seen: { path: string; auth: string }[] = []

let provider: http.Server
let server: Server
let alice: Client

const ids = (catalog: { models: { id: string }[] }) => catalog.models.map((m) => m.id)

beforeAll(async () => {
  provider = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    seen.push({
      path: url.pathname + url.search,
      auth: String(req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? req.headers.authorization ?? ''),
    })
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (mode === 'down') return json(500, { error: 'boom' })
    if (mode === 'rejects') return json(401, { error: { type: 'authentication_error' } })
    switch (url.pathname) {
      case '/v1/models':
        return json(200, url.searchParams.get('after_id') ? ANTHROPIC_PAGE_TWO : ANTHROPIC_PAGE_ONE)
      case '/openai/v1/models':
        return json(200, OPENAI_PAGE)
      case '/gemini/v1beta/models':
        return json(200, url.searchParams.get('pageToken') ? GEMINI_PAGE_TWO : GEMINI_PAGE_ONE)
      default:
        return json(404, {})
    }
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`
  server = await startServer({
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BASE_URL: base,
    OPENAI_API_KEY: '',
    OPENAI_MODELS_URL: `${base}/openai/v1/models`,
    GEMINI_MODELS_URL: `${base}/gemini/v1beta/models`,
    DATABASE_URL: '',
    SMTP_HOST: '',
  })
  alice = await new Client(server).signUp('catalog-alice@example.test', 'Alice')
}, 60000)

afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
})

it('serves nothing until an account is connected', async () => {
  expect(await (await alice.get('/api/model-account/models')).json()).toEqual({ models: [], live: false })
})

it('Claude API: lists the models the key can run, curated first, and lets a discovered one be chosen', async () => {
  const key = 'sk-ant-catalog-test-key'
  expect((await alice.post('/api/model-account/anthropic-key', { apiKey: key })).status).toBe(200)

  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(true)
  expect(catalog.error).toBeUndefined()
  expect(ids(catalog)).toEqual([
    /* curated entries the provider confirmed, in curated order */
    'claude-fable-5-1',
    'claude-sonnet-5',
    /* then what the provider has that the curated list does not, newest first */
    'claude-opus-5-20260901',
  ])
  const [fable, sonnet, opus] = catalog.models
  /* a curated entry keeps its own name and blurb and is flagged recommended */
  expect(fable).toMatchObject({ name: 'Fable 5.1', recommended: true, vision: true })
  expect(sonnet.blurb).not.toBe('')
  /* a discovered entry wears the provider's display name */
  expect(opus).toMatchObject({ name: 'Claude Opus 5 (September)', blurb: '', vision: true })
  expect(opus.recommended).toBeUndefined()
  /* the SDK paged through with the connected key, and the key never came back */
  expect(seen.some((r) => r.path.includes('after_id=claude-haiku-4-5-20251001'))).toBe(true)
  expect(seen.every((r) => r.auth === key)).toBe(true)
  expect(JSON.stringify(catalog)).not.toContain(key)

  /* choosing a discovered id runs as that id, not the curated default */
  expect((await alice.patch('/api/model-account', { model: 'claude-opus-5-20260901' })).status).toBe(200)
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ model: 'claude-opus-5-20260901' })
  /* an id that is not shaped like a Claude model is still refused */
  expect((await alice.patch('/api/model-account', { model: 'gpt-5.6-sol' })).status).toBe(400)
  expect((await alice.patch('/api/model-account', { model: 'claude-' })).status).toBe(400)
})

it('falls back to the curated menu when the provider is down, and says so', async () => {
  mode = 'down'
  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(false)
  expect(catalog.error).toMatch(/could not load models from Claude API/i)
  expect(ids(catalog)).toContain('claude-sonnet-5')
  expect(catalog.models.every((m: { recommended?: boolean }) => m.recommended === undefined)).toBe(true)
})

it('tells the user to reconnect when the provider rejects the key', async () => {
  mode = 'rejects'
  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(false)
  expect(catalog.error).toMatch(/rejected the connected key/i)
  mode = 'catalog'
})

it('OpenAI: lists the GPT and o-series chat families, newest first after the curated tiers', async () => {
  seen.length = 0
  await alice.post('/api/model-account/openai-key', { apiKey: 'sk-openai-test' })
  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(true)
  expect(ids(catalog)).toEqual(['gpt-6-astra', 'gpt-5.6-terra', 'gpt-6.1-sol', 'o4-mini'])
  expect(catalog.models[2]).toMatchObject({ name: 'GPT-6.1-sol', vision: true })
  expect(seen.map((r) => r.auth)).toEqual(['Bearer sk-openai-test'])
  expect((await alice.patch('/api/model-account', { model: 'gpt-6.1-sol' })).status).toBe(200)
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ model: 'gpt-6.1-sol' })
  expect((await alice.patch('/api/model-account', { model: 'claude-opus-5' })).status).toBe(400)
  expect((await alice.patch('/api/model-account', { model: 'gpt-4.1' })).status).toBe(400)
})

it('Gemini: pages through the catalog and keeps the generateContent models with room for a turn', async () => {
  seen.length = 0
  await alice.post('/api/model-account/gemini-key', { apiKey: 'AIzaSyGeminiTestKey0123456789abcdefghij' })
  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(true)
  expect(ids(catalog)).toEqual(['gemini-3.7-flash', 'gemini-4-argon'])
  expect(catalog.models[0]).toMatchObject({ recommended: true, vision: true })
  expect(catalog.models[1]).toMatchObject({ name: 'Gemini 4 Argon', vision: true })
  expect(seen.map((r) => r.path)).toEqual([
    '/gemini/v1beta/models?pageSize=1000',
    '/gemini/v1beta/models?pageSize=1000&pageToken=page-2',
  ])
  expect((await alice.patch('/api/model-account', { model: 'gemini-4-argon' })).status).toBe(200)
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ model: 'gemini-4-argon' })
})

it('keeps the curated roster, and no catalog call, for OpenRouter', async () => {
  seen.length = 0
  await alice.post('/api/model-account/openrouter-key', { apiKey: 'sk-or-v1-openroutertestkey' })
  const catalog = await (await alice.get('/api/model-account/models')).json()
  expect(catalog.live).toBe(false)
  expect(catalog.error).toBeUndefined()
  expect(ids(catalog)).toContain('moonshotai/kimi-k2.6')
  expect(catalog.models.some((m: { vision: boolean }) => m.vision === false)).toBe(true)
  expect((await alice.patch('/api/model-account', { model: 'acme/designer-9' })).status).toBe(400)
  expect(seen).toEqual([])
})
