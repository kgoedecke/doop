import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Frame HTML writes against the REAL server (see ./harness.ts). Agents have
 * shipped whole documents as entities, which the frame iframe then renders as
 * visible source text — these tests pin the repair down to what is stored.
 */

const PORT = 4979

let server: Server

beforeAll(async () => {
  server = await startServer(PORT)
}, 70_000)

afterAll(() => server?.stop())

describe('escaped HTML never reaches a frame', () => {
  let client: Client
  let canvasId: string
  beforeAll(async () => {
    client = new Client(server)
    await client.signUp('frames@test.dev', 'Framer')
    canvasId = (await (await client.post('/api/canvases', { name: 'HTML' })).json()).id
  })

  async function newFrame(name: string): Promise<string> {
    return (await (await client.post(`/api/canvases/${canvasId}/frames`, { name })).json()).id
  }
  async function htmlOf(frameId: string): Promise<string> {
    const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
    return canvas.frames.find((f: { id: string }) => f.id === frameId).html
  }

  it('decodes a one-shot write sent as entities', async () => {
    const id = await newFrame('one-shot')
    await client.patch(`/api/frames/${id}`, {
      html: '&lt;!doctype html&gt;&lt;html&gt;&lt;body&gt;&lt;h1&gt;Hi&lt;/h1&gt;&lt;/body&gt;&lt;/html&gt;',
    })
    expect(await htmlOf(id)).toBe('<!doctype html><html><body><h1>Hi</h1></body></html>')
  })

  it('decodes every chunk of a stream whose opening chunk was escaped', async () => {
    const id = await newFrame('escaped stream')
    /* only the first chunk is sniffed; the rest ride the latch — the middle one
       holds no entity at all and must still land in an unescaped document */
    await client.post(`/api/frames/${id}/append`, { html_chunk: '&lt;!doctype html&gt;&lt;html&gt;', start: true })
    await client.post(`/api/frames/${id}/append`, { html_chunk: '&lt;body class=&quot;p&quot;&gt;' })
    await client.post(`/api/frames/${id}/append`, { html_chunk: 'plain text' })
    await client.post(`/api/frames/${id}/append`, { html_chunk: '&lt;/body&gt;&lt;/html&gt;', done: true })
    expect(await htmlOf(id)).toBe('<!doctype html><html><body class="p">plain text</body></html>')
  })

  it('leaves a raw stream untouched, escaped code samples included', async () => {
    const id = await newFrame('raw stream')
    const doc = '<!doctype html><html><body><code>&lt;div class="card"&gt;</code></body></html>'
    await client.post(`/api/frames/${id}/append`, { html_chunk: doc.slice(0, 30), start: true })
    await client.post(`/api/frames/${id}/append`, { html_chunk: doc.slice(30), done: true })
    expect(await htmlOf(id)).toBe(doc)
  })

  it('accepts a source edit only when the expected HTML still matches', async () => {
    const id = await newFrame('guarded inspector')
    const before = '<p>Original</p>'
    await client.patch(`/api/frames/${id}`, { html: before })
    const ok = await client.patch(`/api/frames/${id}`, {
      expectedHtml: before,
      html: '<p style="color:red">Original</p>',
    })
    expect(ok.status).toBe(200)
    const stale = await client.patch(`/api/frames/${id}`, {
      expectedHtml: before,
      html: '<p>Stale draft</p>',
      name: 'stale',
    })
    expect(stale.status).toBe(409)
    expect(await htmlOf(id)).toBe('<p style="color:red">Original</p>')
    const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.frames.find((f: { id: string }) => f.id === id).name).toBe('guarded inspector')
  })

  it('rejects malformed preconditions and keeps legacy edits working', async () => {
    const id = await newFrame('guard format')
    expect((await client.patch(`/api/frames/${id}`, { expectedHtml: 42, html: '<p>Bad</p>' })).status).toBe(400)
    expect((await client.patch(`/api/frames/${id}`, { html: '<p>Legacy</p>' })).status).toBe(200)
    expect(await htmlOf(id)).toBe('<p>Legacy</p>')
  })

  it('checks authorization before disclosing a stale-source conflict', async () => {
    const id = await newFrame('private inspector')
    const stranger = new Client(server)
    await stranger.signUp('inspector-outsider@test.dev', 'Outsider')
    const response = await stranger.patch(`/api/frames/${id}`, { expectedHtml: 'wrong', html: '<p>No</p>' })
    expect(response.status).toBe(403)
  })
})
