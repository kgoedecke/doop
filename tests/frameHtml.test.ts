import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Frame HTML writes against the REAL server (see ./harness.ts). Agents have
 * shipped whole documents as entities, which the frame iframe then renders as
 * visible source text — these tests pin the repair down to what is stored.
 */

let server: Server

beforeAll(async () => {
  server = await startServer()
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
})
