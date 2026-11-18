import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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

describe('edit_frame_html', () => {
  it('inserts new_str literally, with no $ replacement patterns', async () => {
    const client = await new Client(server).signUp('dollar@test.dev', 'Dollar')
    const canvasId = (await (await client.post('/api/canvases', { name: 'Dollar' })).json()).id
    const frameId = (
      await (
        await client.post(`/api/canvases/${canvasId}/frames`, { name: 'f', html: '<p>a</p><b>old</b><p>z</p>' })
      ).json()
    ).id
    const { secret } = await (await client.post('/api/agent-keys', { name: 'Editor' })).json()
    const agent = new McpClient({ name: 'dollar-test', version: '1.0.0' })
    await agent.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    )
    try {
      const script = '<script>x = "$`" + "$\'" + "$&" + "$$"</script>'
      const result = await agent.callTool({
        name: 'edit_frame_html',
        arguments: { frame_id: frameId, old_str: '<b>old</b>', new_str: script, agent_name: 'Editor' },
      })
      expect(result.isError).toBeFalsy()
      const canvas = await (await client.get(`/api/canvases/${canvasId}`)).json()
      expect(canvas.frames.find((f: { id: string }) => f.id === frameId).html).toBe(`<p>a</p>${script}<p>z</p>`)
    } finally {
      await agent.close()
    }
  })
})
