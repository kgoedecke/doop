import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness'

/**
 * A shared provider whose key can no longer be unsealed (its encryption key
 * rotated out of SECRETS_ENCRYPTION_KEYS, or the value damaged) is skipped on
 * its own: everyone's other connections, and the admin's list, keep working.
 * The server is rebooted on the same database under a different key.
 */

const KEY_A = `a:${Buffer.alloc(32, 1).toString('base64')}`
const KEY_B = `b:${Buffer.alloc(32, 2).toString('base64')}`
const ENV = {
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  DATABASE_URL: '',
  SMTP_HOST: '',
  ADMIN_EMAILS: 'sealed-boss@example.test',
}
const provider = {
  apiType: 'openai-chat',
  baseUrl: 'https://llm.acme.example/v1',
  models: [{ id: 'qwen3-coder', vision: false }],
}

let server: Server
let boss: Client
let alice: Client

beforeAll(async () => {
  const first = await startServer({ ...ENV, SECRETS_ENCRYPTION_KEYS: KEY_A })
  boss = await new Client(first).signUp('sealed-boss@example.test', 'Boss')
  alice = await new Client(first).signUp('sealed-alice@example.test', 'Alice')
  /* sealed under key A, which the reboot below no longer has */
  expect(
    (await boss.post('/api/admin/shared-providers', { ...provider, name: 'Old Gateway', apiKey: 'sk-sealed-under-a' }))
      .status,
  ).toBe(200)
  /* a personal provider with nothing sealed in it */
  expect((await alice.post('/api/custom-providers', { ...provider, name: 'Alice’s own' })).status).toBe(200)
  first.stop({ keepData: true })
  server = await startServer({ ...ENV, SECRETS_ENCRYPTION_KEYS: KEY_B }, first.dataDir)
  for (const client of [boss, alice]) {
    await client.post('/api/auth/sign-in/email', {
      email: client === boss ? 'sealed-boss@example.test' : 'sealed-alice@example.test',
      password: 'password12345',
    })
  }
}, 90_000)
afterAll(() => server?.stop())

it('skips only the provider whose key cannot be unsealed', async () => {
  const added = await boss.post('/api/admin/shared-providers', {
    ...provider,
    name: 'New Gateway',
    apiKey: 'sk-sealed-under-b',
  })
  expect(added.status).toBe(200)
  const admin = (await (await boss.get('/api/admin/shared-providers')).json()) as {
    providers: { custom: { name: string } }[]
  }
  expect(admin.providers.map((p) => p.custom.name)).toEqual(['New Gateway'])

  const view = (await (await alice.get('/api/model-account')).json()) as {
    accounts: { custom?: { name: string }; shared?: true }[]
  }
  expect(view.accounts.map((a) => [a.custom?.name, a.shared ?? false])).toEqual([
    ['Alice’s own', false],
    ['New Gateway', true],
  ])
  expect((await alice.get('/api/agent-runners')).status).toBe(200)
})
