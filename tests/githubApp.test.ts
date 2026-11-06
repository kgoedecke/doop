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
  issueInstallPass,
  listReposAcross,
  oauthBounceUrl,
  redeemInstallPass,
  signFindState,
  signInstallState,
  signOauthState,
  userAccess,
  userInstallationIds,
  verifyFindState,
  verifyInstallState,
  verifyOauthState,
  type InstallationGrant,
} from '../server/githubApp.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * GitHub App plumbing: the app JWT and the signed install handoff that keeps
 * guessable installation ids from being bound to canvases that never started
 * an install, and that grants only the repos GitHub lets the connecting USER
 * reach (an org installation covers more than one member may see). Plus the
 * REST surface's disabled-mode behavior — the app is off unless its env vars
 * are set, and every UI falls back to the PAT form.
 */

const grant = (installationId: string, ...names: string[]): InstallationGrant => ({
  installationId,
  repos: names.map((fullName) => ({ fullName, private: true })),
})

describe('install handoff signatures', () => {
  it('round-trips state and pass', () => {
    const state = signInstallState('canvas1', 'user1')
    expect(verifyInstallState(state)).toEqual({ canvasId: 'canvas1', userId: 'user1' })
    const grants = [grant('12345', 'me/site')]
    const pass = issueInstallPass('canvas1', grants)
    expect(redeemInstallPass(pass, 'canvas1')).toEqual(grants)
  })

  it('stands for every grant found for the user, capped and numeric only, and keeps the repos off the URL', () => {
    const grants = [grant('1', 'me/site'), grant('22', 'org/app', 'org/site'), grant('333')]
    const pass = issueInstallPass('canvas1', grants)
    expect(redeemInstallPass(pass, 'canvas1')).toEqual(grants)
    expect(pass).not.toContain('org')
    expect(pass.length).toBeLessThan(120)
    const many = Array.from({ length: 15 }, (_, i) => grant(String(i + 1)))
    expect(redeemInstallPass(issueInstallPass('canvas1', many), 'canvas1')).toHaveLength(10)
    expect(() => issueInstallPass('canvas1', [])).toThrow(/invalid id/)
    expect(() => issueInstallPass('canvas1', [grant('1,2')])).toThrow(/invalid id/)
  })

  it('rejects tampering, wrong canvas, expiry, and a nonce it never issued', () => {
    const pass = issueInstallPass('canvas1', [grant('12345')])
    expect(redeemInstallPass(pass.slice(0, -2) + 'xx', 'canvas1')).toBeUndefined()
    expect(redeemInstallPass(pass, 'canvas2')).toBeUndefined()
    const expired = issueInstallPass('canvas1', [grant('12345')], Date.now() - 60 * 60_000)
    expect(redeemInstallPass(expired, 'canvas1')).toBeUndefined()
    /* a state is not a pass */
    expect(redeemInstallPass(signInstallState('canvas1', 'user1'), 'canvas1')).toBeUndefined()
    /* two passes for one canvas stand for their own grants */
    const other = issueInstallPass('canvas1', [grant('777', 'other/repo')])
    expect(redeemInstallPass(other, 'canvas1')).toEqual([grant('777', 'other/repo')])
    expect(redeemInstallPass(pass, 'canvas1')).toEqual([grant('12345')])
  })

  it('keeps the oauth-bounce and find states distinct from install state and pass', () => {
    const oauth = signOauthState('canvas1', '12345')
    expect(verifyOauthState(oauth)).toEqual({ canvasId: 'canvas1', installationId: '12345' })
    const find = signFindState('canvas1', 'user1')
    expect(verifyFindState(find)).toEqual({ canvasId: 'canvas1', userId: 'user1' })
    /* the kinds must never be interchangeable */
    expect(verifyOauthState(signInstallState('canvas1', 'user1'))).toBeUndefined()
    expect(verifyOauthState(issueInstallPass('canvas1', [grant('12345')]))).toBeUndefined()
    expect(redeemInstallPass(oauth, 'canvas1')).toBeUndefined()
    expect(verifyInstallState(oauth)).toBeUndefined()
    expect(verifyFindState(signInstallState('canvas1', 'user1'))).toBeUndefined()
    expect(verifyInstallState(find)).toBeUndefined()
    expect(redeemInstallPass(find, 'canvas1')).toBeUndefined()
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

  it('grants each installation only the repos GitHub shows the user, not everything the app holds', async () => {
    stubGithub({
      '/login/oauth/access_token': () => ({ access_token: 'ghu_user' }),
      '/user/installations': () => ({ installations: [{ id: 301 }, { id: 302 }] }),
      /* 302 is an org installation covering more than this member may read */
      '/user/installations/301/repositories': () => repoPage(['me/site', 'me/app']),
      '/user/installations/302/repositories': () => repoPage(['org/app', 'Me/Site']),
      '/installation/repositories': () => {
        throw new Error('the installation token must not decide what a user sees')
      },
    })
    const grants = await userAccess('code1')
    expect(grants).toEqual([grant('301', 'me/site', 'me/app'), grant('302', 'org/app', 'Me/Site')])
    expect(listReposAcross(grants!).map((r) => r.fullName)).toEqual(['me/site', 'me/app', 'org/app'])
    expect(installationForRepo(grants!, 'org/app')).toBe('302')
    expect(installationForRepo(grants!, 'ME/APP')).toBe('301')
    expect(installationForRepo(grants!, 'org/secret')).toBeUndefined()
    expect(installationForRepo(grants!, 'someone/else')).toBeUndefined()
  })

  it('narrows a fresh install to the one installation named, and refuses one the user cannot see', async () => {
    stubGithub({
      '/login/oauth/access_token': () => ({ access_token: 'ghu_user' }),
      '/user/installations': () => ({ installations: [{ id: 301 }, { id: 302 }] }),
      '/user/installations/301/repositories': () => repoPage(['me/site']),
      '/user/installations/302/repositories': () => repoPage(['org/app']),
    })
    expect(await userAccess('code1', ['302'])).toEqual([grant('302', 'org/app')])
    /* a guessed installation id from another account grants nothing */
    expect(await userAccess('code1', ['999'])).toEqual([])
  })

  it('keeps the healthy installations when another one fails to list', async () => {
    /* 302 was removed since the installations were listed: its repos 404 */
    stubGithub({
      '/login/oauth/access_token': () => ({ access_token: 'ghu_user' }),
      '/user/installations': () => ({ installations: [{ id: 301 }, { id: 302 }] }),
      '/user/installations/301/repositories': () => repoPage(['me/site']),
    })
    expect(await userAccess('code1')).toEqual([grant('301', 'me/site')])
    /* the one installation a fresh install named is the one that failed */
    expect(await userAccess('code1', ['302'])).toBeUndefined()
  })

  it('reports an unidentified user, or no listing succeeding, as undefined', async () => {
    stubGithub({
      '/login/oauth/access_token': () => ({ access_token: 'ghu_user' }),
      '/user/installations': () => ({ installations: [{ id: 301 }] }),
    })
    /* no repositories route: GitHub answers 404, and the pass must not be issued on a guess */
    expect(await userAccess('code1')).toBeUndefined()
    vi.restoreAllMocks()
    stubGithub({ '/login/oauth/access_token': () => ({ error: 'bad_verification_code' }) })
    expect(await userAccess('stale')).toBeUndefined()
    expect(await userAccess('')).toBeUndefined()
  })

  it('pages through a large installation', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => `org/repo-${i}`)
    stubGithub({
      '/login/oauth/access_token': () => ({ access_token: 'ghu_user' }),
      '/user/installations': () => ({ installations: [{ id: 301 }] }),
      '/user/installations/301/repositories': (url) =>
        repoPage(url.searchParams.get('page') === '1' ? page(100) : ['org/last']),
    })
    const grants = await userAccess('code1')
    expect(grants?.[0]?.repos).toHaveLength(101)
    expect(installationForRepo(grants!, 'org/last')).toBe('301')
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
 *  user ("has-installs" or "no-installs"), installation 555 covers me/site
 *  and org/secret, but the user may reach only me/site through it. */
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
      if (url.pathname === '/user/installations/555/repositories' && auth === 'Bearer ghu_has-installs')
        return json(repoPage(['me/site']))
      if (url.pathname === '/app/installations/555/access_tokens')
        return json({ token: 'ghs_555', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() })
      if (url.pathname === '/installation/repositories' && auth === 'Bearer ghs_555')
        return json(repoPage(['me/site', 'org/secret']))
      if (url.pathname === '/repos/me/site' || url.pathname === '/repos/org/secret')
        return json({ default_branch: 'main' })
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
    /* the pass names the canvas and a nonce; the grants stay in the server */
    const pass = back.searchParams.get('ghInstall')!
    expect(pass.split('.').slice(0, 2)).toEqual(['gh-pass', canvasId])
    expect(pass).not.toContain('555')

    /* the picker and the bind see what GitHub shows the user, not the
       installation's wider list (org/secret) */
    const repos = await (
      await owner.get(`/api/canvases/${canvasId}/github/app/repos?pass=${encodeURIComponent(pass)}`)
    ).json()
    expect(repos).toEqual([{ fullName: 'me/site', private: true }])
    const denied = await owner.post(`/api/canvases/${canvasId}/github`, { repo: 'org/secret', pass })
    expect(denied.status).toBe(400)
    expect((await denied.json()).error).toMatch(/not part of the GitHub App installation/)
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
