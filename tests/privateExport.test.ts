import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'

let fixture: Awaited<ReturnType<typeof startPrivateServer>> | undefined
let client: McpClient | undefined
let owner: Client
let stranger: Client
let frameId: string
let canvasId: string
let fontFrameId: string
let foreignFrameId: string
let key: { id: string; secret: string } | undefined

/** Optional retained synthetic result for the real Openbot consumer check.
 * This records output only; it never changes the request or authorization. */
async function captureResult(name: string, result: unknown) {
  const directory = process.env.DOOP_PRIVATE_EXPORT_CAPTURE
  if (!directory) return
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, `${name}.json`), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
}

beforeAll(async () => {
  fixture = await startPrivateServer()
  owner = await new Client(fixture.server).signUp('private-export@test.dev', 'Private export')
  stranger = await new Client(fixture.server).signUp('foreign-export@test.dev', 'Foreign export')
  const canvas = await (await owner.post('/api/canvases', { name: 'Export byte boundary' })).json()
  canvasId = canvas.id
  const pixels = Buffer.alloc(320 * 240 * 3)
  let seed = 0x12345678
  for (let at = 0; at < pixels.length; at++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    pixels[at] = seed & 0xff
  }
  const image = await sharp(pixels, { raw: { width: 320, height: 240, channels: 3 } })
    .png()
    .toBuffer()
  const uploaded = await owner.req(`/api/canvases/${canvas.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(image),
  })
  expect(uploaded.status).toBe(200)
  const url = (await uploaded.json()).url
  const created = await owner.post(`/api/canvases/${canvas.id}/frames`, {
    name: 'Dense private pixels',
    x: 0,
    y: 0,
    width: 320,
    height: 240,
    html: `<style>html,body{margin:0}</style><img width="320" height="240" src="${url}">`,
  })
  expect(created.status).toBe(200)
  frameId = (await created.json()).id
  const font = await readFile('tests/fixtures/fonts/nunito-sans-bold-italic.woff2')
  const uploadedFont = await owner.req(`/api/fonts?canvas=${canvasId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'nunito-sans-bold-italic.woff2' },
    body: new Uint8Array(font),
  })
  expect(uploadedFont.status).toBe(200)
  const fontUrl = (await uploadedFont.json()).url
  const fontFrame = await owner.post(`/api/canvases/${canvasId}/frames`, {
    name: 'Private PDF font',
    x: 400,
    y: 0,
    width: 200,
    height: 120,
    html: `<style>@font-face{font-family:ExportFixture;src:url("${fontUrl}")}body{margin:0;font:16px ExportFixture}</style><p>Private PDF font</p><img width="32" height="24" src="${url}">`,
  })
  expect(fontFrame.status).toBe(200)
  fontFrameId = (await fontFrame.json()).id
  const foreign = await (await owner.post('/api/canvases', { name: 'Separately authorized parent' })).json()
  const foreignFrame = await owner.post(`/api/canvases/${foreign.id}/frames`, {
    name: 'Other parent',
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    html: '<p>Other parent</p>',
  })
  expect(foreignFrame.status).toBe(200)
  foreignFrameId = (await foreignFrame.json()).id
  const raw = await owner.get(`/i/${frameId}.png`)
  expect(raw.status).toBe(200)
  expect((await raw.arrayBuffer()).byteLength).toBeGreaterThan(12_288)
  key = await (await owner.post('/api/agent-keys', { name: 'Owned export fixture' })).json()
  if (!key?.secret) throw new Error('normal fixture MCP credential was not created')
  client = new McpClient({ name: 'private-export-consumer', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', fixture.server.base), {
      requestInit: { headers: { Authorization: `Bearer ${key.secret}` } },
    }),
  )
  await captureResult('tools', await client.listTools())
}, 60_000)

afterAll(async () => {
  try {
    await client?.close()
  } finally {
    try {
      if (key && fixture) await owner.delete(`/api/agent-keys/${key.id}`)
    } finally {
      await fixture?.close()
    }
  }
})

it('get_frame_screenshot returns a real image within the workflow 16 KiB inline field budget', async () => {
  const result = await client!.callTool({ name: 'get_frame_screenshot', arguments: { frame_id: frameId } })
  await captureResult('screenshot', result)
  expect(
    result.isError,
    JSON.stringify((result.content as { type: string; text?: string }[]).filter((block) => block.type === 'text')),
  ).not.toBe(true)
  const blocks = result.content as { type: string; data?: string; mimeType?: string }[]
  const image = blocks.find((block) => block.type === 'image')
  expect(image).toBeDefined()
  expect(image!.data!.length).toBeLessThanOrEqual(16_384)
  const decoded = sharp(Buffer.from(image!.data!, 'base64'))
  const dimensions = await decoded.metadata()
  expect(dimensions.width).toBeGreaterThan(0)
  expect(dimensions.width).toBeLessThanOrEqual(320)
  expect((await decoded.stats()).channels.some((channel) => channel.stdev > 1)).toBe(true)
  const metadata = JSON.parse(
    (result.content as { type: string; text?: string }[]).find((block) => block.type === 'text')!.text!,
  )
  expect(metadata.inline).toMatchObject({
    mime_type: image!.mimeType,
    full_resolution: false,
  })
  expect(await sharp(Buffer.from(image!.data!, 'base64')).metadata()).toMatchObject({
    width: metadata.inline.width,
    height: metadata.inline.height,
  })
  expect(metadata.width).toBe(320)
  expect(metadata.height).toBe(240)
  for (const block of result.content as { type: string; text?: string }[])
    if (block.type === 'text') expect(block.text!.length).toBeLessThanOrEqual(16_384)
})

it.each(['png', 'jpg'] as const)(
  'export_frame %s supplies bounded media and a current-session full download',
  async (format) => {
    const result = await client!.callTool({ name: 'export_frame', arguments: { frame_id: frameId, format } })
    await captureResult(format, result)
    expect(result.isError).not.toBe(true)
    const blocks = result.content as { type: string; data?: string; text?: string }[]
    const image = blocks.find((block) => block.type === 'image')
    expect(image).toBeDefined()
    expect(image!.data!.length).toBeLessThanOrEqual(16_384)
    const metadata = blocks
      .filter((block) => block.type === 'text')
      .map((block) => {
        try {
          return JSON.parse(block.text!)
        } catch {
          return null
        }
      })
      .find((value) => typeof value?.download_url === 'string')
    expect(metadata).toBeDefined()
    expect(metadata.inline.full_resolution).toBe(false)
    expect(metadata.inline.mime_type).toBe('image/jpeg')
    expect(await sharp(Buffer.from(image!.data!, 'base64')).metadata()).toMatchObject({
      width: metadata.inline.width,
      height: metadata.inline.height,
    })
    const url = new URL(metadata.download_url)
    expect(url.origin).toBe(new URL(fixture!.server.base).origin)
    const authorized = await owner.get(url.pathname + url.search)
    expect(authorized.status).toBe(200)
    const full = await sharp(Buffer.from(await authorized.arrayBuffer())).metadata()
    expect(full.width).toBe(640)
    expect(full.height).toBe(480)
    const signedOut = await fetch(url)
    expect(signedOut.status).toBe(404)
    expect((await stranger.get(url.pathname + url.search)).status).toBe(404)
    const bearerOnly = await fetch(url, { headers: { Authorization: `Bearer ${key!.secret}` } })
    expect(bearerOnly.status).toBe(404)
    expect(String(metadata.note).includes('no auth needed')).toBe(false)
  },
)

it('large PDF exports keep inline blobs bounded and provide an authenticated full file location', async () => {
  const result = await client!.callTool({
    name: 'export_frame',
    arguments: { frame_id: frameId, frame_ids: [fontFrameId], format: 'pdf' },
  })
  await captureResult('pdf', result)
  expect(result.isError).not.toBe(true)
  const blocks = result.content as { type: string; text?: string; resource?: { blob?: string } }[]
  for (const block of blocks) if (block.resource?.blob) expect(block.resource.blob.length).toBeLessThanOrEqual(16_384)
  const metadata = blocks
    .filter((block) => block.type === 'text')
    .map((block) => {
      try {
        return JSON.parse(block.text!)
      } catch {
        return null
      }
    })
    .find((value) => typeof value?.download_url === 'string')
  expect(metadata).toBeDefined()
  expect(metadata.inline_embedded).toBe(false)
  expect(metadata.pages).toBe(2)
  const url = new URL(metadata.download_url)
  expect(url.origin).toBe(new URL(fixture!.server.base).origin)
  const file = await owner.get(url.pathname + url.search)
  expect(file.status).toBe(200)
  const bytes = Buffer.from(await file.arrayBuffer())
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  const pdf = await PDFDocument.load(bytes)
  expect(pdf.getPages().map((page) => Math.round(page.getWidth()))).toEqual([240, 150])
  expect(
    pdf.context
      .enumerateIndirectObjects()
      .some(
        ([, object]) =>
          object instanceof PDFDict && (object.has(PDFName.of('FontFile2')) || object.has(PDFName.of('FontFile3'))),
      ),
  ).toBe(true)
  expect([401, 403, 404]).toContain((await fetch(url)).status)
  expect((await stranger.get(url.pathname + url.search)).status).toBe(404)
  expect((await fetch(url, { headers: { Authorization: `Bearer ${key!.secret}` } })).status).toBe(401)
})

it('PDF selection cannot mix parents even when the caller can read both', async () => {
  const result = await client!.callTool({
    name: 'export_frame',
    arguments: { frame_id: frameId, frame_ids: [foreignFrameId], format: 'pdf' },
  })
  expect(result.isError).toBe(true)
  expect((result.content as { type: string }[]).every((block) => block.type === 'text')).toBe(true)
})

it('owner deletion denies subsequent MCP and normal browser exports without a cached fallback', async () => {
  expect((await owner.delete(`/api/canvases/${canvasId}`)).status).toBe(200)
  for (const [name, args] of [
    ['get_frame_screenshot', { frame_id: frameId }],
    ['export_frame', { frame_id: frameId, format: 'png' }],
    ['export_frame', { frame_id: frameId, format: 'pdf', frame_ids: [fontFrameId] }],
  ] as const) {
    const result = await client!.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    expect((result.content as { type: string }[]).every((block) => block.type === 'text')).toBe(true)
  }
  expect((await owner.get(`/i/${frameId}.png`)).status).toBe(404)
})
