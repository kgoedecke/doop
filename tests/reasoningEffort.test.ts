import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'
import { REASONING_EFFORT_OPTIONS, reasoningEffortOptions } from '../shared/modelMenu'

/**
 * How hard an OpenAI model thinks per turn is the user's call, per account:
 * the status reports the effort in effect (the server default until they
 * pick), a PATCH changes it, only the OpenAI kinds take one, a rotation keeps
 * it and a provider switch resets it.
 */

let server: Server
let alice: Client
beforeAll(async () => {
  server = await startServer({
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    DATABASE_URL: '',
    SMTP_HOST: '',
    DOOP_AGENT_OPENAI_EFFORT: 'medium',
  })
  alice = await new Client(server).signUp('effort-alice@example.test', 'Alice')
}, 60000)
afterAll(() => server?.stop())

it('starts on the server default, takes a pick, and keeps it across a key rotation', async () => {
  expect((await alice.patch('/api/model-account', { effort: 'high' })).status).toBe(400)
  const connected = await (await alice.post('/api/model-account/openai-key', { apiKey: 'sk-effort-test' })).json()
  expect(connected).toMatchObject({ connected: true, kind: 'openai-key', effort: 'medium' })

  const picked = await alice.patch('/api/model-account', { effort: 'high' })
  expect(picked.status).toBe(200)
  expect(await picked.json()).toMatchObject({ model: 'gpt-5.6-terra', effort: 'high' })
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ effort: 'high' })

  /* a model pick leaves the effort alone, and the other way round */
  expect((await alice.patch('/api/model-account', { model: 'gpt-6-astra' })).status).toBe(200)
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ model: 'gpt-6-astra', effort: 'high' })

  for (const effort of ['none', 'max', 'HIGH', '', 42]) {
    expect((await alice.patch('/api/model-account', { effort })).status, String(effort)).toBe(400)
  }
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ effort: 'high' })

  const rotated = await (await alice.post('/api/model-account/openai-key', { apiKey: 'sk-effort-rotated' })).json()
  expect(rotated).toMatchObject({ model: 'gpt-6-astra', effort: 'high' })
})

it('is not a dial the other providers have', async () => {
  const claude = await (await alice.post('/api/model-account/anthropic-key', { apiKey: 'sk-ant-effort-test' })).json()
  expect(claude).toMatchObject({ connected: true, kind: 'anthropic-key' })
  expect(claude).not.toHaveProperty('effort')
  expect((await alice.patch('/api/model-account', { effort: 'high' })).status).toBe(400)

  /* coming back to OpenAI starts over on the default, like the model does */
  const back = await (await alice.post('/api/model-account/openai-key', { apiKey: 'sk-effort-back' })).json()
  expect(back).toMatchObject({ model: 'gpt-5.6-terra', effort: 'medium' })
})

it('reports a server default outside the four, which the pickers then show as its own item', async () => {
  const strict = await startServer({
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    DATABASE_URL: '',
    SMTP_HOST: '',
    DOOP_AGENT_OPENAI_EFFORT: 'max',
  })
  try {
    const bob = await new Client(strict).signUp('effort-bob@example.test', 'Bob')
    const status = await (await bob.post('/api/model-account/openai-key', { apiKey: 'sk-effort-max' })).json()
    expect(status).toMatchObject({ effort: 'max' })
    /* the operator's default is not a pick the user may make … */
    expect((await bob.patch('/api/model-account', { effort: 'max' })).status).toBe(400)
    /* … but it is what runs, so the pickers list it, selected, after the four */
    expect(reasoningEffortOptions('max').map((o) => o.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(reasoningEffortOptions('high')).toBe(REASONING_EFFORT_OPTIONS)
  } finally {
    await strict.stop()
  }
}, 60000)
