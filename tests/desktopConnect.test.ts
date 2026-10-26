import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { DESKTOP_STATE_PREFIX, isDesktopState, markDesktopState, unmarkDesktopState } from '../shared/desktopConnect'
import {
  PENDING_CONNECT_TTL_MS,
  desktopConnectLink,
  forgetPendingConnect,
  isPendingConnect,
  parseDesktopConnectLink,
  parseDesktopConnectQuery,
  rememberPendingConnect,
} from '../src/lib/desktopConnect'

/** Connecting an integration from the desktop app: the provider's redirect
 *  lands in the system browser, which is relayed back to the app, and the
 *  app finishes the connection under its own session. Slack stands in for
 *  every OAuth integration, its exchange going to a stub of slack.com/api. */

describe('desktop OAuth state', () => {
  it('marks only the state parameter, leaving encoded scopes alone', () => {
    const url = 'https://provider.test/authorize?scope=a%20b,c&state=s.1%2B2&redirect_uri=x'
    expect(markDesktopState(url)).toBe(
      `https://provider.test/authorize?scope=a%20b,c&state=${DESKTOP_STATE_PREFIX}s.1%2B2&redirect_uri=x`,
    )
    expect(markDesktopState('https://provider.test/authorize?state=first')).toContain(`?state=${DESKTOP_STATE_PREFIX}`)
  })

  it('refuses an authorize URL without a state', () => {
    expect(() => markDesktopState('https://provider.test/authorize?client_id=x')).toThrow()
    expect(() => markDesktopState('https://provider.test/authorize?mystate=x')).toThrow()
  })

  it('recognises and removes the mark', () => {
    expect(isDesktopState(`${DESKTOP_STATE_PREFIX}abc`)).toBe(true)
    expect(isDesktopState('abc')).toBe(false)
    expect(isDesktopState(undefined)).toBe(false)
    expect(unmarkDesktopState(`${DESKTOP_STATE_PREFIX}abc`)).toBe('abc')
    expect(unmarkDesktopState('abc')).toBe('abc')
  })
})

describe('desktop connect links', () => {
  it('round-trips the provider and its whole query', () => {
    const query = { state: `${DESKTOP_STATE_PREFIX}a&b`, code: 'c d', error_description: 'é' }
    expect(parseDesktopConnectLink(desktopConnectLink('slack', query))).toEqual({ provider: 'slack', query })
  })

  it('reads the relay page query without its provider field', () => {
    expect(parseDesktopConnectQuery('?state=s&code=c&provider=meta')).toEqual({
      provider: 'meta',
      query: { state: 's', code: 'c' },
    })
    expect(parseDesktopConnectQuery('?state=s&code=c')).toBeNull()
    expect(parseDesktopConnectQuery('?provider=../admin&state=s')).toBeNull()
  })

  it('rejects other schemes, hosts, providers and malformed URLs', () => {
    expect(parseDesktopConnectLink('https://integration/slack?state=s')).toBeNull()
    expect(parseDesktopConnectLink('doop://auth/slack?state=s')).toBeNull()
    expect(parseDesktopConnectLink('doop://connect/codex?origin=x')).toBeNull()
    expect(parseDesktopConnectLink('doop://integration/Sl%2Fack?state=s')).toBeNull()
    expect(parseDesktopConnectLink('doop://integration/?state=s')).toBeNull()
    expect(parseDesktopConnectLink('not a url')).toBeNull()
  })
})

describe('pending desktop connection', () => {
  /* node has no localStorage; the record only needs get/set/remove */
  const shim = new Map<string, string>()
  beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => shim.get(k) ?? null,
        setItem: (k: string, v: string) => void shim.set(k, v),
        removeItem: (k: string) => void shim.delete(k),
      },
    })
  })
  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })
  afterEach(() => shim.clear())

  it('recognises only the remembered provider, until forgotten', () => {
    expect(rememberPendingConnect('slack')).toBe(true)
    expect(isPendingConnect('slack')).toBe(true)
    expect(isPendingConnect('meta')).toBe(false)
    forgetPendingConnect('slack')
    expect(isPendingConnect('slack')).toBe(false)
  })

  it('keeps one connection waiting while another starts', () => {
    rememberPendingConnect('slack')
    rememberPendingConnect('meta')
    expect(isPendingConnect('slack')).toBe(true)
    expect(isPendingConnect('meta')).toBe(true)
    forgetPendingConnect('meta')
    expect(isPendingConnect('slack')).toBe(true)
    expect(isPendingConnect('meta')).toBe(false)
  })

  it('drops expired entries when a new connection starts', () => {
    rememberPendingConnect('slack', 1_000)
    rememberPendingConnect('meta', 2_000 + PENDING_CONNECT_TTL_MS)
    expect(JSON.parse(shim.get('doop-desktop-connect') ?? '{}')).toEqual({ meta: 2_000 + PENDING_CONNECT_TTL_MS })
  })

  it('ignores a corrupt record', () => {
    shim.set('doop-desktop-connect', '{"slack":"yesterday"}')
    expect(isPendingConnect('slack')).toBe(false)
    shim.set('doop-desktop-connect', 'not json')
    expect(isPendingConnect('slack')).toBe(false)
    expect(rememberPendingConnect('slack')).toBe(true)
  })

  it('stops listening once the window has passed', () => {
    rememberPendingConnect('slack', 1_000)
    expect(isPendingConnect('slack', 1_000 + PENDING_CONNECT_TTL_MS)).toBe(true)
    expect(isPendingConnect('slack', 1_001 + PENDING_CONNECT_TTL_MS)).toBe(false)
  })

  it('reports blocked storage so the browser is never sent off', () => {
    const setItem = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(rememberPendingConnect('slack')).toBe(false)
    } finally {
      localStorage.setItem = setItem
    }
  })
})

describe('connecting from the desktop app', () => {
  let server: Server
  let slack: HttpServer
  let app: Client
  let otherAccount: Client

  beforeAll(async () => {
    slack = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        const form = new URLSearchParams(body)
        if (req.url !== '/oauth.v2.access' || form.get('code') !== 'good-code')
          return res.end(JSON.stringify({ ok: false, error: 'invalid_code' }))
        res.end(
          JSON.stringify({
            ok: true,
            access_token: 'xoxb-desktop',
            token_type: 'bot',
            bot_user_id: 'U0BOT',
            team: { id: 'T0DESKTOP', name: 'Desktop Workspace' },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => slack.listen(0, resolve))
    server = await startServer({
      SLACK_CLIENT_ID: 'slack-client',
      SLACK_CLIENT_SECRET: 'slack-secret',
      SLACK_SIGNING_SECRET: 'signing-secret',
      SLACK_API_URL: `http://localhost:${(slack.address() as AddressInfo).port}`,
    })
    app = await new Client(server).signUp('desktop-app@test.dev', 'App')
    otherAccount = await new Client(server).signUp('desktop-browser@test.dev', 'Browser')
  }, 60_000)

  afterAll(() => {
    server?.stop()
    slack?.close()
  })

  async function connected(client: Client) {
    const status = (await (await client.get('/api/integrations')).json()) as { slack: { connected: boolean } }
    return status.slack.connected
  }

  async function desktopState(client: Client) {
    const res = await client.post('/api/integrations/slack/start', { desktop: true })
    expect(res.status).toBe(200)
    return new URL(((await res.json()) as { url: string }).url).searchParams.get('state') ?? ''
  }

  it('marks the state only when the app asks', async () => {
    expect(await desktopState(app)).toMatch(new RegExp(`^${DESKTOP_STATE_PREFIX}`))
    const plain = await app.post('/api/integrations/slack/start')
    const state = new URL(((await plain.json()) as { url: string }).url).searchParams.get('state') ?? ''
    expect(isDesktopState(state)).toBe(false)
  })

  it('relays the redirect to the app from a signed-out browser or another account', async () => {
    const state = await desktopState(app)
    for (const browser of [new Client(server), otherAccount]) {
      const res = await browser.get(
        `/api/integrations/slack/callback?state=${encodeURIComponent(state)}&code=good-code`,
      )
      expect(res.status).toBe(302)
      const relay = new URL(res.headers.get('location') ?? '', server.base)
      expect(relay.pathname).toBe('/desktop/connect')
      expect(Object.fromEntries(relay.searchParams)).toEqual({ state, code: 'good-code', provider: 'slack' })
    }
    expect(await connected(app)).toBe(false)
    expect(await connected(otherAccount)).toBe(false)
  })

  it('still gates a callback the app did not begin', async () => {
    expect((await new Client(server).get('/api/integrations/slack/callback?state=plain&code=x')).status).toBe(401)
  })

  it('does not finish under another account', async () => {
    const state = await desktopState(app)
    const res = await otherAccount.post('/api/integrations/slack/complete', { query: { state, code: 'good-code' } })
    expect(((await res.json()) as { to: string }).to).toContain('slackError=')
    expect(await connected(otherAccount)).toBe(false)
    expect((await new Client(server).post('/api/integrations/slack/complete', { query: { state } })).status).toBe(401)
  })

  it('finishes under the app session, once', async () => {
    const state = await desktopState(app)
    const query = { state, code: 'good-code' }
    const res = await app.post('/api/integrations/slack/complete', { query })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ to: '/integrations?slack=connected' })
    expect(await connected(app)).toBe(true)

    const replay = await app.post('/api/integrations/slack/complete', { query })
    expect(((await replay.json()) as { to: string }).to).toContain('slackError=')
  })

  it('answers an unknown provider with not found', async () => {
    expect((await app.post('/api/integrations/nope/complete', { query: {} })).status).toBe(404)
  })
})
