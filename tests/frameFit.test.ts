import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

/* fit_to_content (#532): a frame sized to its content, measured in the
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
  callTool('update_frame', { frame_id: frame.id, fit_to_content: 'height', ...args })

describe('settleHeight', () => {
  /** a measure of content that `content` gives for a viewport, all of it in flow */
  const curve = (content: (viewport: number) => number) =>
    vi.fn(async (viewport: number) => ({
      painted: content(viewport),
      flow: content(viewport),
      shell: false,
      spills: 0,
    }))
  /** content of `fixed` px plus `share` of the viewport, as a vh-sized part makes it */
  const design = (fixed: number, share = 0) => curve((viewport) => fixed + share * viewport)

  it('takes a measure that holds at the height it gives', async () => {
    const measure = design(640)
    expect(await settleHeight(300, measure)).toEqual({ kind: 'fits', height: 640 })
    /* the measure, the one that confirms it, and the slope below */
    expect(measure).toHaveBeenCalledTimes(3)
    expect(await settleHeight(640, design(640))).toEqual({ kind: 'fits', height: 640 })
  })

  it('takes the px below a measure that rounds up, where the content fits exactly', async () => {
    /* 300 + h/2 measures 600.5 at 601, rounded to 601; at 600 it is exactly 600 */
    const measure = curve((viewport) => Math.round(300 + viewport / 2))
    expect(await settleHeight(601, measure)).toEqual({ kind: 'fits', height: 600 })
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
      spills: 0,
    }))
    expect(await settleHeight(900, collapsing)).toEqual({ kind: 'fits', height: 900 })
    /* one whose content scrolls inside it, as loaded */
    const scrolling = vi.fn(async () => ({ painted: 2120, flow: 2120, shell: true, spills: 0 }))
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

describe('fit_to_content refusals', () => {
  it('refuses height and a height fit together on update_frame', async () => {
    const frame = frameWith(doc(block(500)))
    const result = await fit(frame, { height: 200 })
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('either height or fit_to_content')
    expect(frame.height).toBe(300)
  })

  it('refuses a create with no design to measure, before making the frame', async () => {
    const before = store.getCanvas(canvasId)!.frames.length
    const result = await callTool('create_frame', {
      canvas_id: canvasId,
      name: 'Empty',
      html: '',
      fit_to_content: 'height',
    })
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('update_frame with fit_to_content')
    expect(store.getCanvas(canvasId)!.frames.length).toBe(before)
  })

  it('refuses width with a width fit, and keeps a given height with one', async () => {
    const frame = frameWith(doc(block(500)))
    for (const axes of ['width', 'both']) {
      const result = await fit(frame, { fit_to_content: axes, width: 200 })
      expect(result.isError).toBe(true)
      expect(texts(result)).toContain(`either width or fit_to_content "${axes}"`)
    }
    const both = await fit(frame, { fit_to_content: 'both', height: 200 })
    expect(texts(both)).toContain('either height or fit_to_content "both"')
    expect(frame).toMatchObject({ width: 400, height: 300 })
    const invalid = await fit(frame, { fit_to_content: 'yes' })
    expect(invalid.isError).toBe(true)
  })

  it('refuses a frame an agent is still streaming into', async () => {
    const frame = frameWith('')
    actions.appendFrameHtml(frame.id, doc(block(500)), agent(), { start: true })
    const result = await fit(frame)
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('still streaming')
  })
})

describe.skipIf(!findBrowserPath())('fit_to_content in a browser', () => {
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

  it('fits percentage children without releasing their containing block', async () => {
    for (const height of [200, 800]) {
      const frame = frameWith(doc(block(0, 'height:50%') + block(300), 'margin:0;height:100vh'), { height })
      expect((await fit(frame)).isError).toBeFalsy()
      expect(frame.height).toBe(600)
    }
  }, 60_000)

  it('uses native document overflow for generated and positioned content', async () => {
    const documents = [
      doc('<style>body::after{content:"";position:absolute;top:200px;width:40px;height:100px}</style>' + block(100)),
      doc(
        '<div style="position:relative"><div style="height:100px;overflow:hidden"><div style="position:absolute;top:200px;width:50px;height:100px"></div></div></div>',
      ),
    ]
    for (const html of documents) {
      const frame = frameWith(html, { height: 100 })
      expect((await fit(frame)).isError).toBeFalsy()
      expect(frame.height).toBe(300)
    }
  }, 60_000)

  it('counts body margins, positioned layers and overflowing text, excluding fixed bars and clipped content', async () => {
    const frame = frameWith(
      doc(
        block(100) +
          '<div style="position:absolute;top:400px;width:10px;height:50px"></div>' +
          '<div style="position:fixed;top:0;height:2000px;width:100%"></div>' +
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

  it('hugs the width as a Figma frame does, never wider than the frame', async () => {
    /* a component main drawn on a big frame hugs to it, its body's margins included */
    const badge = frameWith(doc(block(32, 'width:120px'), 'margin:16px'), { width: 480, height: 240 })
    const both = await fit(badge, { fit_to_content: 'both' })
    expect(both.isError).toBeFalsy()
    expect(badge).toMatchObject({ width: 152, height: 64 })
    expect(texts(both)).toContain('now 152x64px')

    /* width alone keeps the height, and a height passed with it is applied */
    const wide = frameWith(doc(block(40, 'width:250px')), { width: 400, height: 300 })
    expect(texts(await fit(wide, { fit_to_content: 'width', height: 180 }))).toContain('now 250px wide')
    expect(wide).toMatchObject({ width: 250, height: 180 })

    /* text that wraps at the frame's width already needs all of it: nothing narrows or grows */
    const prose = frameWith(doc(`<p style="margin:0">${'Copy that wraps at any width it is given. '.repeat(30)}</p>`))
    await fit(prose, { fit_to_content: 'width' })
    expect(prose.width).toBe(400)

    /* a positioned layer past its parent counts; one past a sideways clipper does not */
    const tagged = frameWith(
      doc(
        '<div style="position:relative;width:100px;height:40px"><span style="position:absolute;left:100px;width:50px;height:10px"></span></div>' +
          '<div style="position:relative;width:80px;height:40px;overflow-x:clip"><span style="position:absolute;left:0;width:300px;height:10px"></span></div>',
      ),
    )
    await fit(tagged, { fit_to_content: 'width' })
    expect(tagged.width).toBe(150)
  }, 60_000)

  it('accounts for invisible elements when they create real document overflow', async () => {
    const frame = frameWith(
      doc(block(100) + '<nav style="position:absolute;top:0;height:700px;width:10px;visibility:hidden"></nav>'),
    )
    expect((await fit(frame)).isError).toBeFalsy()
    expect(frame.height).toBe(700)
  }, 60_000)

  it('follows the last responsive width and verifies the requested axes', async () => {
    const html = doc(
      '<style>.b{width:100px;height:20px}@media(max-width:100px){.b{width:180px}}@media(min-width:170px) and (max-width:190px){.b{width:250px}}@media(min-width:240px) and (max-width:260px){.b{width:320px}}</style><div class="b"></div>',
    )
    for (const axes of ['width', 'both']) {
      const frame = frameWith(html)
      expect((await fit(frame, { fit_to_content: axes })).isError).toBeFalsy()
      expect(frame).toMatchObject({ width: 320, height: axes === 'both' ? 20 : 300 })
    }
    const wide = frameWith(doc('<div style="width:700px;height:100px"></div>'))
    expect((await fit(wide, { fit_to_content: 'width', name: 'resized' })).isError).toBe(true)
    expect(wide).toMatchObject({ width: 400, name: 'Fit' })
  }, 60_000)

  it('rejects candidates that overflow only on a fresh load at the final size', async () => {
    for (const [axes, script] of [
      ['height', 'box.style.height = (innerHeight === 200 ? 900 : 200) + "px"'],
      ['width', 'box.style.width = (innerWidth === 200 ? 350 : 200) + "px"'],
      ['both', 'box.style.width = (innerWidth === 200 && innerHeight === 100 ? 350 : 200) + "px"'],
    ]) {
      const frame = frameWith(doc('<div id="box" style="height:100px"></div><script>' + script + '</script>'))
      const result = await fit(frame, { fit_to_content: axes, name: 'resized' })
      expect(result.isError, axes).toBe(true)
      expect(texts(result)).toContain('overflows when loaded')
      expect(frame).toMatchObject({ width: 400, height: 300, name: 'Fit' })
    }
  }, 60_000)

  it('loads tall frames above the inspection viewport cap for a width fit', async () => {
    const frame = frameWith(
      doc('<div id="box"></div><script>box.style.width = innerHeight > 4000 ? "300px" : "100px"</script>'),
    )
    expect((await fit(frame, { fit_to_content: 'width', height: 5000 })).isError).toBeFalsy()
    expect(frame.width).toBe(300)
  }, 60_000)

  it('hugs to what a media query lays out at the narrower width', async () => {
    const frame = frameWith(
      doc(
        '<style>.box{width:200px;height:10px}@media (max-width:300px){.box{width:280px}}</style><div class="box"></div>',
      ),
    )
    await fit(frame, { fit_to_content: 'width' })
    expect(frame.width).toBe(280)
  }, 60_000)

  it('hugs the width at the height the same call sets', async () => {
    const frame = frameWith(
      doc(
        '<style>.box{width:120px;height:10px}@media (max-height:200px){.box{width:280px}}</style><div class="box"></div>',
      ),
    )
    await fit(frame, { fit_to_content: 'width', height: 180 })
    expect([frame.width, frame.height]).toEqual([280, 180])
  }, 60_000)

  it('refuses a width fit when the height changed while it was measured', async () => {
    const frame = frameWith(doc(block(100)))
    const measuring = holdNextMeasure()
    const pending = fit(frame, { fit_to_content: 'width' })
    await measuring.reached
    actions.updateFrame(frame.id, { height: 500 }, agent())
    measuring.release()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('changed while it was measured')
    expect([frame.width, frame.height]).toEqual([400, 500])
  }, 60_000)

  it('loads the page at the height the same call sets, for a script that reads it once', async () => {
    const frame = frameWith(
      doc(
        '<div id="b" style="height:10px"></div><script>document.getElementById("b").style.width = innerHeight <= 200 ? "280px" : "120px"</script>',
      ),
    )
    await fit(frame, { fit_to_content: 'width', height: 180 })
    expect([frame.width, frame.height]).toEqual([280, 180])
  }, 60_000)

  it('hugs the width again at the height "both" settles on', async () => {
    const frame = frameWith(
      doc(
        '<style>.box{width:120px;height:180px}@media (max-height:200px){.box{width:280px}}</style><div class="box"></div>',
      ),
    )
    await fit(frame, { fit_to_content: 'both' })
    expect([frame.width, frame.height]).toEqual([280, 180])
  }, 60_000)

  it('settles "both" again when the re-hugged width changes the height', async () => {
    /* hugged at 300 tall it is 120 wide and settles 180 tall; there it is 280 wide, and at 280
       wide it is 100 tall */
    const frame = frameWith(
      doc(
        '<style>.box{width:120px;height:180px}@media (max-height:200px){.box{width:280px}}@media (min-width:200px){.box{height:100px}}</style><div class="box"></div>',
      ),
    )
    await fit(frame, { fit_to_content: 'both' })
    expect([frame.width, frame.height]).toEqual([280, 100])
  }, 60_000)

  it('reads again which root heights follow the viewport when "both" changes the width', async () => {
    /* at 120 wide the body is 100vh and let go of; re-hugged at 180 tall the box is 280 wide, where
       a media query holds the body at 250px and centres the box in it */
    const frame = frameWith(
      doc(
        '<style>body{height:100vh}.box{width:120px;height:180px}@media (min-width:200px){body{height:250px}}@media (max-height:260px){.box{width:280px}}</style><div class="box"></div>',
        'margin:0;display:flex;flex-direction:column;justify-content:center',
      ),
    )
    await fit(frame, { fit_to_content: 'both' })
    expect([frame.width, frame.height]).toEqual([280, 250])
  }, 60_000)

  it('refuses "both" when the width and height keep moving each other', async () => {
    const frame = frameWith(doc('<div style="width:calc(100px + 50vh);height:calc(100px + 50vw)"></div>'), {
      width: 600,
      height: 300,
    })
    const result = await fit(frame, { fit_to_content: 'both' })
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('keep changing each other')
    expect([frame.width, frame.height]).toEqual([600, 300])
  }, 60_000)

  it('hugs a hug-height layout at the frame height, after a height measure released the body', async () => {
    const frame = frameWith(
      '<!doctype html><html style="height:100%"><body style="margin:0;height:100%"><div style="height:100%;display:flex;width:fit-content"><div style="height:100%;aspect-ratio:1/1"></div><div style="width:120px;height:200px"></div></div></body></html>',
      { width: 600, height: 300 },
    )
    await fit(frame, { fit_to_content: 'both' })
    expect([frame.width, frame.height]).toEqual([320, 200])
  }, 60_000)

  it('keeps a body height set in px', async () => {
    const frame = frameWith(
      doc(
        '<div style="width:100px;height:100px"></div>',
        'margin:0;height:600px;display:flex;align-items:center;justify-content:center',
      ),
    )
    await fit(frame)
    expect(frame.height).toBe(600)
  }, 60_000)

  it('shrinks a min-height:100vh page whose parts are in vh to where it holds', async () => {
    const frame = frameWith(
      doc('<main style="min-height:100vh"><div style="height:50vh"></div><div style="height:200px"></div></main>'),
      { height: 900 },
    )
    await fit(frame)
    expect(frame.height).toBe(400)
  }, 60_000)

  it('cuts a pseudo-element where its own element clips sideways, and hugs a right-to-left page', async () => {
    const clipped = frameWith(
      doc(
        '<style>.c{position:relative;width:80px;height:40px;overflow-x:clip}.c::after{content:"";position:absolute;left:0;top:0;width:300px;height:10px}</style><div class="c"></div>',
      ),
    )
    await fit(clipped, { fit_to_content: 'width' })
    expect(clipped.width).toBe(80)

    const rtl = frameWith(
      '<!doctype html><html dir="rtl"><body style="margin:0"><div style="width:150px;height:40px"></div></body></html>',
    )
    await fit(rtl, { fit_to_content: 'width' })
    expect(rtl.width).toBe(150)
  }, 60_000)

  it('keeps a card that a narrower media query sets to width:100%', async () => {
    const frame = frameWith(
      doc(
        '<style>.card{width:320px;box-sizing:border-box;padding:16px}@media (max-width:360px){.card{width:100%}}</style><div class="card">Title</div>',
      ),
      { width: 600 },
    )
    await fit(frame, { fit_to_content: 'width' })
    expect(frame.width).toBe(320)
  }, 60_000)

  it('hugs again while each wider layout sets off a wider one', async () => {
    const frame = frameWith(
      doc(
        '<style>.box{width:200px;height:20px}@media (max-width:250px){.box{width:280px}}@media (min-width:260px) and (max-width:320px){.box{width:360px}}</style><div class="box"></div>',
      ),
    )
    await fit(frame, { fit_to_content: 'width' })
    expect(frame.width).toBe(360)
  }, 60_000)

  it('keeps a viewport-tall screen whose padding or border outlasts a tiny viewport', async () => {
    const screen = (inner: string, style: string) =>
      frameWith(doc(`<div style="box-sizing:border-box;height:100vh;${style}">${inner}</div>`), {
        width: 800,
        height: 900,
      })
    const hero = screen(
      '<h1 style="margin:0;font-size:32px;line-height:40px">Welcome</h1>',
      'padding:48px;display:flex;align-items:center;justify-content:center',
    )
    const framed = screen('<h1>App</h1><p>Content</p>', 'border:1px solid #ccc;overflow:hidden')
    const tall = screen('<div style="height:55vh"></div>', 'padding:40px')
    for (const frame of [hero, framed, tall]) {
      const result = await fit(frame)
      expect(result.isError).toBeFalsy()
      expect(frame.height).toBe(900)
    }
  }, 60_000)

  it('takes a min-height breakpoint at its own height, not a px under it', async () => {
    const frame = frameWith(
      doc('<style>.p{height:520px}@media (min-height:600px){.p{height:600px}}</style><div class="p"></div>'),
      { height: 800 },
    )
    await fit(frame)
    expect(frame.height).toBe(600)
  }, 60_000)

  it('keeps a root height set by any rule in a fixed length, and lets go of one that follows the viewport', async () => {
    const fitted = async (html: string, height = 300) => {
      const frame = frameWith(html, { height })
      await fit(frame)
      return frame.height
    }
    const box = '<div style="width:100px;height:100px"></div>'
    const page = (css: string, html = '') =>
      `<!doctype html><html${html}><head><style>${css}</style></head><body style="margin:0">${box}</body></html>`
    expect(await fitted(page('@layer base{body{height:600px}}'))).toBe(600)
    expect(await fitted(page('body{height:calc(500px + 6.25rem)!important}body{height:100vh}'))).toBe(600)
    expect(await fitted(page('body{height:600px}@media (max-width:500px){body{height:100vh}}'), 900)).toBe(100)
    /* body at 100% of a root fixed in px is fixed too: its 50% child keeps its share */
    expect(
      await fitted(
        '<!doctype html><html style="height:600px"><body style="margin:0;height:100%"><div style="height:50%"></div><div style="height:500px"></div></body></html>',
      ),
    ).toBe(800)
  }, 60_000)

  it('hugs at the frame height before resize handlers run, after a height measure', async () => {
    const frame = frameWith(
      '<!doctype html><html style="height:100%"><body style="margin:0;height:100%"><div id="box" style="height:200px"></div><div style="position:absolute;top:0;left:0;width:10px;height:300px"></div><script>const sync = () => { document.getElementById("box").style.width = document.body.clientHeight + "px" }; sync(); addEventListener("resize", sync)</script></body></html>',
      { width: 600, height: 400 },
    )
    await fit(frame, { fit_to_content: 'both' })
    expect([frame.width, frame.height]).toEqual([300, 300])
  }, 60_000)

  it('counts what shows past a box that clips one axis only', async () => {
    const frame = frameWith(
      doc(
        '<style>.c{position:relative;width:80px;height:40px;overflow-y:clip;overflow-x:visible}.c::after{content:"";position:absolute;left:0;top:0;width:300px;height:20px}</style><div class="c"></div>',
      ),
    )
    await fit(frame, { fit_to_content: 'width' })
    expect(frame.width).toBe(300)
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
      fit_to_content: 'height',
    })
    expect(created.isError).toBeFalsy()
    const { frame } = JSON.parse(created.content[0]!.text!) as { frame: { id: string; height: number } }
    expect(frame.height).toBe(333)
    expect(created.content[1]!.text).toContain('now 333px tall')

    const set = await callTool('set_frame_html', {
      frame_id: frame.id,
      html: doc(block(512)),
      fit_to_content: 'height',
    })
    expect(set.isError).toBeFalsy()
    expect(store.getFrame(frame.id)!.height).toBe(512)
    expect(set.content[1]!.text).toContain('now 512px tall')
  }, 60_000)

  it('delivers the write before the browser wait and keeps metadata broadcasts at the current playback position', async () => {
    const measuring = holdNextMeasure()
    const pending = callTool('create_frame', {
      canvas_id: canvasId,
      name: 'Played',
      html: doc(block(333)),
      fit_to_content: 'height',
    })
    await measuring.reached
    try {
      const created = sent.find((message) => message.type === 'frame:created')?.frame
      expect(created).toBeDefined()
      const frame = store.getFrame(created!.id)!
      const before = sent.length
      actions.updateFrame(frame.id, { height: frame.height }, agent())
      actions.setFrameApproval(frame.id, true, { id: OWNER, name: 'Fit Owner' })
      actions.restackFrames(canvasId, [{ id: frame.id, z: 99 }], agent())
      const updates = sent.slice(before).filter((message) => message.type === 'frame:updated')
      expect(updates).toHaveLength(3)
      for (const update of updates) expect(update.frame!.html.length).toBeLessThan(frame.html.length)
    } finally {
      measuring.release()
    }
    const result = await pending
    expect(result.isError).toBeFalsy()
    expect(result.content[1]!.text).toContain('now 333px tall')
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
