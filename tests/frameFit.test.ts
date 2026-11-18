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
vi.mock('../server/screenshot.ts', async (importOriginal) =>
  (await import('./measureGate.ts')).gatedScreenshot(await importOriginal()),
)

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { findBrowserPath, loadFramePage } = await import('../server/screenshot.ts')
const { FIT_HEIGHT_MAX, settleHeight } = await import('../server/frameFit.ts')
const { holdNextMeasure } = await import('./measureGate.ts')

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
  /** a measure of content that `content` gives for a viewport, all of it in flow */
  const curve = (content: (viewport: number) => number) =>
    vi.fn(async (viewport: number) => ({ painted: content(viewport), flow: content(viewport), shell: false }))
  /** content of `fixed` px plus `share` of the viewport, as a vh-sized part makes it */
  const design = (fixed: number, share = 0) => curve((viewport) => fixed + share * viewport)

  it('takes a measure that holds at the height it gives', async () => {
    const measure = design(640)
    expect(await settleHeight(300, measure)).toEqual({ kind: 'fits', height: 640 })
    /* the measure, the one that confirms it, and the slope below */
    expect(measure).toHaveBeenCalledTimes(3)
    expect(await settleHeight(640, design(640))).toEqual({ kind: 'fits', height: 640 })
  })

  it('solves a design that grows with part of its viewport', async () => {
    /* a 50vh hero over 300px: 300 + h/2 = h at 600 */
    expect(await settleHeight(800, design(300, 0.5))).toEqual({ kind: 'fits', height: 600 })
  })

  it('fits the same design from every start, through the rounding a browser does', async () => {
    /* ceil, as contentBottom rounds: the fit may sit a px or two above the exact 600, never below it */
    const half = curve((h) => Math.ceil(0.5 * h + 300))
    for (let start = 100; start <= 3000; start += 1) {
      const settled = await settleHeight(start, half)
      expect(settled.kind === 'fits' && settled.height >= 600 && settled.height <= 602, `from ${start}`).toBe(true)
    }
  })

  it('shrinks a frame to a min-height:100vh wrapper’s content, from either side', async () => {
    const floor = curve((viewport) => Math.max(800, viewport))
    expect(await settleHeight(2000, floor)).toEqual({ kind: 'fits', height: 800 })
    expect(await settleHeight(400, floor)).toEqual({ kind: 'fits', height: 800 })
  })

  it('keeps the height of a design sized by its viewport alone', async () => {
    expect(await settleHeight(900, design(0, 1))).toEqual({ kind: 'fits', height: 900 })
    /* an app shell at 100vh: at a 1px viewport only its overflow is left, which is no floor */
    const collapsing = vi.fn(async (viewport: number) => ({
      painted: Math.max(122, viewport),
      flow: viewport,
      shell: false,
    }))
    expect(await settleHeight(900, collapsing)).toEqual({ kind: 'fits', height: 900 })
    /* one whose content scrolls inside it, as loaded */
    const scrolling = vi.fn(async () => ({ painted: 2120, flow: 2120, shell: true }))
    expect(await settleHeight(844, scrolling)).toEqual({ kind: 'fits', height: 844 })
  })

  it('settles vh inside clamp(), max() and min-height, whose growth stops partway', async () => {
    /* a clamp(480px, 60vh, 720px) hero over 1200px */
    const hero = curve((h) => Math.min(Math.max(480, 0.6 * h), 720) + 1200)
    expect(await settleHeight(800, hero)).toEqual({ kind: 'fits', height: 1920 })
    /* a min-height:50vh main holding 300px */
    expect(
      await settleHeight(
        800,
        curve((h) => Math.max(300, 0.5 * h)),
      ),
    ).toEqual({ kind: 'fits', height: 300 })
    /* a min-height:50vh section holding 600px, over a 200px footer, from a frame far too tall */
    expect(
      await settleHeight(
        2000,
        curve((h) => Math.max(600, 0.5 * h) + 200),
      ),
    ).toEqual({ kind: 'fits', height: 800 })
  })

  it('refuses a design that only holds where it grows steeply with its frame', async () => {
    /* an 80vh hero over 1000px holds at 5000px, the hero 4000px tall */
    expect(await settleHeight(800, design(1000, 0.8))).toEqual({ kind: 'outgrows' })
  })

  it('refuses a design that outgrows any viewport', async () => {
    /* a 100vh hero over 300px: always 300px past the frame */
    expect(await settleHeight(800, design(300, 1))).toEqual({ kind: 'outgrows' })
    /* and with so much below that the frame reaches the export limit first */
    expect(await settleHeight(800, design(3000, 1))).toEqual({ kind: 'outgrows' })
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
    /* a bare fragment is laid out in standards mode, as the editor's frame document is */
    const fragment = frameWith(block(350), { height: 900 })
    await fit(fragment)
    expect(fragment.height).toBe(366)
    const table = '<table style="font-size:40px"><tr><td>Row</td></tr><tr><td>Row</td></tr></table>'
    const bare = frameWith(table)
    const typed = frameWith(`<!doctype html>${table}`)
    await fit(bare)
    await fit(typed)
    expect(bare.height).toBe(typed.height)
    /* a min-height in px is the design's own: its centred content stays where it is drawn */
    const centred = frameWith(
      doc(block(100, 'width:100px'), 'margin:0;min-height:600px;display:flex;align-items:center'),
    )
    await fit(centred)
    expect(centred.height).toBe(600)
    /* a fixed-size panel scrolling inside a shorter page is no app shell: the page shrinks to it */
    const panel = frameWith(doc(`<div style="height:300px;overflow:auto">${block(1000)}</div>`), { height: 500 })
    await fit(panel)
    expect(panel.height).toBe(300)
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

    const clipped = frameWith(
      doc(
        `<div style="height:100px;overflow-x:clip;position:relative">${block(700, 'position:absolute;width:10px')}</div>`,
      ),
    )
    await fit(clipped)
    /* overflow-x:clip leaves overflow-y visible */
    expect(clipped.height).toBe(700)

    const decorated = frameWith(
      doc(
        '<style>.card{position:relative;height:100px}.card::after{content:"";position:absolute;left:0;top:100%;width:10px;height:200px}.cut{position:relative;height:100px;overflow:hidden}.cut::after{content:"";position:absolute;top:0;width:10px;height:900px}</style><div class="card"></div><div class="cut"></div>',
      ),
    )
    await fit(decorated)
    /* the card's ::after runs 200px past its box; the clipper's is cut at its edge */
    expect(decorated.height).toBe(300)

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

    const shell = frameWith(
      doc(
        `<div style="height:100vh;display:flex"><aside style="width:200px"></aside><main style="flex:1;padding:24px"><h1>Inbox</h1><p>Three new messages</p></main></div>`,
      ),
      { width: 1440, height: 900 },
    )
    await fit(shell)
    expect(shell.height).toBe(900)

    /* a mobile screen whose shell is the body itself, or html and body at 100% */
    const screen = (bodyStyle: string, shellStyle = '') =>
      doc(
        `<div style="${shellStyle}display:flex;flex-direction:column;height:100%"><header style="height:56px"></header><main style="flex:1;overflow:auto">${block(2000)}</main><nav style="height:64px"></nav></div>`,
        bodyStyle,
      )
    const bodyShell = frameWith(screen('margin:0;height:100vh'), { width: 390, height: 844 })
    await fit(bodyShell)
    expect(bodyShell.height).toBe(844)
    const fullShell = frameWith(screen('margin:0;height:100%').replace('<html>', '<html style="height:100%">'), {
      width: 390,
      height: 844,
    })
    await fit(fullShell)
    expect(fullShell.height).toBe(844)

    const scroller = frameWith(doc(`<div style="height:100vh;overflow:auto">${block(3000)}</div>`), { height: 700 })
    await fit(scroller)
    expect(scroller.height).toBe(700)

    const clamped = frameWith(doc(block(0, 'height:clamp(480px,60vh,720px)') + block(1200)), { height: 800 })
    await fit(clamped)
    expect(clamped.height).toBe(1920)

    const hero = frameWith(doc(block(0, 'height:100vh') + block(300)), { height: 800 })
    const result = await fit(hero)
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('grows with its frame')
    expect(hero.height).toBe(800)
  }, 60_000)

  it('reads a layout its own script builds from the viewport, after the script has run', async () => {
    /* a screen sized from innerHeight on load and on resize, above 300px: it outgrows any frame */
    const script = `<script>const size = () => { document.getElementById('h').style.height = innerHeight + 'px' }; size(); addEventListener('resize', size)</script>`
    const frame = frameWith(doc(`<div id="h"></div>${block(300)}${script}`), { height: 800 })
    const result = await fit(frame)
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('grows with its frame')
  }, 60_000)

  it('measures at the new width when the same call changes it', async () => {
    const frame = frameWith(doc('<div style="width:100%;aspect-ratio:2/1"></div>'))
    await fit(frame, { width: 800 })
    expect(frame).toMatchObject({ width: 800, height: 400 })
  }, 60_000)

  it('refuses a fit when the design changed while it was measured', async () => {
    const frame = frameWith(doc(block(500)))
    const measuring = holdNextMeasure()
    const pending = fit(frame)
    await measuring.reached
    actions.updateFrame(frame.id, { html: doc(block(900)) }, agent())
    measuring.release()
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
    /* a sign-off mid-playback does not jump it ahead either */
    const before = sent.length
    actions.setFrameApproval(sent[resized]!.frame!.id, true, { id: OWNER, name: 'Fit Owner' })
    const approved = sent.slice(before).find((message) => message.type === 'frame:updated')
    expect(approved?.frame?.html.length).toBeLessThan(stored.length)
    /* nor does a restack */
    const restacking = sent.length
    actions.restackFrames(canvasId, [{ id: sent[resized]!.frame!.id, z: 99 }], agent())
    const restacked = sent.slice(restacking).find((message) => message.type === 'frame:updated')
    expect(restacked?.frame?.html.length).toBeLessThan(stored.length)
  }, 60_000)

  it('sends a frame mid-stream healed when only its details change', async () => {
    const frame = frameWith('')
    actions.appendFrameHtml(frame.id, doc(block(100)).replace('</body>', '<script>let half ='), agent(), {
      start: true,
    })
    const renaming = sent.length
    actions.updateFrame(frame.id, { name: 'Renamed' }, agent())
    const renamed = sent.slice(renaming).find((message) => message.type === 'frame:updated')
    expect(renamed?.frame?.name).toBe('Renamed')
    expect(renamed?.frame?.html).not.toContain('<script')
  }, 60_000)
})

describe.skipIf(!findBrowserPath())('server renders', () => {
  it('lay every design out in standards mode with the asset base inside the document', async () => {
    const shapes = {
      head: '<!doctype html><html><head><title>t</title></head><body>x</body></html>',
      header: '<!doctype html><html><body><header>x</header></body></html>',
      html: '<!doctype html><html><body>x</body></html>',
      fragment: '<p>x</p>',
    }
    for (const [shape, html] of Object.entries(shapes)) {
      const loaded = await loadFramePage({ ...frameWith(html), html })
      try {
        const seen = await loaded.page.evaluate(() => ({
          mode: document.compatMode,
          base: document.head.querySelector('base') !== null && !document.querySelector('header base'),
        }))
        expect(seen, shape).toEqual({ mode: 'CSS1Compat', base: true })
      } finally {
        await loaded.close()
      }
    }
  }, 60_000)
})
