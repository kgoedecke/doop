import { generateKeyPairSync, createVerify } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import {
  appEnabled,
  appJwt,
  installationForRepo,
  installUrl,
  listReposAcross,
  oauthBounceUrl,
  signFindState,
  signInstallPass,
  signInstallState,
  signOauthState,
  userInstallationIds,
  verifyFindState,
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
    const pass = signInstallPass('canvas1', ['12345'])
    expect(verifyInstallPass(pass, 'canvas1')).toEqual({ installationIds: ['12345'] })
  })

  it('carries every installation found for the user, capped and numeric only', () => {
    const pass = signInstallPass('canvas1', ['1', '22', '333'])
    expect(verifyInstallPass(pass, 'canvas1')).toEqual({ installationIds: ['1', '22', '333'] })
    const many = Array.from({ length: 15 }, (_, i) => String(i + 1))
    expect(verifyInstallPass(signInstallPass('canvas1', many), 'canvas1')?.installationIds).toHaveLength(10)
    expect(() => signInstallPass('canvas1', [])).toThrow(/invalid id/)
    expect(() => signInstallPass('canvas1', ['1,2'])).toThrow(/invalid id/)
  })

  it('rejects tampering, wrong canvas, and expiry', () => {
    const pass = signInstallPass('canvas1', ['12345'])
    expect(verifyInstallPass(pass.slice(0, -2) + 'xx', 'canvas1')).toBeUndefined()
    expect(verifyInstallPass(pass.replace('12345', '99999'), 'canvas1')).toBeUndefined()
    expect(verifyInstallPass(pass, 'canvas2')).toBeUndefined()
    const expired = signInstallPass('canvas1', ['12345'], Date.now() - 60 * 60_000)
    expect(verifyInstallPass(expired, 'canvas1')).toBeUndefined()
    /* a state is not a pass */
    expect(verifyInstallPass(signInstallState('canvas1', 'user1'), 'canvas1')).toBeUndefined()
  })

  it('keeps the oauth-bounce and find states distinct from install state and pass', () => {
    const oauth = signOauthState('canvas1', '12345')
    expect(verifyOauthState(oauth)).toEqual({ canvasId: 'canvas1', installationId: '12345' })
    const find = signFindState('canvas1', 'user1')
    expect(verifyFindState(find)).toEqual({ canvasId: 'canvas1', userId: 'user1' })
    /* the kinds must never be interchangeable */
    expect(verifyOauthState(signInstallState('canvas1', 'user1'))).toBeUndefined()
    expect(verifyOauthState(signInstallPass('canvas1', ['12345']))).toBeUndefined()
    expect(verifyInstallPass(oauth, 'canvas1')).toBeUndefined()
    expect(verifyInstallState(oauth)).toBeUndefined()
    expect(verifyFindState(signInstallState('canvas1', 'user1'))).toBeUndefined()
    expect(verifyInstallState(find)).toBeUndefined()
    expect(verifyInstallPass(find, 'canvas1')).toBeUndefined()
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

/* ---- GitHub API calls, against a stubbed fetch */

type Route = (url: URL, init?: RequestInit) => unknown
function stubGithub(routes: Record<string, Route>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const route = routes[url.pathname]
    if (!route) return new Response('not found', { status: 404 })
    return Response.json(route(url, init))
  })
}

function repoPage(names: string[]) {
  return { repositories: names.map((full_name) => ({ full_name, private: true })) }
}

describe('finding the installations a user already has', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

  afterEach(() => {
    vi.restoreAllMocks()
    unstubAllEnvs()
  })

  it('lists every installation the OAuth code’s user can access', async () => {
    stubGithub({
      '/login/oauth/access_token': () => ({ access_token: 'ghu_user' }),
      '/user/installations': () => ({ installations: [{ id: 101 }, { id: 202 }] }),
    })
    expect(await userInstallationIds('code1')).toEqual(['101', '202'])
  })

  it('reports none as an empty list and an unknown user as undefined', async () => {
    stubGithub({
      '/login/oauth/access_token': () => ({ access_token: 'ghu_user' }),
      '/user/installations': () => ({ installations: [] }),
    })
    expect(await userInstallationIds('code1')).toEqual([])
    vi.restoreAllMocks()
    stubGithub({ '/login/oauth/access_token': () => ({ error: 'bad_verification_code' }) })
    expect(await userInstallationIds('stale')).toBeUndefined()
    expect(await userInstallationIds('')).toBeUndefined()
  })

  it('lists repos across installations and binds the one that grants the repo', async () => {
    stubEnv('GITHUB_APP_ID', '123')
    stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
    const tokenFor = (url: URL) => ({
      token: `tok-${url.pathname.split('/')[3]}`,
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    stubGithub({
      '/app/installations/301/access_tokens': tokenFor,
      '/app/installations/302/access_tokens': tokenFor,
      '/installation/repositories': (_url, init) =>
        new Headers(init?.headers).get('Authorization') === 'Bearer tok-301'
          ? repoPage(['me/site', 'me/app'])
          : repoPage(['org/app', 'Me/Site']),
    })
    expect((await listReposAcross(['301', '302'])).map((r) => r.fullName)).toEqual(['me/site', 'me/app', 'org/app'])
    expect(await installationForRepo(['301', '302'], 'org/app')).toBe('302')
    expect(await installationForRepo(['301', '302'], 'ME/APP')).toBe('301')
    expect(await installationForRepo(['301', '302'], 'someone/else')).toBeUndefined()
  })

  it('keeps healthy installations working when another one is gone', async () => {
    stubEnv('GITHUB_APP_ID', '123')
    stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
    /* 401 was uninstalled after the pass was issued: its token mint 404s */
    stubGithub({
      '/app/installations/402/access_tokens': () => ({
        token: 'tok-402',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
      '/installation/repositories': () => repoPage(['org/app']),
    })
    expect((await listReposAcross(['401', '402'])).map((r) => r.fullName)).toEqual(['org/app'])
    expect(await installationForRepo(['401', '402'], 'org/app')).toBe('402')
    /* the repo may have lived in the gone one: say so rather than "not part" */
    await expect(installationForRepo(['401', '402'], 'me/site')).rejects.toThrow(/no longer exists/)
    await expect(listReposAcross(['401'])).rejects.toThrow(/no longer exists/)
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

/** Just enough of GitHub for the connect round-trip: the OAuth code names the
 *  user ("has-installs" or "no-installs"), installation 555 grants me/site. */
function startFakeGithub(): Promise<HttpServer> {
  const fake = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const auth = req.headers.authorization ?? ''
    const json = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk))
    req.on('end', () => {
      if (url.pathname === '/login/oauth/access_token')
        return json({ access_token: `ghu_${(JSON.parse(body) as { code: string }).code}` })
      if (url.pathname === '/user/installations')
        return json({ installations: auth === 'Bearer ghu_has-installs' ? [{ id: 555 }] : [] })
      if (url.pathname === '/app/installations/555/access_tokens')
        return json({ token: 'ghs_555', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() })
      if (url.pathname === '/installation/repositories' && auth === 'Bearer ghs_555') return json(repoPage(['me/site']))
      if (url.pathname === '/repos/me/site') return json({ default_branch: 'main' })
      res.writeHead(404).end()
    })
  })
  return new Promise((resolve) => fake.listen(0, '127.0.0.1', () => resolve(fake)))
}

describe('app REST when configured', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let configured: Server
  let fakeGithub: HttpServer

  beforeAll(async () => {
    fakeGithub = await startFakeGithub()
    const fakeBase = `http://127.0.0.1:${(fakeGithub.address() as AddressInfo).port}`
    configured = await startServer({
      GITHUB_API_URL: fakeBase,
      GITHUB_OAUTH_TOKEN_URL: `${fakeBase}/login/oauth/access_token`,
      GITHUB_APP_ID: '123',
      GITHUB_APP_SLUG: 'doop-import',
      GITHUB_APP_CLIENT_ID: 'Iv1.test',
      GITHUB_APP_CLIENT_SECRET: 'shh',
      GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString(
        'base64',
      ),
    })
  }, 70_000)

  afterAll(() => {
    configured?.stop()
    fakeGithub?.close()
  })

  async function findState(owner: Client, canvasId: string): Promise<string> {
    const { url } = await (await owner.post(`/api/canvases/${canvasId}/github/app/start`)).json()
    return new URL(url).searchParams.get('state') ?? ''
  }

  it('opens the picker on a new canvas with the installation the user already has', async () => {
    const owner = await new Client(configured).signUp('gh-has@test.dev', 'Owner')
    const canvasId = (await (await owner.post('/api/canvases', { name: 'Has' })).json()).id

    const setup = await owner.req(
      `/api/github/app/setup?code=has-installs&state=${encodeURIComponent(await findState(owner, canvasId))}`,
    )
    expect(setup.status).toBe(302)
    const back = new URL(setup.headers.get('location')!, 'http://x')
    expect(back.pathname).toBe(`/c/${canvasId}`)
    const pass = back.searchParams.get('ghInstall')!
    expect(verifyInstallPass(pass, canvasId)).toEqual({ installationIds: ['555'] })

    const repos = await (
      await owner.get(`/api/canvases/${canvasId}/github/app/repos?pass=${encodeURIComponent(pass)}`)
    ).json()
    expect(repos).toEqual([{ fullName: 'me/site', private: true }])
    const conn = await owner.post(`/api/canvases/${canvasId}/github`, { repo: 'me/site', pass })
    expect(conn.status).toBe(200)
    expect(await conn.json()).toMatchObject({ repo: 'me/site', branch: 'main', via: 'app', installationId: '555' })
  })

  it('sends a user with no installation on to the install screen', async () => {
    const owner = await new Client(configured).signUp('gh-none@test.dev', 'Owner')
    const canvasId = (await (await owner.post('/api/canvases', { name: 'None' })).json()).id

    const setup = await owner.req(
      `/api/github/app/setup?code=no-installs&state=${encodeURIComponent(await findState(owner, canvasId))}`,
    )
    expect(setup.status).toBe(302)
    const install = new URL(setup.headers.get('location')!)
    expect(install.pathname).toBe('/apps/doop-import/installations/new')
    expect(verifyInstallState(install.searchParams.get('state') ?? '')?.canvasId).toBe(canvasId)
  })

  it('starts on the authorize screen and lands a cancelled one back on the canvas', async () => {
    const owner = await new Client(configured).signUp('gh-find@test.dev', 'Owner')
    const canvasId = (await (await owner.post('/api/canvases', { name: 'Find' })).json()).id

    /* a new canvas asks GitHub who the user is before any install screen,
       which for an installed app would never come back */
    const { url } = await (await owner.post(`/api/canvases/${canvasId}/github/app/start`)).json()
    const authorize = new URL(url)
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(verifyFindState(authorize.searchParams.get('state') ?? '')?.canvasId).toBe(canvasId)

    const cancelled = await owner.req(
      `/api/github/app/setup?error=access_denied&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
    )
    expect(cancelled.status).toBe(302)
    const back = new URL(cancelled.headers.get('location')!, 'http://x')
    expect(back.pathname).toBe(`/c/${canvasId}`)
    expect(back.searchParams.get('ghError')).toMatch(/cancelled/)
  })

  it('links the picker to the install screen with a state for the canvas', async () => {
    const owner = await new Client(configured).signUp('gh-add@test.dev', 'Owner')
    const canvasId = (await (await owner.post('/api/canvases', { name: 'Add' })).json()).id
    const res = await owner.req(`/api/canvases/${canvasId}/github/app/install`)
    expect(res.status).toBe(302)
    const install = new URL(res.headers.get('location')!)
    expect(install.pathname).toBe('/apps/doop-import/installations/new')
    expect(verifyInstallState(install.searchParams.get('state') ?? '')?.canvasId).toBe(canvasId)
  })
})

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
