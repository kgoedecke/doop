import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/*
 * The agent API (/api/v1, server/agentApi.ts) against the real server: frames as raw HTML
 * bodies, behind an agent key, with the frame's version as the ETag a write is held against.
 */

let server: Server
let owner: Client
let key = ''
let strangerKey = ''
let canvasId = ''

async function api(path: string, init: RequestInit & { as?: string } = {}) {
  const { as = key, ...rest } = init
  return fetch(`${server.base}/api/v1${path}`, {
    ...rest,
    headers: {
      ...(as ? { Authorization: `Bearer ${as}` } : {}),
      'Doop-Agent': 'Tester',
      ...(rest.body === undefined ? {} : { 'Content-Type': 'text/html' }),
      ...rest.headers,
    },
  })
}

async function keyFor(client: Client): Promise<string> {
  return ((await (await client.post('/api/agent-keys', { name: 'api' })).json()) as { secret: string }).secret
}

interface Written {
  frame: { id: string; name: string; version: string; width: number; updatedBy: string }
  html_changed: boolean
  warnings: string[]
  notes: string[]
  feedback: unknown[]
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('agent-api@test.dev', 'Owner')
  key = await keyFor(owner)
  strangerKey = await keyFor(await new Client(server).signUp('agent-api-stranger@test.dev', 'Stranger'))
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Agent API' })).json()) as { id: string }).id
}, 70_000)

afterAll(() => server?.stop())

describe('the agent API', () => {
  let frameId = ''
  let version = ''

  it('takes an agent key and nothing else', async () => {
    expect(
      (await api(`/canvases/${canvasId}/frames?name=X`, { method: 'POST', body: '<p>x</p>', as: '' })).status,
    ).toBe(401)
    const badKey = await api(`/canvases/${canvasId}/frames?name=X`, {
      method: 'POST',
      body: '<p>x</p>',
      as: 'dpk_nope',
    })
    expect(badKey.status).toBe(401)
    expect(((await badKey.json()) as { error: { code: string } }).error.code).toBe('unauthorized')
    /* a browser session is not a way in: these routes sit ahead of the session gate */
    const withCookie = await owner.req(`/api/v1/canvases/${canvasId}/frames?name=X`, {
      method: 'POST',
      body: '<p>x</p>',
      headers: { 'Content-Type': 'text/html' },
    })
    expect(withCookie.status).toBe(401)
    expect((await api('/nothing/here')).status).toBe(404)
  })

  it('creates a frame from a raw body and reads it back as HTML', async () => {
    const created = await api(`/canvases/${canvasId}/frames?name=Hero&width=800&height=600`, {
      method: 'POST',
      body: '<main><h1>Hello</h1></main>',
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as Written
    expect(body.frame).toMatchObject({ name: 'Hero', width: 800, updatedBy: 'Tester' })
    expect(body.html_changed).toBe(false)
    frameId = body.frame.id
    version = body.frame.version
    expect(created.headers.get('etag')).toBe(`"${version}"`)

    const read = await api(`/frames/${frameId}/html`)
    expect(read.headers.get('content-type')).toContain('text/html')
    expect(read.headers.get('etag')).toBe(`"${version}"`)
    expect(await read.text()).toBe('<main><h1>Hello</h1></main>')
    const meta = JSON.parse(decodeURIComponent(read.headers.get('doop-frame') ?? '')) as { id: string }
    expect(meta.id).toBe(frameId)
    expect((await api(`/canvases/${canvasId}/frames`, { method: 'POST', body: '<p>x</p>' })).status).toBe(400)
  })

  it('hides a frame from a key whose account cannot open the canvas', async () => {
    expect((await api(`/frames/${frameId}/html`, { as: strangerKey })).status).toBe(404)
    const write = await api(`/frames/${frameId}/html`, { method: 'PUT', body: '<p>theirs</p>', as: strangerKey })
    expect(write.status).toBe(404)
    expect(await (await api(`/frames/${frameId}/html`)).text()).toContain('Hello')
  })

  it('writes only while the frame is at the version the client edited', async () => {
    const first = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: '<main><h1>Second</h1></main>',
      headers: { 'If-Match': `"${version}"` },
    })
    expect(first.status).toBe(200)
    const next = ((await first.json()) as Written).frame.version
    expect(next).not.toBe(version)

    const stale = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: '<main><h1>From the older file</h1></main>',
      headers: { 'If-Match': `"${version}"` },
    })
    expect(stale.status).toBe(409)
    const refusal = (await stale.json()) as {
      error: { code: string; frame: { version: string; updatedBy: string; width: number } }
    }
    expect(refusal.error).toMatchObject({ code: 'conflict', frame: { version: next, updatedBy: 'Tester', width: 800 } })
    expect(await (await api(`/frames/${frameId}/html`)).text()).toContain('Second')

    const garbled = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: '<p>x</p>',
      headers: { 'If-Match': '"yesterday"' },
    })
    expect(garbled.status).toBe(400)
    /* no If-Match writes whatever is there */
    expect((await api(`/frames/${frameId}/html`, { method: 'PUT', body: '<main><h1>Third</h1></main>' })).status).toBe(
      200,
    )
  })

  it('refuses inline data and a body that is not HTML, writing nothing', async () => {
    const inline = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: `<main><img src="data:image/png;base64,${'A'.repeat(4000)}"></main>`,
    })
    expect(inline.status).toBe(422)
    const refused = (await inline.json()) as { error: { code: string; message: string } }
    expect(refused.error.code).toBe('refused')
    expect(refused.error.message).toContain('base64')

    /* a JSON body would otherwise arrive parsed, and blank the frame */
    const json = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: JSON.stringify({ html: '<p>x</p>' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(json.status).toBe(400)
    expect(await (await api(`/frames/${frameId}/html`)).text()).toContain('Third')
  })

  it('says what could not be done with components, and serves the rendered form', async () => {
    const written = await api(`/frames/${frameId}/html`, {
      method: 'PUT',
      body: '<main><h1>Fourth</h1><doop-use component="Nope"></doop-use></main>',
    })
    expect(written.status).toBe(200)
    expect(((await written.json()) as Written).warnings).toEqual([expect.stringContaining('no component “Nope”')])

    const tokens = await owner.post(`/api/canvases/${canvasId}/tokens`, {
      tokens: [{ name: '--color-brand', type: 'color', value: '#0177d3' }],
    })
    expect(tokens.status).toBe(200)
    const source = '<main><h1 style="color: var(--color-brand)">Fifth</h1></main>'
    expect((await api(`/frames/${frameId}/html`, { method: 'PUT', body: source })).status).toBe(200)
    /* the source names the token; the rendered form carries its value */
    expect(await (await api(`/frames/${frameId}/html`)).text()).toBe(source)
    expect(await (await api(`/frames/${frameId}/html?form=rendered`)).text()).toContain('#0177d3')
  })
})
