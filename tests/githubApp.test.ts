import { generateKeyPairSync, createVerify } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import {
  appEnabled,
  appJwt,
  installUrl,
  oauthBounceUrl,
  signInstallPass,
  signInstallState,
  signOauthState,
  verifyInstallPass,
  verifyInstallState,
  verifyOauthState,
} from '../server/githubApp.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * GitHub App plumbing: the app JWT and the signed install handoff that keeps
 * guessable installation ids from being bound to canvases that never started
 * an install. Plus the REST surface's disabled-mode behavior — the app is
 * off unless its env vars are set, and every UI falls back to the PAT form.
 */

describe('install handoff signatures', () => {
  it('round-trips state and pass', () => {
    const state = signInstallState('canvas1', 'user1')
    expect(verifyInstallState(state)).toEqual({ canvasId: 'canvas1', userId: 'user1' })
    const pass = signInstallPass('canvas1', '12345')
    expect(verifyInstallPass(pass, 'canvas1')).toEqual({ installationId: '12345' })
  })

  it('rejects tampering, wrong canvas, and expiry', () => {
    const pass = signInstallPass('canvas1', '12345')
    expect(verifyInstallPass(pass.slice(0, -2) + 'xx', 'canvas1')).toBeUndefined()
    expect(verifyInstallPass(pass.replace('12345', '99999'), 'canvas1')).toBeUndefined()
    expect(verifyInstallPass(pass, 'canvas2')).toBeUndefined()
    const expired = signInstallPass('canvas1', '12345', Date.now() - 60 * 60_000)
    expect(verifyInstallPass(expired, 'canvas1')).toBeUndefined()
    /* a state is not a pass */
    expect(verifyInstallPass(signInstallState('canvas1', 'user1'), 'canvas1')).toBeUndefined()
  })

  it('keeps the oauth-bounce state distinct from install state and pass', () => {
    const oauth = signOauthState('canvas1', '12345')
    expect(verifyOauthState(oauth)).toEqual({ canvasId: 'canvas1', installationId: '12345' })
    /* the three kinds must never be interchangeable */
    expect(verifyOauthState(signInstallState('canvas1', 'user1'))).toBeUndefined()
    expect(verifyOauthState(signInstallPass('canvas1', '12345'))).toBeUndefined()
    expect(verifyInstallPass(oauth, 'canvas1')).toBeUndefined()
    expect(verifyInstallState(oauth)).toBeUndefined()
  })

  it('builds the authorize bounce URL from the app client id', () => {
    stubEnv('GITHUB_APP_CLIENT_ID', 'Iv1.test')
    try {
      const url = new URL(oauthBounceUrl('s1'))
      expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
      expect(url.searchParams.get('client_id')).toBe('Iv1.test')
      expect(url.searchParams.get('state')).toBe('s1')
      expect(url.searchParams.get('redirect_uri')).toContain('/api/github/app/setup')
    } finally {
      unstubAllEnvs()
    }
  })
})

describe('app jwt', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

  it('is off without env config', () => {
    expect(appEnabled()).toBe(false)
    expect(() => appJwt()).toThrow(/not configured/)
  })

  it('signs a verifiable RS256 token when configured', () => {
    stubEnv('GITHUB_APP_ID', '123')
    stubEnv('GITHUB_APP_SLUG', 'doop-import')
    stubEnv(
      'GITHUB_APP_PRIVATE_KEY',
      Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64'),
    )
    try {
      /* key alone is not enough: the OAuth creds prove install ownership —
         no partial enablement */
      expect(appEnabled()).toBe(false)
      stubEnv('GITHUB_APP_CLIENT_ID', 'Iv1.abc')
      stubEnv('GITHUB_APP_CLIENT_SECRET', 'shh')
      expect(appEnabled()).toBe(true)
      const jwt = appJwt()
      const [header, payload, signature] = jwt.split('.')
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
      expect(claims.iss).toBe('123')
      expect(claims.exp - claims.iat).toBe(8 * 60)
      const ok = createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature!, 'base64url'))
      expect(ok).toBe(true)
      expect(installUrl('s1')).toBe('https://github.com/apps/doop-import/installations/new?state=s1')
    } finally {
      unstubAllEnvs()
    }
  })
})

/* ---- REST surface with the app unconfigured (the default server state) */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

describe('app REST in disabled mode', () => {
  it('reports disabled and refuses to start installs', async () => {
    const owner = await new Client(server).signUp('gh-app@test.dev', 'Owner')
    const canvasId = (await (await owner.post('/api/canvases', { name: 'App' })).json()).id

    const info = await (await owner.get('/api/github/app')).json()
    expect(info.enabled).toBe(false)

    const start = await owner.post(`/api/canvases/${canvasId}/github/app/start`)
    expect(start.status).toBe(400)

    /* setup redirect with garbage state goes home, never errors */
    const setup = await owner.req('/api/github/app/setup?installation_id=1&state=junk')
    expect(setup.status).toBe(302)
    expect(setup.headers.get('location')).toBe('/')

    /* a forged pass cannot list repos or bind a connection */
    const repos = await owner.get(`/api/canvases/${canvasId}/github/app/repos?pass=forged`)
    expect(repos.status).toBe(400)
    const bind = await owner.post(`/api/canvases/${canvasId}/github`, { repo: 'a/b', pass: 'forged' })
    expect(bind.status).toBe(400)
    expect((await bind.json()).error).toMatch(/handoff expired/)
  })
})
