import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

let server: Server
let alice: Client
let bob: Client
beforeAll(async () => {
  server = await startServer(4396, { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', DATABASE_URL: '', SMTP_HOST: '' })
  alice = await new Client(server).signUp('roster-alice@example.test', 'Alice')
  bob = await new Client(server).signUp('roster-bob@example.test', 'Bob')
}, 60000)
afterAll(() => server?.stop())

it('stores an OpenRouter key privately, validates its roster, and serves the per-kind menus', async () => {
  /* the menus ride every account response, keyed by kind, with vision flags */
  const before = await (await alice.get('/api/model-account')).json()
  expect(before.menus['openrouter-key'].length).toBeGreaterThan(5)
  expect(before.menus['openrouter-key'].some((m: { vision: boolean }) => m.vision === false)).toBe(true)
  expect(before.menus['gemini-key'].every((m: { vision: boolean }) => m.vision === true)).toBe(true)

  expect((await alice.post('/api/model-account/openrouter-key', { apiKey: 'sk-wrong-prefix' })).status).toBe(400)
  const key = 'sk-or-test-only-never-sent-anywhere'
  await alice.req('/api/local-agent', { method: 'PUT', body: JSON.stringify({ enabled: true, model: 'opus' }) })
  const response = await alice.post('/api/model-account/openrouter-key', { apiKey: key })
  expect(response.status).toBe(200)
  const status = await response.json()
  expect(status).toMatchObject({ connected: true, kind: 'openrouter-key', model: 'moonshotai/kimi-k2.6' })
  expect(JSON.stringify(status)).not.toContain(key)
  /* connecting a server-side account switches the local CLI preference off */
  expect(await (await alice.get('/api/local-agent')).json()).toMatchObject({ enabled: false })
  expect(await (await bob.get('/api/model-account')).json()).toMatchObject({ connected: false })

  /* the picker only accepts this kind's curated ids */
  expect((await alice.patch('/api/model-account', { model: 'gpt-5.6-sol' })).status).toBe(400)
  expect((await alice.patch('/api/model-account', { model: 'claude-opus-5' })).status).toBe(400)
  expect((await alice.patch('/api/model-account', { model: 'z-ai/glm-5.3' })).status).toBe(200)
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ model: 'z-ai/glm-5.3' })

  /* rotation keeps the chosen model; a failed rotation changes nothing */
  expect((await alice.post('/api/model-account/openrouter-key', { apiKey: 'nope' })).status).toBe(400)
  const rotated = await alice.post('/api/model-account/openrouter-key', { apiKey: 'sk-or-rotated-test-key' })
  expect(await rotated.json()).toMatchObject({ connected: true, model: 'z-ai/glm-5.3' })
})

it('stores a Gemini key and resets the model on a provider switch', async () => {
  expect((await alice.post('/api/model-account/gemini-key', { apiKey: 'has spaces' })).status).toBe(400)
  expect((await alice.post('/api/model-account/gemini-key', { apiKey: 'short' })).status).toBe(400)
  const response = await alice.post('/api/model-account/gemini-key', { apiKey: 'AIzaTestKeyLongEnoughToPass123456' })
  expect(response.status).toBe(200)
  /* switching providers resets the model to the new kind's default */
  const status = await response.json()
  expect(status).toMatchObject({ connected: true, kind: 'gemini-key', model: 'gemini-3.7-flash' })
  expect(JSON.stringify(status)).not.toContain('AIzaTestKeyLongEnoughToPass123456')
  expect((await alice.patch('/api/model-account', { model: 'gemini-3.1-pro-preview' })).status).toBe(200)
  expect((await alice.delete('/api/model-account')).status).toBe(200)
})

it('validates image-model picks against the registry and this user’s credentials', async () => {
  /* nothing connected, no server keys in this harness: every entry is
     visible but unavailable, and picking one is refused */
  const { models } = await (await bob.get('/api/image-model')).json()
  expect(models.length).toBeGreaterThanOrEqual(3)
  expect(models.every((m: { available: boolean }) => !m.available)).toBe(true)
  expect((await bob.req('/api/image-model', { method: 'PUT', body: JSON.stringify({ model: 'nope' }) })).status).toBe(
    400,
  )
  expect(
    (await bob.req('/api/image-model', { method: 'PUT', body: JSON.stringify({ model: 'seedream-5-0-pro' }) })).status,
  ).toBe(400)

  /* a Gemini key makes the Gemini entry pickable, and the pick sticks */
  await bob.post('/api/model-account/gemini-key', { apiKey: 'AIzaBobsTestKeyLongEnough123456' })
  const put = await bob.req('/api/image-model', {
    method: 'PUT',
    body: JSON.stringify({ model: 'gemini-3.1-flash-image' }),
  })
  expect(put.status).toBe(200)
  const after = await (await bob.get('/api/image-model')).json()
  expect(after.models.find((m: { id: string }) => m.id === 'gemini-3.1-flash-image')).toMatchObject({
    available: true,
    selected: true,
  })
})
