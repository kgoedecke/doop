import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { loadIpAddressConfig } from '../server/auth.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import { startServer, type Server } from './harness.ts'

afterEach(unstubAllEnvs)

describe('loadIpAddressConfig', () => {
  it('leaves Better Auth on its default when nothing is set', () => {
    stubEnv('AUTH_IP_HEADERS', undefined)
    stubEnv('AUTH_TRUSTED_PROXIES', undefined)
    expect(loadIpAddressConfig()).toBeNull()
  })

  it('passes lowercased headers and trusted proxies through', () => {
    stubEnv('AUTH_IP_HEADERS', 'Fly-Client-IP, X-Real-IP')
    stubEnv('AUTH_TRUSTED_PROXIES', '10.0.0.0/8')
    expect(loadIpAddressConfig()).toEqual({
      ipAddressHeaders: ['fly-client-ip', 'x-real-ip'],
      trustedProxies: ['10.0.0.0/8'],
    })
  })
})

describe('auth rate limiting behind a proxy', () => {
  let server: Server | undefined
  afterAll(() => server?.stop())

  it('limits each client by the configured header, not one shared bucket', async () => {
    server = await startServer({
      AUTH_IP_HEADERS: 'fly-client-ip',
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'test-secret-at-least-32-chars-long-1234',
    })
    const base = server.base
    const signIn = (ip: string) =>
      fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: base,
          'fly-client-ip': ip,
          /* two hops: on its own, Better Auth finds no client IP in this */
          'x-forwarded-for': `${ip}, 10.0.0.1`,
        },
        body: JSON.stringify({ email: 'someone@example.com', password: 'wrongpassword' }),
      })

    let limited = false
    for (let i = 0; i < 5 && !limited; i++) limited = (await signIn('203.0.113.10')).status === 429
    expect(limited).toBe(true)
    expect((await signIn('203.0.113.20')).status).not.toBe(429)
  }, 70_000)
})
