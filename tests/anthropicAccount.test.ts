import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

let server: Server
let alice: Client
let bob: Client
beforeAll(async () => {
  server = await startServer({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', DATABASE_URL: '', SMTP_HOST: '' })
  alice = await new Client(server).signUp('claude-alice@example.test', 'Alice')
  bob = await new Client(server).signUp('claude-bob@example.test', 'Bob')
}, 60000)
afterAll(() => server?.stop())

type View = {
  accounts: { kind: string; enabled: boolean; model?: string }[]
  default?: string
}
const view = async (client: Client): Promise<View> => (await client.get('/api/model-account')).json() as Promise<View>
const account = (v: View, kind: string) => v.accounts.find((a) => a.kind === kind)

it('stores a Claude key privately beside other connections and validates provider models', async () => {
  await alice.post('/api/model-account/openai-key', { apiKey: 'sk-previous' })
  await alice.req('/api/local-agent', { method: 'PUT', body: JSON.stringify({ enabled: true, model: 'opus' }) })
  const key = 'sk-ant-test-only-never-sent-to-anthropic'
  const response = await alice.post('/api/model-account/anthropic-key', { apiKey: key })
  expect(response.status).toBe(200)
  const connected = (await response.json()) as View
  /* connecting adds a row: nothing else is switched off or replaced */
  expect(connected.accounts.map((a) => a.kind)).toEqual(['openai-key', 'anthropic-key'])
  expect(account(connected, 'anthropic-key')).toMatchObject({ enabled: true, model: 'claude-sonnet-5' })
  expect(await (await alice.get('/api/local-agent')).json()).toMatchObject({ enabled: true })
  expect(connected.default).toBe('claude-local')
  expect(JSON.stringify(connected)).not.toContain(key)
  expect(await view(bob)).toMatchObject({ accounts: [] })
  expect((await alice.patch('/api/model-account/anthropic-key', { model: 'gpt-5.6-sol' })).status).toBe(400)
  expect((await alice.patch('/api/model-account/anthropic-key', { model: 'claude-opus-5' })).status).toBe(200)
  expect(account(await view(alice), 'anthropic-key')).toMatchObject({ model: 'claude-opus-5' })
  expect((await alice.post('/api/model-account/anthropic-key', { apiKey: 'invalid' })).status).toBe(400)
  const rotated = await alice.post('/api/model-account/anthropic-key', { apiKey: 'sk-ant-rotated-test-key' })
  expect(rotated.status).toBe(200)
  const rotatedView = (await rotated.json()) as View
  expect(account(rotatedView, 'anthropic-key')).toMatchObject({ model: 'claude-opus-5' })
  expect(JSON.stringify(rotatedView)).not.toContain('sk-ant-rotated-test-key')
  /* each account is disconnected on its own */
  expect((await alice.delete('/api/model-account/anthropic-key')).status).toBe(200)
  expect((await view(alice)).accounts.map((a) => a.kind)).toEqual(['openai-key'])
  expect((await alice.delete('/api/model-account/nope')).status).toBe(400)
})

it('switches accounts on and off and marks one connection as the default', async () => {
  const carol = await new Client(server).signUp('claude-carol@example.test', 'Carol')
  await carol.post('/api/model-account/openai-key', { apiKey: 'sk-carol' })
  await carol.post('/api/model-account/anthropic-key', { apiKey: 'sk-ant-carol-key' })
  /* no mark yet: the account connected first runs unpicked work */
  expect((await view(carol)).default).toBe('openai-key')
  const marked = await carol.req('/api/agent-runners/default', {
    method: 'PUT',
    body: JSON.stringify({ provider: 'anthropic-key' }),
  })
  expect(marked.status).toBe(200)
  expect(((await marked.json()) as View).default).toBe('anthropic-key')
  const runners = (await (await carol.get('/api/agent-runners')).json()) as {
    runners: { provider: string }[]
    default?: string
  }
  expect(runners.runners.map((r) => r.provider)).toEqual(['openai-key', 'anthropic-key'])
  expect(runners.default).toBe('anthropic-key')
  expect(await (await carol.get('/api/agent-allowance')).json()).toMatchObject({
    byoModel: true,
    byoKind: 'anthropic-key',
  })

  /* switching the default off keeps its key and hands the default on */
  const off = (await (await carol.patch('/api/model-account/anthropic-key', { enabled: false })).json()) as View
  expect(account(off, 'anthropic-key')).toMatchObject({ enabled: false })
  expect(off.default).toBe('openai-key')
  const without = (await (await carol.get('/api/agent-runners')).json()) as { runners: { provider: string }[] }
  expect(without.runners.map((r) => r.provider)).toEqual(['openai-key'])
  /* a switched-off connection cannot be made the default */
  const refused = await carol.req('/api/agent-runners/default', {
    method: 'PUT',
    body: JSON.stringify({ provider: 'anthropic-key' }),
  })
  expect(refused.status).toBe(400)
  /* back on, the mark it kept applies again */
  const on = (await (await carol.patch('/api/model-account/anthropic-key', { enabled: true })).json()) as View
  expect(on.default).toBe('anthropic-key')

  /* everything off: nothing of their own carries the agent */
  await carol.patch('/api/model-account/anthropic-key', { enabled: false })
  await carol.patch('/api/model-account/openai-key', { enabled: false })
  expect((await view(carol)).default).toBeUndefined()
  expect(await (await carol.get('/api/agent-allowance')).json()).toMatchObject({ byoModel: false })
  expect(
    (await carol.req('/api/agent-runners/default', { method: 'PUT', body: JSON.stringify({ provider: 'server' }) }))
      .status,
  ).toBe(400)
})
