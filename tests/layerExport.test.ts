import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { layerExport, layerRefFromQuery, LayerNotFoundError } from '../server/layerExport.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { findBrowserPath, renderFrame } from '../server/screenshot.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

/** export_layer and the `/i/` layer crop behind it. */

const OWNER_ID = 'layer-owner'

const FRAME: Frame = {
  id: 'layerframe',
  canvasId: 'layer-canvas',
  name: 'Landing',
  html: `<!doctype html><html><body style="margin:0;background:#fff">
    <div data-doop-id="card01" style="position:absolute;left:40px;top:30px;width:120px;height:80px;background:#e11"></div>
    <p class="note" style="position:absolute;left:10px;top:200px;margin:0;width:50px;height:20px;background:#11e"></p>
    <div class="spill" style="position:absolute;left:350px;top:250px;width:200px;height:200px;background:#1e1"></div>
    <span class="empty"></span>
    <div class="hairline" style="position:absolute;left:10.5px;top:60px;width:0;height:40px"></div>
  </body></html>`,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}

const CANVAS: Canvas = {
  id: 'layer-canvas',
  name: 'Site',
  ownerId: OWNER_ID,
  createdAt: 0,
  updatedAt: 0,
  frames: [FRAME],
}

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function exportLayer(ownerId: string, args: Record<string, unknown>): Promise<CallResult> {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'doop-layer-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return (await client.callTool({ name: 'export_layer', arguments: args })) as unknown as CallResult
  } finally {
    await client.close()
    await server.close()
  }
}

/** A PNG's pixel size, from its IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) => CANVAS.frames.find((f) => f.id === id))
})

describe('layerRefFromQuery', () => {
  it('reads an element id or a selector, and nothing when neither is asked for', () => {
    expect(layerRefFromQuery({ scale: '2' })).toBeUndefined()
    expect(layerRefFromQuery({ element: 'card01' })).toEqual({ elementId: 'card01' })
    expect(layerRefFromQuery({ selector: ' .note ' })).toEqual({ selector: '.note' })
  })

  it('refuses a malformed id, an empty selector and an overlong one', () => {
    expect(layerRefFromQuery({ element: 'Card-1' })).toBeNull()
    expect(layerRefFromQuery({ selector: '  ' })).toBeNull()
    expect(layerRefFromQuery({ selector: 'a'.repeat(501) })).toBeNull()
    expect(layerRefFromQuery({ selector: ['a', 'b'] })).toBeNull()
  })
})

describe('layerExport', () => {
  it('builds a 2x PNG URL naming the element by default', () => {
    const out = layerExport(FRAME, { elementId: 'card01' })
    expect(out.ok && out.image_url).toMatch(/\/i\/layerframe\.png\?scale=2&element=card01$/)
    expect(out.ok && out.download_url).toMatch(/&download$/)
  })

  it('encodes a selector and carries jpg quality and scale', () => {
    const out = layerExport(FRAME, { selector: '#a > .b' }, { format: 'jpg', scale: 3, quality: 70 })
    expect(out.ok && out.image_url).toMatch(/\/i\/layerframe\.jpg\?scale=3&selector=%23a%20%3E%20\.b&quality=70$/)
  })

  it('refuses an id the frame does not carry', () => {
    const out = layerExport(FRAME, { elementId: 'zzzzzz' })
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('zzzzzz') })
  })
})

describe('export_layer', () => {
  it('stays behind the canvas gate', async () => {
    const result = await exportLayer('someone-else', { frame_id: FRAME.id, element_id: 'card01' })
    expect(result.isError).toBe(true)
  })

  it('wants exactly one of element_id and selector', async () => {
    expect((await exportLayer(OWNER_ID, { frame_id: FRAME.id })).isError).toBe(true)
    expect((await exportLayer(OWNER_ID, { frame_id: FRAME.id, element_id: 'card01', selector: '.note' })).isError).toBe(
      true,
    )
  })

  it('returns the layer URLs', async () => {
    const result = await exportLayer(OWNER_ID, { frame_id: FRAME.id, selector: '.note', scale: 1 })
    expect(result.isError).toBeFalsy()
    const out = JSON.parse(result.content[0]!.text!) as { image_url: string; scale: number }
    expect(out.image_url).toMatch(/\/i\/layerframe\.png\?scale=1&selector=\.note$/)
    expect(out.scale).toBe(1)
  })
})

describe.skipIf(!findBrowserPath())('the layer crop', () => {
  it('cuts the render to the element box at the scale asked for', async () => {
    expect(pngSize(await renderFrame(FRAME, 2, { layer: '[data-doop-id="card01"]' }))).toEqual({
      width: 240,
      height: 160,
    })
    expect(pngSize(await renderFrame(FRAME, 1, { layer: '.note' }))).toEqual({ width: 50, height: 20 })
  }, 60_000)

  it('keeps only what the frame shows of a layer spilling past its edge', async () => {
    expect(pngSize(await renderFrame(FRAME, 1, { layer: '.spill' }))).toEqual({ width: 50, height: 50 })
  }, 60_000)

  it('crops a layer low on a frame too tall to render whole at that scale', async () => {
    /* at 2x, 5000px wide, the whole-frame budget stops at 1250 CSS px */
    const tall: Frame = {
      ...FRAME,
      width: 5000,
      height: 3000,
      html: `<!doctype html><html><body style="margin:0">
        <div class="low" style="position:absolute;left:100px;top:2700px;width:60px;height:40px;background:#e11"></div>
      </body></html>`,
    }
    expect(pngSize(await renderFrame(tall, 2, { layer: '.low' }))).toEqual({ width: 120, height: 80 })
  }, 60_000)

  it('rejects a selector that matches nothing, an invalid one and an empty box', async () => {
    for (const layer of ['.missing', 'div[', '.empty', '.hairline']) {
      await expect(renderFrame(FRAME, 1, { layer })).rejects.toBeInstanceOf(LayerNotFoundError)
    }
  }, 60_000)
})
