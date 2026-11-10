import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PDFDocument } from 'pdf-lib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../server/auth.ts', async (original) => ({
  ...(await original<typeof import('../server/auth.ts')>()),
  isBanned: async () => false,
}))
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/** export_frame's PDF format: the file comes back inside the tool result. */

const OWNER_ID = 'pdf-owner'

function frame(id: string, x: number, width: number, height: number): Frame {
  return {
    id,
    canvasId: 'pdf-canvas',
    name: id,
    /* This control has no font/image payload so the real multipage PDF fits
       the inline field budget. Dense media/download cases use privateExport. */
    html: '<!doctype html><html><body style="margin:0;background:#18a74a"></body></html>',
    x,
    y: 0,
    width,
    height,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'alice',
  }
}

const SLIDE = frame('slide', 0, 640, 360)
const POSTER = frame('poster', 800, 300, 500)
const CANVAS: Canvas = {
  id: 'pdf-canvas',
  name: 'Pitch',
  ownerId: OWNER_ID,
  createdAt: 0,
  updatedAt: 0,
  frames: [POSTER, SLIDE],
}

interface CallResult {
  content: Array<{ type: string; text?: string; resource?: { mimeType?: string; blob?: string } }>
  isError?: boolean
}

async function exportFrame(ownerId: string, args: Record<string, unknown>): Promise<CallResult> {
  const server = buildMcpServer('Test Owner', ownerId, undefined, undefined, {
    actorId: ownerId,
    currentActor: async () => ownerId,
  })
  const client = new Client({ name: 'doop-pdf-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return (await client.callTool({ name: 'export_frame', arguments: args })) as unknown as CallResult
  } finally {
    await client.close()
    await server.close()
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) => CANVAS.frames.find((f) => f.id === id))
})

describe('export_frame format pdf', () => {
  it('stays behind the canvas gate', async () => {
    const result = await exportFrame('someone-else', { frame_id: SLIDE.id, format: 'pdf' })
    expect(result.isError).toBe(true)
  })

  it('refuses extra frames from elsewhere', async () => {
    const result = await exportFrame(OWNER_ID, { frame_id: SLIDE.id, format: 'pdf', frame_ids: ['missing'] })
    expect(result.isError).toBe(true)
  })

  it('returns one multi-page PDF as an embedded resource, pages in the order given', async () => {
    /* the poster sits right of the slide on the canvas, but it was named first */
    const result = await exportFrame(OWNER_ID, { frame_id: POSTER.id, format: 'pdf', frame_ids: [SLIDE.id] })
    expect(result.isError).toBeFalsy()
    const resource = result.content.find((block) => block.type === 'resource')?.resource
    expect(resource?.mimeType).toBe('application/pdf')
    const pdf = await PDFDocument.load(Buffer.from(resource!.blob!, 'base64'))
    expect(pdf.getPages().map((page) => Math.round(page.getWidth()))).toEqual([225, 480])
    const meta = JSON.parse(result.content.find((block) => block.type === 'text')!.text!)
    expect(meta).toMatchObject({ file_name: 'Pitch.pdf', pages: 2, inline_embedded: true })
    expect(resource!.blob!.length).toBeLessThanOrEqual(16_384)
  }, 60_000)
})
