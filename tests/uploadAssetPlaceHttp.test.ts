import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Canvas } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

/* upload_asset's `place` drops the image on the canvas the way a person's
   file drop does: over the tool call for base64 bytes, and over the one-time
   ticket for a local file, whose bytes arrive in a later request. */

let server: Server
let owner: Client
let agent: McpClient

/** The body marker the editor reads a standalone element by (src/lib/drawing.ts). */
function isCanvasElement(html: string): boolean {
  return /<body\b[^>]*\bdata-doop-canvas-element=/i.test(html)
}

/** The start of a PNG: enough for the type sniff and the size. */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'latin1')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

interface Placed {
  ok: boolean
  url: string
  upload_url?: string
  frame?: { id: string; pageId: string; name: string; x: number; y: number; width: number; height: number }
}

async function upload(args: Record<string, unknown>): Promise<{ isError: boolean; raw: string; json: Placed }> {
  const result = await agent.callTool({ name: 'upload_asset', arguments: { agent_name: 'Placer', ...args } })
  const blocks = result.content as Array<{ type: string; text?: string }>
  const raw = blocks.find((block) => block.type === 'text')?.text ?? ''
  return { isError: result.isError === true, raw, json: result.isError ? ({} as Placed) : JSON.parse(raw) }
}

async function newCanvas(name: string): Promise<Canvas> {
  return (await owner.post('/api/canvases', { name })).json()
}

async function load(canvasId: string): Promise<Canvas> {
  return (await owner.get(`/api/canvases/${canvasId}`)).json()
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('placer@test.dev', 'Placer Owner')
  const { secret } = await (await owner.post('/api/agent-keys', { name: 'Placing agent' })).json()
  agent = new McpClient({ name: 'place-client', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
}, 60_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
})

it('places uploaded bytes as a standalone image element at the asked spot', async () => {
  const canvas = await newCanvas('Placed')
  const { json } = await upload({
    canvas_id: canvas.id,
    data: png(1800, 900).toString('base64'),
    place: { x: 40, y: 60, name: 'Hero "shot"' },
  })
  /* the picture's proportions, capped at 900px like a dropped file */
  expect(json.frame).toMatchObject({ name: 'Hero "shot"', x: 40, y: 60, width: 900, height: 450 })

  const frame = (await load(canvas.id)).frames.find((f) => f.id === json.frame?.id)
  expect(frame).toBeDefined()
  expect(isCanvasElement(frame!.html)).toBe(true)
  expect(frame!.html).toContain(`src="${json.url}"`)
  expect(frame!.html).toContain('data-doop-drawing="image"')
  expect(frame!.html).toContain('data-name="Hero &quot;shot&quot;"')
  /* the asset itself is served */
  expect((await fetch(json.url)).status).toBe(200)
})

it('auto-places beside the page’s frames and takes a width', async () => {
  const canvas = await newCanvas('Auto')
  const first = await upload({ canvas_id: canvas.id, data: png(200, 100).toString('base64'), place: {} })
  expect(first.json.frame).toMatchObject({ name: 'Image', width: 200, height: 100 })
  const second = await upload({ canvas_id: canvas.id, data: png(200, 100).toString('base64'), place: { width: 50 } })
  expect(second.json.frame).toMatchObject({ width: 50, height: 25 })
  expect(second.json.frame!.x).toBeGreaterThanOrEqual(first.json.frame!.x + 200)
})

it('places a local file when its bytes reach the upload ticket', async () => {
  const canvas = await newCanvas('Ticket')
  const page = (await load(canvas.id)).pages?.[0]?.id
  const ticket = await upload({
    canvas_id: canvas.id,
    local_file: true,
    place: { x: 10, y: 20, name: 'Logo', page_id: page },
  })
  expect(ticket.json.upload_url).toBeDefined()
  /* nothing lands until the file does */
  expect((await load(canvas.id)).frames).toHaveLength(0)

  const sent = await fetch(ticket.json.upload_url!, { method: 'PUT', body: new Uint8Array(png(64, 32)) })
  const placed = (await sent.json()) as Placed
  expect(placed.frame).toMatchObject({ name: 'Logo', x: 10, y: 20, width: 64, height: 40 })

  const frames = (await load(canvas.id)).frames
  expect(frames).toHaveLength(1)
  expect(isCanvasElement(frames[0]!.html)).toBe(true)
  expect(frames[0]!.html).toContain(`src="${placed.url}"`)
})

it('only returns the URL without place, and refuses a page the canvas lacks', async () => {
  const canvas = await newCanvas('Plain')
  const plain = await upload({ canvas_id: canvas.id, data: png(10, 10).toString('base64') })
  expect(plain.json.url).toContain('/a/')
  expect(plain.json.frame).toBeUndefined()

  const refused = await upload({
    canvas_id: canvas.id,
    data: png(10, 10).toString('base64'),
    place: { page_id: 'nowhere' },
  })
  expect(refused.isError).toBe(true)
  expect(refused.raw).toContain('no page nowhere')
  expect((await load(canvas.id)).frames).toHaveLength(0)
})

it('stores but does not place a ticketed file once its uploader lost edit access', async () => {
  const host = await new Client(server).signUp('place-host@test.dev', 'Place Host')
  const canvas: Canvas = await (await host.post('/api/canvases', { name: 'Shared' })).json()
  const invited = await (await host.post(`/api/canvases/${canvas.id}/members`, { email: 'placer@test.dev' })).json()
  const ticket = await upload({ canvas_id: canvas.id, local_file: true, place: { x: 0, y: 0 } })
  expect(ticket.json.upload_url).toBeDefined()

  expect((await host.delete(`/api/canvases/${canvas.id}/members/${invited.userId}`)).status).toBe(200)
  const sent = await fetch(ticket.json.upload_url!, { method: 'PUT', body: new Uint8Array(png(64, 64)) })
  const stored = (await sent.json()) as Placed
  expect(stored.url).toContain('/a/')
  expect(stored.frame).toBeUndefined()
  const frames = ((await (await host.get(`/api/canvases/${canvas.id}`)).json()) as Canvas).frames
  expect(frames).toHaveLength(0)
})
