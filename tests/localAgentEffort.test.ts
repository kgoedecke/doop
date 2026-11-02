import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/**
 * The local Claude preference carries the model (an alias or a pinned id)
 * and, optionally, the effort. Both survive switching the agent off and on,
 * and the server refuses anything the shell would refuse.
 */
let server: Server
let alice: Client
beforeAll(async () => {
  server = await startServer({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', DATABASE_URL: '', SMTP_HOST: '' })
  alice = await new Client(server).signUp('local-effort-alice@example.test', 'Alice')
}, 60000)
afterAll(() => server?.stop())

const put = (body: unknown) => alice.req('/api/local-agent', { method: 'PUT', body: JSON.stringify(body) })
const get = async () => (await alice.get('/api/local-agent')).json()

it('keeps the alias, a pinned id and the effort across a switch away and back', async () => {
  expect((await put({ enabled: true, model: 'fable', effort: 'high' })).status).toBe(200)
  expect(await get()).toMatchObject({ enabled: true, model: 'fable', effort: 'high' })

  /* off (a server provider took over) and on again: nothing forgotten */
  expect((await put({ enabled: false, model: 'fable', effort: 'high' })).status).toBe(200)
  expect(await get()).toMatchObject({ enabled: false, model: 'fable', effort: 'high' })
  expect((await put({ enabled: true, model: 'fable', effort: 'high' })).status).toBe(200)
  expect(await get()).toMatchObject({ enabled: true, effort: 'high' })

  /* a pinned id, and dropping the effort back to the CLI's own */
  expect((await put({ enabled: true, model: 'claude-opus-5-20260901' })).status).toBe(200)
  const pinned = await get()
  expect(pinned).toMatchObject({ enabled: true, model: 'claude-opus-5-20260901' })
  expect(pinned).not.toHaveProperty('effort')
})

it('refuses what the shell would refuse', async () => {
  for (const body of [
    { enabled: true, model: '--dangerously-skip-permissions' },
    { enabled: true, model: 'gpt-6' },
    { enabled: true, model: 'claude-' },
    { enabled: true, model: 'sonnet', effort: 'default' },
    { enabled: true, model: 'sonnet', effort: 'HIGH' },
    { enabled: true, model: 'sonnet', effort: 'none' },
  ]) {
    expect((await put(body)).status, JSON.stringify(body)).toBe(400)
  }
  /* an id saved before the aliases still reads as itself */
  expect((await put({ enabled: true, model: 'claude-sonnet-5' })).status).toBe(200)
  expect(await get()).toMatchObject({ model: 'claude-sonnet-5' })
})
