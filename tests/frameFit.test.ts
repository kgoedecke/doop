import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

/* fit_height (#532): a frame's height set to its content's, measured in the
   server's Chromium. Writes persist like any canvas change; only the frame
   left behind and what viewers are sent matter here, so persistence is stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveFrameVersion: async () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { findBrowserPath } = await import('../server/screenshot.ts')
const { FIT_HEIGHT_MAX, settleHeight } = await import('../server/frameFit.ts')

const OWNER = 'fit-owner'
const doc = (body: string, bodyStyle = 'margin:0') =>
  `<!doctype html><html><head></head><body style="${bodyStyle}">${body}</body></html>`
const block = (height: number, style = '') => `<div style="height:${height}px;${style}"></div>`

interface Sent {
  type: string
  frame?: Frame
}

let canvasId: string
let sent: Sent[]
let client: Client
let closeClient: () => Promise<void>

beforeEach(async () => {
  sent = []
  actions.wire(
    (_canvas, message) => void sent.push(message as Sent),
    () => {},
  )
  canvasId = store.createCanvas('fit', OWNER).id
  const server = buildMcpServer('Fit Owner', OWNER)
  client = new Client({ name: 'fit-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  closeClient = async () => {
    await client.close()
    await server.close()
  }
})

afterEach(async () => {
  await closeClient()
})

const agent = () => actions.resolveActor({ name: 'Fitter', kind: 'agent' })

function frameWith(html: string, size: { width?: number; height?: number } = {}) {
  return actions.createFrame(canvasId, { name: 'Fit', html, width: 400, height: 300, ...size }, agent())!
}

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
  return (await client.callTool({ name, arguments: { agent_name: 'Fitter', ...args } })) as unknown as CallResult
}

const texts = (result: CallResult) => result.content.map((part) => part.text ?? '').join('\n')
const fit = (frame: Frame, args: Record<string, unknown> = {}) =>
  callTool('update_frame', { frame_id: frame.id, fit_height: true, ...args })

describe('settleHeight', () => {
  /** content of `fixed` px plus `share` of the viewport, as a vh-sized part makes it */
  const design = (fixed: number, share = 0) => vi.fn(async (viewport: number) => fixed + share * viewport)

  it('takes a measure that holds at the height it gives', async () => {
    const measure = design(640)
    expect(await settleHeight(300, measure)).toEqual({ kind: 'fits', height: 640 })
    expect(measure).toHaveBeenCalledTimes(2)
    expect(await settleHeight(640, design(640))).toEqual({ kind: 'fits', height: 640 })
  })

  it('solves a design that grows with part of its viewport', async () => {
    /* a 50vh hero over 300px: 300 + h/2 = h at 600 */
    expect(await settleHeight(800, design(300, 0.5))).toEqual({ kind: 'fits', height: 600 })
  })

  it('shrinks a frame to a min-height:100vh wrapper’s content, from either side', async () => {
    const floor = vi.fn(async (viewport: number) => Math.max(800, viewport))
    expect(await settleHeight(2000, floor)).toEqual({ kind: 'fits', height: 800 })
    expect(await settleHeight(400, floor)).toEqual({ kind: 'fits', height: 800 })
  })

  it('keeps the height of a design sized by its viewport alone', async () => {
    expect(await settleHeight(900, design(0, 1))).toEqual({ kind: 'fits', height: 900 })
  })

  it('refuses a design that outgrows any viewport', async () => {
    /* a 100vh hero over 300px: always 300px past the frame */
    expect(await settleHeight(800, design(300, 1))).toEqual({ kind: 'outgrows' })
  })

  it('stops at the export limit', async () => {
    expect(await settleHeight(300, design(FIT_HEIGHT_MAX + 1000))).toEqual({ kind: 'fits', height: FIT_HEIGHT_MAX })
  })
})

describe('fit_height refusals', () => {
  it('refuses height and fit_height together on update_frame', async () => {
    const frame = frameWith(doc(block(500)))
    const result = await fit(frame, { height: 200 })
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('either height or fit_height')
    expect(frame.height).toBe(300)
  })

  it('refuses a create with no design to measure, before making the frame', async () => {
    const before = store.getCanvas(canvasId)!.frames.length
    const result = await callTool('create_frame', { canvas_id: canvasId, name: 'Empty', html: '', fit_height: true })
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('update_frame with fit_height')
    expect(store.getCanvas(canvasId)!.frames.length).toBe(before)
  })

  it('refuses a frame an agent is still streaming into', async () => {
    const frame = frameWith('')
    actions.appendFrameHtml(frame.id, doc(block(500)), agent(), { start: true })
    const result = await fit(frame)
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('still streaming')
  })
})

describe.skipIf(!findBrowserPath())('fit_height in a browser', () => {
  it('grows a frame whose content is cut off', async () => {
    const frame = frameWith(doc(block(700) + block(584)))
    const result = await fit(frame)
    expect(result.isError).toBeFalsy()
    expect(frame.height).toBe(1284)
    expect(texts(result)).toContain('now 1284px tall')
  }, 60_000)

  it('shrinks a frame whose body holds it at the viewport height', async () => {
    const frame = frameWith(doc(block(240), 'margin:0;min-height:100vh'), { height: 900 })
    await fit(frame)
    expect(frame.height).toBe(240)
    const full = frameWith(doc(block(180), 'margin:0;height:100%'), { height: 900 })
    await fit(full)
    expect(full.height).toBe(180)
    /* a bare fragment renders in quirks mode, where an auto-height body fills the viewport */
    const fragment = frameWith(block(350), { height: 900 })
    await fit(fragment)
    expect(fragment.height).toBe(366)
  }, 60_000)

  it('counts body margins, positioned layers and overflowing text, not fixed bars, hidden menus or clipped content', async () => {
    const frame = frameWith(
      doc(
        block(100) +
          '<div style="position:absolute;top:400px;width:10px;height:50px"></div>' +
          '<div style="position:fixed;bottom:0;height:40px;width:100%"></div>' +
          '<nav style="position:absolute;top:0;height:2000px;width:10px;visibility:hidden"></nav>' +
          '<nav style="position:absolute;top:0;height:2000px;width:10px;opacity:0"></nav>' +
          '<div style="position:relative;height:0"><ul style="position:absolute;top:0;height:900px;margin:0;visibility:hidden">menu</ul></div>' +
          `<div style="height:60px;overflow:hidden">${block(2000)}</div>`,
        'margin:20px',
      ),
    )
    await fit(frame)
    /* the absolute layer ends at 400 + 50 from the root, past the 20+100+60+20 of flow */
    expect(frame.height).toBe(450)

    const words = 'Doop measures every line of text that spills past its box. '.repeat(40)
    const spill = frameWith(doc(`<p style="height:40px;margin:0;font:16px/20px sans-serif">${words}</p>`))
    await fit(spill)
    expect(spill.height).toBeGreaterThan(200)
  }, 60_000)

  it('settles a design sized in vh, and refuses one that always outgrows its frame', async () => {
    const half = frameWith(doc(block(0, 'height:50vh') + block(300)), { height: 800 })
    await fit(half)
    expect(half.height).toBe(600)
    expect((await fit(half)).isError).toBeFalsy()
    expect(half.height).toBe(600)

    const wrapped = frameWith(doc(`<main style="min-height:100vh">${block(500)}</main>`), { height: 2000 })
    await fit(wrapped)
    expect(wrapped.height).toBe(500)

    const hero = frameWith(doc(block(0, 'height:100vh') + block(300)), { height: 800 })
    const result = await fit(hero)
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('grows with its frame')
    expect(hero.height).toBe(800)
  }, 60_000)

  it('measures at the new width when the same call changes it', async () => {
    const frame = frameWith(doc('<div style="width:100%;aspect-ratio:2/1"></div>'))
    await fit(frame, { width: 800 })
    expect(frame).toMatchObject({ width: 800, height: 400 })
  }, 60_000)

  it('refuses a fit when the design changed while it was measured', async () => {
    const frame = frameWith(doc(block(500)))
    const pending = fit(frame)
    /* the page takes longer than this to load */
    await new Promise((resolve) => setTimeout(resolve, 30))
    actions.updateFrame(frame.id, { html: doc(block(900)) }, agent())
    const result = await pending
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('changed while it was measured')
    expect(frame.height).toBe(300)
  }, 60_000)

  it('withdraws sign-off like any resize', async () => {
    const frame = frameWith(doc(block(500)))
    actions.setFrameApproval(frame.id, true, { id: OWNER, name: 'Fit Owner' })
    await fit(frame)
    expect(store.getFrame(frame.id)!.approval?.status).toBe('needs_review')
  }, 60_000)

  it('fits after create_frame and set_frame_html, with the fit note right after the data', async () => {
    const created = await callTool('create_frame', {
      canvas_id: canvasId,
      name: 'Created',
      html: doc(block(333)),
      fit_height: true,
    })
    expect(created.isError).toBeFalsy()
    const { frame } = JSON.parse(created.content[0]!.text!) as { frame: { id: string; height: number } }
    expect(frame.height).toBe(333)
    expect(created.content[1]!.text).toContain('now 333px tall')

    const set = await callTool('set_frame_html', { frame_id: frame.id, html: doc(block(512)), fit_height: true })
    expect(set.isError).toBeFalsy()
    expect(store.getFrame(frame.id)!.height).toBe(512)
    expect(set.content[1]!.text).toContain('now 512px tall')
  }, 60_000)

  it('sends the write before measuring, and never jumps a playback ahead', async () => {
    const html = doc(block(333) + `<p>${'A design long enough to play back over a few ticks. '.repeat(200)}</p>`)
    const result = await callTool('create_frame', { canvas_id: canvasId, name: 'Played', html, fit_height: true })
    expect(result.isError).toBeFalsy()
    const { frame } = JSON.parse(result.content[0]!.text!) as { frame: { height: number } }
    const created = sent.findIndex((message) => message.type === 'frame:created')
    const resized = sent.findIndex(
      (message) => message.type === 'frame:updated' && message.frame?.height === frame.height,
    )
    expect(created).toBeGreaterThanOrEqual(0)
    expect(resized).toBeGreaterThan(created)
    /* the playback is still running: the resize carries what viewers have been shown, not the whole design */
    const stored = store.getFrame(sent[resized]!.frame!.id)!.html
    expect(sent[resized]!.frame!.html.length).toBeLessThan(stored.length)
  }, 60_000)
})
