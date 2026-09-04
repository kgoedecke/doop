import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Drives the real callback leg of an OIDC sign-in against better-auth's
 * actual code (no mocking of doop or better-auth) - only the third-party
 * IdP is faked, which is unavoidable without a real Zitadel/Okta/etc to
 * point at. The fake IdP signs its ID tokens (RS256) and publishes a
 * jwks_uri, matching what a spec-compliant OIDC discovery document always
 * includes - so this exercises the same shape of token a real IdP produces,
 * rather than the unsigned `alg: none` case that better-auth's own
 * decodeJwt-based getUserInfo (see node_modules/better-auth/dist/plugins/
 * generic-oauth/routes.mjs) currently accepts either way.
 *
 * This exists to prove server/auth.ts's linkVerifiedOidcEmail: better-auth's
 * own account-linking gate requires the LOCAL user to already be
 * emailVerified before it will link an incoming OAuth sign-in to them, which
 * an SMTP-less instance (the default in this test harness, and a supported
 * self-host mode) can never satisfy on its own. Without the fix, the second
 * test below fails with an "account_not_linked" redirect.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
const KID = 'test-key-1'

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function fakeIdToken(claims: Record<string, unknown>, key: KeyObject): string {
  const headerAndPayload = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))}.${base64url(JSON.stringify(claims))}`
  const signature = cryptoSign('RSA-SHA256', Buffer.from(headerAndPayload), key)
  return `${headerAndPayload}.${base64url(signature)}`
}

function startFakeIdp(codeToClaims: Map<string, Record<string, unknown>>): Promise<HttpServer> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const port = (server.address() as AddressInfo).port
      if (url.pathname === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: `http://localhost:${port}`,
            authorization_endpoint: `http://localhost:${port}/authorize`,
            token_endpoint: `http://localhost:${port}/token`,
            jwks_uri: `http://localhost:${port}/jwks`,
          }),
        )
        return
      }
      if (url.pathname === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] }))
        return
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          const code = new URLSearchParams(body).get('code') ?? ''
          const claims = codeToClaims.get(code) ?? {}
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              access_token: 'fake-access-token',
              token_type: 'Bearer',
              expires_in: 3600,
              id_token: fakeIdToken(claims, privateKey),
            }),
          )
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, () => resolve(server))
  })
}

/* code -> the ID token claims the fake IdP hands back for it, set by each
   test right before it drives the flow */
const codeToClaims = new Map<string, Record<string, unknown>>()
let idp: HttpServer
let server: Server

/* 4973: clear of every other test file's port range (see tests/oidc.test.ts
   for the full accounting) - the fake IdP itself binds an OS-assigned port. */
const PORT = 4973

beforeAll(async () => {
  idp = await startFakeIdp(codeToClaims)
  const idpPort = (idp.address() as AddressInfo).port
  server = await startServer(PORT, {
    OIDC_ISSUER: `http://localhost:${idpPort}`,
    OIDC_CLIENT_ID: 'test-client',
    OIDC_CLIENT_SECRET: 'test-secret',
  })
}, 70_000)

afterAll(() => {
  idp?.close()
  server?.stop()
})

async function driveSsoCallback(client: Client, code: string): Promise<Response> {
  const initiate = await (
    await client.post('/api/auth/sign-in/oauth2', { providerId: 'oidc', callbackURL: '/' })
  ).json()
  const state = new URL(initiate.url).searchParams.get('state')
  return client.get(`/api/auth/oauth2/callback/oidc?code=${code}&state=${state}`)
}

describe('OIDC account linking against a real (faked-IdP) callback', () => {
  it('links to an existing password account, even though it was never SMTP-verified, when the IdP marks the email verified', async () => {
    const client = new Client(server)
    await client.signUp('carol@test.dev', 'Carol')
    const before = await (await client.get('/api/me')).json()

    const code = 'code-carol'
    codeToClaims.set(code, { sub: 'oidc-sub-carol', email: 'carol@test.dev', email_verified: true, name: 'Carol' })
    const callback = await driveSsoCallback(client, code)

    expect(callback.status).toBe(302)
    const location = new URL(callback.headers.get('location') ?? '', 'http://x')
    expect(location.searchParams.get('error')).toBeNull() // not an account_not_linked (or any other) error redirect

    const after = await (await client.get('/api/me')).json()
    expect(after.id).toBe(before.id) // same account, not a second one
    expect(after.email).toBe('carol@test.dev')
  })

  it('creates a new account via SSO when no local account exists for the email', async () => {
    const client = new Client(server)
    const code = 'code-dave'
    codeToClaims.set(code, { sub: 'oidc-sub-dave', email: 'dave@test.dev', email_verified: true, name: 'Dave' })

    const callback = await driveSsoCallback(client, code)

    expect(callback.status).toBe(302)
    const location = new URL(callback.headers.get('location') ?? '', 'http://x')
    expect(location.searchParams.get('error')).toBeNull()

    const me = await (await client.get('/api/me')).json()
    expect(me.email).toBe('dave@test.dev')
  })
})
