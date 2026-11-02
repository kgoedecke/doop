import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/** The Integrations page's Slack surface against a real server: status,
 *  the install handoff, and disconnect. The OAuth exchange goes to a stub
 *  that stands in for slack.com/api. */
let server: Server
let slack: HttpServer
let owner: Client
let stranger: Client
const seen: string[] = []

beforeAll(async () => {
  slack = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push(`${req.url} ${body}`)
      res.setHeader('Content-Type', 'application/json')
      if (req.url !== '/oauth.v2.access') return res.end(JSON.stringify({ ok: false, error: 'unknown_method' }))
      const form = new URLSearchParams(body)
      if (form.get('code') !== 'good-code') return res.end(JSON.stringify({ ok: false, error: 'invalid_code' }))
      res.end(
        JSON.stringify({
          ok: true,
          access_token: 'xoxb-test-token',
          token_type: 'bot',
          bot_user_id: 'U0BOT',
          team: { id: 'T0TEST', name: 'Test Workspace' },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => slack.listen(0, resolve))
  const slackPort = (slack.address() as AddressInfo).port
  server = await startServer({
    SLACK_CLIENT_ID: 'slack-client',
    SLACK_CLIENT_SECRET: 'slack-secret',
    SLACK_SIGNING_SECRET: 'signing-secret',
    SLACK_API_URL: `http://localhost:${slackPort}`,
  })
  owner = await new Client(server).signUp('slack-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('slack-stranger@test.dev', 'Stranger')
}, 60_000)

afterAll(() => {
  server?.stop()
  slack?.close()
})

async function status(client: Client) {
  return ((await (await client.get('/api/integrations')).json()) as { slack: Record<string, unknown> }).slack
}

describe('Slack installation', () => {
  it('requires authentication', async () => {
    expect((await new Client(server).post('/api/integrations/slack/start')).status).toBe(401)
    expect((await new Client(server).get('/api/integrations/slack/callback?state=x&code=y')).status).toBe(401)
  })

  it('reports the app as configured but not connected', async () => {
    expect(await status(owner)).toMatchObject({ connected: false, agentConfigured: true })
  })

  it('hands off to Slack with one-time state and lands back connected', async () => {
    const start = await owner.post('/api/integrations/slack/start')
    expect(start.status).toBe(200)
    const url = new URL(((await start.json()) as { url: string }).url)
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(url.searchParams.get('client_id')).toBe('slack-client')
    const state = url.searchParams.get('state')!

    const wrongUser = await stranger.get(`/api/integrations/slack/callback?state=${state}&code=good-code`)
    expect(wrongUser.status).toBe(302)
    expect(wrongUser.headers.get('location')).toContain('slackError=')
    expect(await status(stranger)).toMatchObject({ connected: false })

    const fresh = new URL(((await (await owner.post('/api/integrations/slack/start')).json()) as { url: string }).url)
    const callback = await owner.get(
      `/api/integrations/slack/callback?state=${fresh.searchParams.get('state')}&code=good-code`,
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/integrations?slack=connected')
    const connected = await status(owner)
    expect(connected).toMatchObject({ connected: true, workspaceName: 'Test Workspace' })
    expect(JSON.stringify(connected)).not.toContain('xoxb-test-token')
    expect(seen.some((line) => line.includes('client_secret=slack-secret'))).toBe(true)

    const replay = await owner.get(
      `/api/integrations/slack/callback?state=${fresh.searchParams.get('state')}&code=good-code`,
    )
    expect(replay.headers.get('location')).toContain('slackError=')
  })

  it('keeps the installation when Slack rejects the code', async () => {
    const start = new URL(((await (await owner.post('/api/integrations/slack/start')).json()) as { url: string }).url)
    const callback = await owner.get(
      `/api/integrations/slack/callback?state=${start.searchParams.get('state')}&code=bad`,
    )
    expect(callback.headers.get('location')).toContain('slackError=')
    expect(await status(owner)).toMatchObject({ connected: true })
  })

  it('refuses a second installer for the same workspace', async () => {
    const start = new URL(
      ((await (await stranger.post('/api/integrations/slack/start')).json()) as { url: string }).url,
    )
    const callback = await stranger.get(
      `/api/integrations/slack/callback?state=${start.searchParams.get('state')}&code=good-code`,
    )
    expect(decodeURIComponent(callback.headers.get('location') ?? '')).toContain('already has a Doop installer')
    expect(await status(stranger)).toMatchObject({ connected: false })
  })

  it('disconnect is isolated by user and idempotent', async () => {
    expect((await stranger.delete('/api/integrations/slack')).status).toBe(200)
    expect(await status(owner)).toMatchObject({ connected: true })
    const response = await owner.delete('/api/integrations/slack')
    expect(((await response.json()) as { slack: { connected: boolean } }).slack).toMatchObject({ connected: false })
    expect((await owner.delete('/api/integrations/slack')).status).toBe(200)
  })

  it('refuses unsigned webhook traffic', async () => {
    const response = await fetch(`${server.base}/webhooks/slack`, {
      method: 'POST',
      body: JSON.stringify({ type: 'url_verification', challenge: 'x' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(response.status).toBe(401)
  })
})
