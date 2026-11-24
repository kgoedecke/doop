import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { consentCovers, requestedScopes } from '../server/mcpConsent.ts'

/* better-auth's MCP authorize endpoint shows the consent page only when the
   client asks for it (`prompt=consent`); without it, a signed-in person was
   sent straight to the client's redirect URI with an authorization code.
   Registration is open to anyone, so a stranger could register a client
   pointing at their own server, send a Doop user the authorize link and trade
   the code (with their own PKCE verifier) for an agent token to that
   person's account. Every client must now be approved once, for the scopes
   it asks, before it gets a code without the page. */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

const ATTACKER_CALLBACK = 'https://attacker.example/cb'

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

async function register(redirectUri = ATTACKER_CALLBACK, name = 'Claude Code'): Promise<string> {
  const res = await new Client(server).post('/api/auth/mcp/register', {
    client_name: name,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

function authorizePath(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: ATTACKER_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    ...extra,
  })
  return `/api/auth/mcp/authorize?${query}`
}

function locationOf(res: Response) {
  return new URL(res.headers.get('location') ?? '', server.base)
}

async function exchange(clientId: string, code: string, verifier: string) {
  return fetch(`${server.base}/api/auth/mcp/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: ATTACKER_CALLBACK,
      code_verifier: verifier,
    }),
  })
}

async function approve(person: Client, consentCode: string) {
  const res = await person.post(`/api/mcp-consent/${consentCode}`, { accept: true })
  expect(res.status).toBe(200)
  return new URL(((await res.json()) as { redirectURI: string }).redirectURI)
}

describe('MCP authorize consent', () => {
  it('sends a signed-in person to the consent page for a client they never approved', async () => {
    const victim = await new Client(server).signUp('consent-victim@test.dev', 'Victim')
    const clientId = await register()
    const { verifier, challenge } = pkce()

    const res = await victim.get(authorizePath(clientId, challenge))
    expect(res.status).toBe(302)
    const location = locationOf(res)
    expect(location.origin).toBe(server.base)
    expect(location.pathname).toBe('/oauth/consent')
    expect(location.searchParams.get('client_id')).toBe(clientId)

    /* the pending request's code reaches only the person's browser, and is no
       authorization code until they approve it */
    const consentCode = location.searchParams.get('consent_code')!
    const early = await exchange(clientId, consentCode, verifier)
    expect(early.status).toBe(401)
    expect(((await early.json()) as { error: string }).error).toBe('invalid_grant')
  })

  it('issues a code once approved, keeps the state, and asks no more for the same client and scopes', async () => {
    const person = await new Client(server).signUp('consent-once@test.dev', 'Once')
    const clientId = await register()
    const first = pkce()

    const consent = locationOf(await person.get(authorizePath(clientId, first.challenge)))
    expect(consent.pathname).toBe('/oauth/consent')
    const callback = await approve(person, consent.searchParams.get('consent_code')!)
    expect(callback.origin + callback.pathname).toBe(ATTACKER_CALLBACK)
    expect(callback.searchParams.get('state')).toBe('st-1')
    const token = await exchange(clientId, callback.searchParams.get('code')!, first.verifier)
    expect(token.status).toBe(200)

    /* a reconnect of the approved client goes straight back with a code */
    const second = pkce()
    const again = await person.get(authorizePath(clientId, second.challenge))
    const direct = locationOf(again)
    expect(direct.origin + direct.pathname).toBe(ATTACKER_CALLBACK)
    expect(direct.searchParams.get('state')).toBe('st-1')
    expect((await exchange(clientId, direct.searchParams.get('code')!, second.verifier)).status).toBe(200)

    /* a client that asks for the page still gets it */
    const asked = await person.get(authorizePath(clientId, pkce().challenge, { prompt: 'consent' }))
    expect(locationOf(asked).pathname).toBe('/oauth/consent')
  })

  it('asks again when the client wants scopes beyond what was approved', async () => {
    const person = await new Client(server).signUp('consent-scopes@test.dev', 'Scopes')
    const clientId = await register()
    const consent = locationOf(await person.get(authorizePath(clientId, pkce().challenge, { scope: 'openid' })))
    await approve(person, consent.searchParams.get('consent_code')!)

    const wider = await person.get(authorizePath(clientId, pkce().challenge, { scope: 'openid offline_access' }))
    expect(locationOf(wider).pathname).toBe('/oauth/consent')
    const same = await person.get(authorizePath(clientId, pkce().challenge, { scope: 'openid' }))
    expect(locationOf(same).origin).not.toBe(server.base)
  })

  it("does not count another person's approval", async () => {
    const alice = await new Client(server).signUp('consent-alice@test.dev', 'Alice')
    const bob = await new Client(server).signUp('consent-bob@test.dev', 'Bob')
    const clientId = await register()
    const consent = locationOf(await alice.get(authorizePath(clientId, pkce().challenge)))
    await approve(alice, consent.searchParams.get('consent_code')!)

    const res = await bob.get(authorizePath(clientId, pkce().challenge))
    expect(locationOf(res).pathname).toBe('/oauth/consent')
  })

  it("will not let someone else approve a person's pending request", async () => {
    const owner = await new Client(server).signUp('consent-owner@test.dev', 'Owner')
    const intruder = await new Client(server).signUp('consent-intruder@test.dev', 'Intruder')
    const clientId = await register()
    const consentCode = locationOf(await owner.get(authorizePath(clientId, pkce().challenge))).searchParams.get(
      'consent_code',
    )!

    /* Doop's own route checks the account; better-auth's endpoint behind it did not */
    expect((await intruder.post(`/api/mcp-consent/${consentCode}`, { accept: true })).status).toBe(404)
    const direct = await intruder.post('/api/auth/oauth2/consent', { accept: true, consent_code: consentCode })
    expect(direct.status).toBe(401)

    /* the request is still the owner's to approve */
    expect((await approve(owner, consentCode)).searchParams.has('code')).toBe(true)
  })

  it('sends someone who signs in partway through an authorize to the consent page, not the client', async () => {
    await new Client(server).signUp('consent-later@test.dev', 'Later')
    const clientId = await register()
    const browser = new Client(server)

    /* signed out: the request is remembered in a cookie and the sign-in
       finishes it (better-auth's after-hook on the sign-in response) */
    const signedOut = await browser.get(authorizePath(clientId, pkce().challenge))
    expect(signedOut.status).toBe(302)
    const signIn = await browser.post('/api/auth/sign-in/email', {
      email: 'consent-later@test.dev',
      password: 'password12345',
    })
    const finished = signIn.headers.get('location')
    if (finished) {
      const location = new URL(finished, server.base)
      expect(location.pathname).toBe('/oauth/consent')
    }
    expect(finished ?? '').not.toContain('attacker.example')
    expect(finished ?? '').not.toMatch(/[?&]code=/)

    /* and the sign-in page's own resume (the authorize URL again) asks too */
    const resumed = await browser.get(authorizePath(clientId, pkce().challenge))
    expect(locationOf(resumed).pathname).toBe('/oauth/consent')
  })
})

describe('consent rules', () => {
  it('reads requested scopes the way the plugin does', () => {
    expect(requestedScopes({})).toEqual(['openid'])
    expect(requestedScopes({ scope: 'openid  offline_access' })).toEqual(['openid', 'offline_access'])
  })

  it('needs an approval covering every requested scope', () => {
    expect(consentCovers([], ['openid'])).toBe(false)
    expect(consentCovers(['openid'], ['openid', 'offline_access'])).toBe(false)
    expect(consentCovers(['openid', 'offline_access profile'], ['openid', 'offline_access'])).toBe(true)
  })
})
