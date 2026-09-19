import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

let server: Server
let alice: Client
let bob: Client
beforeAll(async () => {
  server = await startServer(4397, { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', DATABASE_URL: '', SMTP_HOST: '' })
  alice = await new Client(server).signUp('claude-alice@example.test', 'Alice')
  bob = await new Client(server).signUp('claude-bob@example.test', 'Bob')
}, 60000)
afterAll(() => server?.stop())

it('stores a Claude key privately, switches off local execution, and validates provider models', async () => {
  await alice.post('/api/model-account/openai-key', { apiKey: 'sk-previous' })
  await alice.req('/api/local-agent', { method: 'PUT', body: JSON.stringify({ enabled: true, model: 'opus' }) })
  expect(await (await alice.get('/api/local-agent')).json()).toMatchObject({ enabled: true })
  const key = 'sk-ant-test-only-never-sent-to-anthropic'
  const response = await alice.post('/api/model-account/anthropic-key', { apiKey: key })
  expect(response.status).toBe(200)
  const status = await response.json()
  expect(status).toMatchObject({ connected: true, kind: 'anthropic-key', model: 'claude-sonnet-5' })
  expect(await (await alice.get('/api/local-agent')).json()).toMatchObject({ enabled: false })
  expect(JSON.stringify(status)).not.toContain(key)
  expect(await (await bob.get('/api/model-account')).json()).toMatchObject({ connected: false })
  expect((await alice.patch('/api/model-account', { model: 'gpt-5.6-sol' })).status).toBe(400)
  expect((await alice.patch('/api/model-account', { model: 'claude-opus-5' })).status).toBe(200)
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ model: 'claude-opus-5' })
  expect((await alice.post('/api/model-account/anthropic-key', { apiKey: 'invalid' })).status).toBe(400)
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ model: 'claude-opus-5' })
  const rotated = await alice.post('/api/model-account/anthropic-key', { apiKey: 'sk-ant-rotated-test-key' })
  expect(rotated.status).toBe(200)
  const rotatedStatus = await rotated.json()
  expect(rotatedStatus).toMatchObject({ connected: true, kind: 'anthropic-key', model: 'claude-opus-5' })
  expect(JSON.stringify(rotatedStatus)).not.toContain('sk-ant-rotated-test-key')
  expect(rotatedStatus).not.toHaveProperty('workspaceId')
  expect((await alice.delete('/api/model-account')).status).toBe(200)
  expect(await (await alice.get('/api/model-account')).json()).toMatchObject({ connected: false })
})
