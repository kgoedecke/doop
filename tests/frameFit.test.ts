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
    expect(texts(result)).toContain('Write the frame HTML')
    expect(store.getCanvas(canvasId)!.frames.length).toBe(before)
  })

  it('refuses a frame an agent is still streaming into', async () => {
    const frame = frameWith('')
    actions.appendFrameHtml(frame.id, doc(block(500)), agent(), { start: true })
    const result = await fit(frame)
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('stream finishes')
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

  it('preserves a viewport-sized inner scroller and refuses unbounded or over-limit content', async () => {
    const shell = frameWith(doc('<main style="height:100vh;overflow:auto">' + block(1000) + '</main>'))
    expect((await fit(shell)).isError).toBeFalsy()
    expect(shell.height).toBe(300)
    const inbox = frameWith(
      doc(
        '<header style="flex:none;height:56px"></header><main style="flex:1;overflow:auto">' +
          block(1200) +
          '</main><footer style="flex:none;height:56px"></footer>',
        'margin:0;height:100vh;display:flex;flex-direction:column',
      ),
      { height: 844 },
    )
    expect((await fit(inbox)).isError).toBeFalsy()
    expect(inbox.height).toBe(844)
    const panel = frameWith(doc('<main style="height:120px;overflow:auto">' + block(600) + '</main>'))
    expect((await fit(panel)).isError).toBeFalsy()
    expect(panel.height).toBe(120)
    for (const html of [doc(block(0, 'height:100vh') + block(100)), doc(block(17000))]) {
      const frame = frameWith(html)
      expect((await fit(frame, { name: 'Should not apply' })).isError).toBe(true)
      expect(frame).toMatchObject({ name: 'Fit', height: 300 })
    }
  }, 60_000)

  it('loads at the requested width and full height, including above the inspection cap', async () => {
    const frame = frameWith(
      doc(
        '<div id="box"></div><script>box.style.height = (innerHeight > 4000 && innerWidth === 750 ? 4600 : 100) + "px"</script>',
      ),
      { height: 5000 },
    )
    expect((await fit(frame, { width: 750 })).isError).toBeFalsy()
    expect(frame).toMatchObject({ width: 750, height: 4600 })
  }, 60_000)

  it('refuses an unverified candidate on a fresh load and preserves the HTML write', async () => {
    const html = doc('<div id="box"></div><script>box.style.height = (innerHeight === 200 ? 900 : 200) + "px"</script>')
    const frame = frameWith(doc(block(50)))
    expect((await fit(frame, { fit_to_content: 'width' })).isError).toBe(true)
    const written = await callTool('set_frame_html', { frame_id: frame.id, html, fit_to_content: 'height' })
    expect(written.isError).toBeFalsy()
    expect(texts(written)).toContain('still overflows when loaded')
    expect(frame.html).toContain('innerHeight === 200')
    expect(frame.height).toBe(300)
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

  it('sends the write before measuring, and never jumps a playback ahead', async () => {
    const html = doc(block(333) + `<p>${'A design long enough to play back over a few ticks. '.repeat(200)}</p>`)
    const result = await callTool('create_frame', {
      canvas_id: canvasId,
      name: 'Played',
      html,
      fit_to_content: 'height',
    })
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
