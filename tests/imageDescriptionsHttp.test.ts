import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The setting over HTTP, against the real server: a default of `account`,
 * each mode saved and read back with the describer that would run, and a
 * refusal of anything else. The server here has no model key, so the
 * describer explains itself as no-model.
 */

let server: Server
let alice: Client

beforeAll(async () => {
  server = await startServer({ ANTHROPIC_API_KEY: '', DOOP_AGENT_PROVIDER: 'anthropic' })
  alice = await new Client(server).signUp('describe-alice@test.dev', 'Alice')
}, 70_000)

afterAll(() => server?.stop())

it('defaults to the owner’s account and reports the describer', async () => {
  const res = await alice.get('/api/image-descriptions')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ mode: 'account', describer: { label: null, reason: 'no-model' } })
})

it('saves each mode and reads it back', async () => {
  for (const mode of ['server', 'off', 'account'] as const) {
    const res = await alice.put('/api/image-descriptions', { mode })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe(mode)
    expect(body.describer.reason).toBe(mode === 'off' ? 'off' : 'no-model')
    expect((await (await alice.get('/api/image-descriptions')).json()).mode).toBe(mode)
  }
})

it('refuses an unknown mode and a signed-out caller', async () => {
  expect((await alice.put('/api/image-descriptions', { mode: 'always' })).status).toBe(400)
  expect((await alice.put('/api/image-descriptions', {})).status).toBe(400)
  expect((await new Client(server).get('/api/image-descriptions')).status).toBe(401)
})
