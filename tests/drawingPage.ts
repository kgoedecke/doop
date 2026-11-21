import { afterAll, beforeEach, expect } from 'vitest'
import type { Page } from 'puppeteer-core'
import type { TextFormatCommand } from '../src/lib/richText'
import { fixtureUrl, pagePerTest, type TestPages } from './browser'
import type { Canvas, ElementComment, Frame } from '../shared/types'
import type { ImportedSvg } from '../src/lib/svgImport'

/* What the drawing browser tests share: the page each test drives, the API
   the page talks to (answered here, from `saved`), and the gestures and
   fixtures the files have in common. A file calls `drawingPage()` inside its
   `describe` and reads the rest as live bindings. */

declare global {
  interface Window {
    drawingHarness: {
      seed: (canvas: Canvas) => void
      comments: (comments: ElementComment[]) => void
      viewport: (viewport: { x: number; y: number; zoom: number }) => void
      camera: () => { x: number; y: number; zoom: number }
      peer: (cursor: { x: number; y: number }) => void
      page: (id: string) => void
      selectFrames: (ids: string[]) => void
      state: () => {
        frames: Frame[]
        tool: string
        selectedIds: string[]
        selectedElement: { frameId: string; selector: string } | null
        selectedElements: string[]
      }
      undo: () => Promise<void>
      redo: () => Promise<void>
      pick: (el: { frameId: string; selector: string } | null) => void
      /** several Layers rows picked, the last the primary */
      pickMany: (frameId: string, selectors: string[]) => void
      formatText: (command: TextFormatCommand) => boolean
      /** an SVG file read the way a paste reads it, with the browser's computed styles */
      importSvg: (markup: string, name: string) => ImportedSvg | null
    }
    delayedLayerProbe: MessageEvent | null
    heldMoveHits: MessageEvent[] | null
  }
}

/** the running test's page */
export let page: Page
/** the frames the answered API holds */
export let saved: Frame[] = []
let nextId = 0
export let patchRequests = 0
/* the anchors sent by PATCH /api/comments/:id/anchor, in order */
export let commentMoves: Record<string, unknown>[] = []
const errors: string[] = []

/* every test gets its own page (see pagePerTest) */
async function openPage(pages: TestPages): Promise<Page> {
  const page = await pages.open()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (err) => errors.push(String(err)))
  /* holds the frames' hit-test answers while a test sets heldMoveHits; it
     must listen before the app does, since a window's own listeners run in
     the order they were added */
  await page.evaluateOnNewDocument(() => {
    window.heldMoveHits = null
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'doop:move-hit-result' || !window.heldMoveHits) return
      window.heldMoveHits.push(event)
      event.stopImmediatePropagation()
    })
  })
  await page.setRequestInterception(true)
  page.on('request', async (req) => {
    const path = new URL(req.url()).pathname
    if (path === '/api/canvases/c/frames' && req.method() === 'POST') {
      const frame = {
        ...JSON.parse(req.postData()!),
        id: `drawn-${++nextId}`,
        canvasId: 'c',
        createdAt: 0,
        updatedAt: 0,
      }
      saved.push(frame)
      await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(frame) })
    } else if (path.startsWith('/api/frames/') && req.method() === 'PATCH') {
      patchRequests++
      const id = path.split('/').at(-1)
      const frame = { ...saved.find((f) => f.id === id), ...JSON.parse(req.postData()!) }
      saved = saved.map((f) => (f.id === id ? frame : f))
      await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(frame) })
    } else if (path.endsWith('/comments') && req.method() === 'POST') {
      await req.respond({ status: 200, contentType: 'application/json', body: req.postData()! })
    } else if (path.startsWith('/api/comments/') && path.endsWith('/anchor') && req.method() === 'PATCH') {
      commentMoves.push(JSON.parse(req.postData()!))
      await req.respond({ status: 200, contentType: 'application/json', body: req.postData()! })
    } else if (path.startsWith('/api/frames/') && req.method() === 'DELETE') {
      saved = saved.filter((f) => f.id !== path.split('/').at(-1))
      await req.respond({ status: 200, contentType: 'application/json', body: '{}' })
    } else await req.continue()
  })
  return page
}

/** Opens the drawing fixture on a seeded canvas before every test of the
 *  calling `describe`, and fails the file on an uncaught page error. */
export function drawingPage(): void {
  const pages = pagePerTest()

  beforeEach(async () => {
    page = await openPage(pages)
    saved = []
    nextId = 0
    patchRequests = 0
    commentMoves = []
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(fixtureUrl('drawing.html'))
    /* a cold fixture load on a slow CI runner can pass the default 10s wait */
    await page.waitForFunction(() => !!window.drawingHarness, { timeout: 30_000 })
    await page.evaluate(() =>
      window.drawingHarness.seed({
        id: 'c',
        name: 'Draw',
        frames: [],
        pages: [
          { id: 'first', name: 'Main' },
          { id: 'second', name: 'Other' },
        ],
        createdAt: 0,
        updatedAt: 0,
      }),
    )
    await page.waitForSelector('[aria-label="Canvas tools"]')
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 2 }))
  })

  afterAll(() => {
    expect(errors).toEqual([])
  })
}

export async function drag(from: [number, number], to: [number, number]) {
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move(...to, { steps: 5 })
  await page.mouse.up()
}
export async function waitForFrames(count: number) {
  await page.waitForFunction((n) => window.drawingHarness.state().frames.length === n, {}, count)
  return page.evaluate(() => window.drawingHarness.state().frames)
}

export async function seedFrames(frames: Frame[]) {
  saved = frames
  await page.evaluate(
    (frames) =>
      window.drawingHarness.seed({
        id: 'c',
        name: 'Draw',
        frames,
        pages: [
          { id: 'first', name: 'Main' },
          { id: 'second', name: 'Other' },
        ],
        createdAt: 0,
        updatedAt: 0,
      }),
    frames,
  )
}

export async function visibleDrawing(title: string, selector = '[data-doop-drawing]') {
  const handle = await page.waitForSelector(`iframe[title="${title}"]`)
  const iframe = (await handle!.contentFrame())!
  await iframe.waitForSelector(selector)
  const readOuter = () =>
    handle!.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const css = getComputedStyle(el)
      /* the iframe undoes the world's layout zoom, so its CSS width is the
         design width and the box over it is the canvas zoom */
      return { x: box.x, y: box.y, scale: box.width / Number.parseFloat(css.width) }
    })
  let result: { x: number; y: number; width: number; height: number } | null = null
  // The inner rect is in design px whatever the layout zoom; only a viewport
  // still moving between the two reads could mix two states.
  await expect
    .poll(
      async () => {
        const outer = await readOuter()
        const inner = await iframe.$eval(selector, (el) => {
          const box = el.getBoundingClientRect()
          return { x: box.x, y: box.y, width: box.width, height: box.height }
        })
        const after = await readOuter()
        if ((['x', 'y', 'scale'] as const).some((key) => outer[key] !== after[key])) return false
        result = {
          x: outer.x + inner.x * outer.scale,
          y: outer.y + inner.y * outer.scale,
          width: inner.width * outer.scale,
          height: inner.height * outer.scale,
        }
        return true
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return result!
}

export const layerFrame = (body: string): Frame => ({
  id: 'layers',
  canvasId: 'c',
  pageId: 'first',
  name: 'Layers',
  x: 70,
  y: 50,
  width: 700,
  height: 500,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'User',
  html: `<!doctype html><html><head><style>body { margin: 0 }</style></head><body>${body}</body></html>`,
})

export const rectangle =
  '<div id="rect" style="position:absolute;left:50px;top:60px;width:100px;height:80px;background:coral"></div>'

export const flowImage =
  '<img id="photo" width="80" height="60" style="display:block" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E">'

export const flowBoxes = `<div style="display:flex;align-items:flex-start;gap:40px;padding:20px">
    <div id="from" style="width:160px;padding:20px;background:#eee">${flowImage}</div>
    <div id="into" style="width:160px;padding:20px;background:#ddd"><p style="margin:0;height:30px">Destination</p></div>
  </div>`
