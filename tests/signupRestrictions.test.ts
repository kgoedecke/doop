import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

const PORT = 4997

let server: Server
let client: Client

function signUp(email: string, name: string) {
  return client.req('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { Origin: server.base },
    body: JSON.stringify({ email, password: 'password12345', name }),
  })
}

beforeAll(async () => {
  server = await startServer(PORT, { SIGNUP_EMAIL_DOMAINS: 'jointhetroops.com, partner.test' })
  client = new Client(server)
}, 70_000)

afterAll(() => server?.stop())

describe('signup domain restrictions', () => {
  it('allows configured email domains', async () => {
    const res = await signUp('person@jointhetroops.com', 'Allowed Person')
    expect(res.status, await res.text()).toBe(200)
  })

  it('rejects other domains without creating an account', async () => {
    const email = 'outsider@example.com'
    const res = await signUp(email, 'Outsider')
    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('@jointhetroops.com')

    const exists = await client.post('/api/account-exists', { email })
    expect(await exists.json()).toEqual({ exists: false })
  })
})
