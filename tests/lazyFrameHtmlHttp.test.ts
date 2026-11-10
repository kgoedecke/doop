import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Canvas, Frame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/* After a restart no canvas has its frame HTML in memory: every way in
   (REST, the room, MCP) loads it first, and a canvas that goes idle gives
   it back and loads again on the next visit. CANVAS_IDLE_MS is short here so
   the sweep runs every second. */

let server: Server
let owner: Client
let canvas: Canvas
let frame: Frame

const env = { CANVAS_IDLE_MS: '1500' }

beforeAll(async () => {
  const first = await startServer(env)
  owner = await new Client(first).signUp('lazy@test.dev', 'Lazy Owner')
  canvas = await (await owner.post('/api/canvases', { name: 'Lazy' })).json()
  frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Card', html: '<p>stored card</p>' })
  ).json()
  first.stop({ keepData: true })
  await first.stopped
  server = await startServer(env, first.dataDir)
  owner = new Client(server)
  const signIn = await owner.post('/api/auth/sign-in/email', { email: 'lazy@test.dev', password: 'password12345' })
  expect(signIn.status).toBe(200)
}, 120_000)

afterAll(() => server?.stop())

async function storedHtml(): Promise<string | undefined> {
  const loaded: Canvas = await (await owner.get(`/api/canvases/${canvas.id}`)).json()
  return loaded.frames.find((f) => f.id === frame.id)?.html
}

it('serves frame html over REST after a restart', async () => {
  expect(await storedHtml()).toBe('<p>stored card</p>')
})

it('sends frame html in the room init after a restart', async () => {
  expect(await owner.joinWs(canvas.id)).toEqual({ kind: 'init' })
})

/** canvases with frame HTML in memory, as /healthz/store reports it */
async function loadedCanvases(): Promise<number> {
  return ((await (await fetch(`${server.base}/healthz/store`)).json()) as { loaded: number }).loaded
}

/* before the MCP test: an agent's presence keeps its canvas loaded */
it('drops an idle canvas and loads it again on the next visit', async () => {
  await expect.poll(loadedCanvases, { timeout: 10_000, interval: 250 }).toBe(0)
  expect(await storedHtml()).toBe('<p>stored card</p>')
  expect(await loadedCanvases()).toBe(1)
  expect((await owner.patch(`/api/frames/${frame.id}`, { html: '<p>after idle</p>' })).status).toBe(200)
  expect(await storedHtml()).toBe('<p>after idle</p>')
}, 20_000)

it('reads and edits frame html over MCP', async () => {
  const { secret } = await (await owner.post('/api/agent-keys', { name: 'Lazy agent' })).json()
  const agent = new McpClient({ name: 'lazy-client', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  try {
    const read = await agent.callTool({ name: 'get_frame', arguments: { frame_id: frame.id, agent_name: 'Lazy' } })
    expect(read.isError).toBeFalsy()
    expect(JSON.stringify(read.content)).toContain('after idle')
    const edit = await agent.callTool({
      name: 'edit_frame_html',
      arguments: { frame_id: frame.id, old_str: 'after idle', new_str: 'edited card', agent_name: 'Lazy' },
    })
    expect(edit.isError, JSON.stringify(edit.content)).toBeFalsy()
  } finally {
    await agent.close()
  }
  expect(await storedHtml()).toBe('<p>edited card</p>')
})
