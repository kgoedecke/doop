import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { findBrowserPath, inspectFrame } from '../server/screenshot.ts'
import type { Frame } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveComponent: () => {},
}))

/** inspect_frame: the rendered frame as data, with the layout faults a reviewer would flag. */

const frame = (body: string, size = { width: 400, height: 300 }): Frame => ({
  id: 'inspected',
  canvasId: 'inspect-canvas',
  name: 'Screen',
  html: `<!doctype html><html><body style="margin:0;font:16px sans-serif">${body}</body></html>`,
  x: 0,
  y: 0,
  ...size,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
})

const FAULTY = frame(`
  <p class="wide" style="position:absolute;left:300px;top:10px;width:200px;margin:0">Runs off the side</p>
  <div class="pill" style="position:absolute;left:10px;top:60px;width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A label far too long for its pill</div>
  <h2 class="title" style="position:absolute;left:10px;top:120px;margin:0;font-size:24px">Arrivals</h2>
  <span class="badge" style="position:absolute;left:30px;top:125px">12:40</span>
`)

const CLEAN = frame(`
  <div class="card" style="position:absolute;left:20px;top:20px;width:200px;height:160px;border-radius:16px;overflow:hidden">
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="display:block;width:300px;height:220px;background:#ccc">
  </div>
  <p class="caption" style="position:absolute;left:20px;top:200px;margin:0">One clean line</p>
`)

describe.skipIf(!findBrowserPath())('inspectFrame', () => {
  it('reports text past the edge, cut off by its box, and overlapping', async () => {
    const { problems, problemCount } = await inspectFrame(FAULTY)
    const byType = (type: string) => problems.filter((p) => p.type === type)
    expect(byType('off-frame')).toEqual([
      expect.objectContaining({ text: 'Runs off the side', detail: expect.stringContaining('past the right edge') }),
    ])
    expect(byType('clipped')).toEqual([
      expect.objectContaining({ selector: expect.stringContaining('div'), detail: 'text cut off with an ellipsis' }),
    ])
    expect(byType('overlap')).toEqual([
      expect.objectContaining({ text: 'Arrivals', detail: expect.stringContaining('"12:40"') }),
    ])
    expect(problemCount).toBe(3)
  }, 30_000)

  it('leaves a clean frame alone, an image a rounded card crops included', async () => {
    expect((await inspectFrame(CLEAN)).problems).toEqual([])
  }, 30_000)

  it('reports on the asked-for selectors in place of the outline', async () => {
    const result = await inspectFrame(FAULTY, { selectors: ['.badge', '.missing', 'p[', 'h2, .pill'] })
    expect(result.elements.map((e) => [e.matched, e.text])).toEqual([
      ['.badge', '12:40'],
      ['h2, .pill', 'A label far too long for its pill'],
      ['h2, .pill', 'Arrivals'],
    ])
    expect(result.unmatched).toEqual([
      { selector: '.missing', reason: 'no visible match' },
      { selector: 'p[', reason: 'invalid selector' },
    ])
  }, 30_000)

  it('reports text its own fixed height cuts off', async () => {
    const clamped = frame(
      '<p class="clamp" style="position:absolute;left:10px;top:10px;width:120px;height:20px;margin:0;line-height:20px;overflow:hidden">Three lines of wrapped text that its twenty pixel box cuts down to one</p>',
    )
    expect((await inspectFrame(clamped)).problems).toEqual([
      expect.objectContaining({ type: 'clipped', detail: 'text cut off by the box (overflow)' }),
    ])
  }, 30_000)

  it('returns every match of every asked-for selector, past the outline’s 64', async () => {
    const rows = ['a', 'b', 'c', 'd']
      .map((group) =>
        Array.from(
          { length: 20 },
          (_, i) => `<span class="${group}" style="display:inline-block;width:4px;height:4px">${i}</span>`,
        ).join(''),
      )
      .join('')
    const result = await inspectFrame(frame(rows), { selectors: ['.a', '.b', '.c', '.d'] })
    expect(result.elements).toHaveLength(80)
    expect(result.unmatched ?? []).toEqual([])
  }, 30_000)

  it('is an MCP tool', async () => {
    const { store } = await import('../server/store.ts')
    const actions = await import('../server/actions.ts')
    const { buildMcpServer } = await import('../server/mcp.ts')
    const canvas = store.createCanvas('inspect', 'owner')
    const owner = actions.resolveActor({ name: 'Owner', kind: 'user' })
    const made = actions.createFrame(canvas.id, { name: 'Screen', html: FAULTY.html, width: 400, height: 300 }, owner)!
    const client = new Client({ name: 'inspect-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await buildMcpServer('Owner', 'owner').connect(b)
    await client.connect(a)
    const result = (await client.callTool({
      name: 'inspect_frame',
      arguments: { frame_id: made.id, selectors: ['.badge'] },
    })) as { isError?: boolean; content: { text: string }[] }
    await client.close()
    expect(result.isError).toBeFalsy()
    const body = JSON.parse(result.content[0]!.text) as { problemCount: number; elements: { text: string }[] }
    expect(body.problemCount).toBe(3)
    expect(body.elements.map((e) => e.text)).toEqual(['12:40'])
  }, 30_000)
})
