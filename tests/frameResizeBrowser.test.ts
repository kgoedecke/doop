import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import type { Frame } from '../shared/types'
import type { ElementInfo, GeometryEdit } from '../src/lib/frameBridge'

/* the fixture's harness: the same declaration as elementResizeBrowser.test.ts,
   which TypeScript merges only while the two stay identical */
declare global {
  interface Window {
    heldResizeReply: MessageEvent | null
    holdResizeReply: boolean
    elementPanelHarness: {
      seed: (frame: Frame) => void
      remote: (frame: Frame) => void
      select: (selector: string) => void
      selectFrame: () => void
      deselect: () => void
      picked: () => string[]
      setTool: (tool: 'select' | 'hand') => void
      setZoom: (zoom: number) => void
      undo: () => Promise<void>
      geometry: (selector: string, edit: GeometryEdit) => Promise<ElementInfo | null>
      redo: () => Promise<void>
    }
  }
}

const HTML =
  '<!doctype html><html><body style="margin:0"><div style="width:100px;height:40px;background:#ddd"></div></body></html>'

describe.skipIf(!findBrowserPath())('frame resize handles', () => {
  let vite: ViteDevServer
  let browser: Browser
  let page: Page
  let saved: Frame
  let saves = 0
  const errors: string[] = []

  async function handle(name: string) {
    return page.$eval(`[data-frame-resize-handle="${name}"]`, (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
  }
  async function drag(name: string, dx: number, dy: number, { shift = false } = {}) {
    const before = saves
    const from = await handle(name)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    if (shift) await page.keyboard.down('Shift')
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2)
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 })
    await page.mouse.up()
    if (shift) await page.keyboard.up('Shift')
    await expect.poll(() => saves).toBe(before + 1)
  }
  async function reset() {
    await page.evaluate(() => window.elementPanelHarness.setZoom(1))
    await page.evaluate(() => window.elementPanelHarness.deselect())
    saved = { ...saved, x: 40, y: 60, width: 600, height: 500, updatedAt: saved.updatedAt + 1 }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    await page.evaluate(() => window.elementPanelHarness.selectFrame())
    await page.waitForSelector('[data-frame-resize-handles]')
  }
  const rect = () => ({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })

  beforeAll(async () => {
    vite = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await vite.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.setViewport({ width: 1000, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      if (new URL(request.url()).pathname === '/api/frames/f' && request.method() === 'PATCH') {
        saves += 1
        saved = { ...saved, ...JSON.parse(request.postData()!) }
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) })
      } else await request.continue()
    })
    await page.goto(`${vite.resolvedUrls!.local[0]}tests/fixtures/elementPanel.html`)
    await page.waitForFunction(() => !!window.elementPanelHarness)
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Resize',
      x: 40,
      y: 60,
      width: 600,
      height: 500,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
      html: HTML,
    }
    await reset()
  }, 60_000)

  afterAll(async () => {
    await page?.screenshot({ path: '/tmp/doop-frame-resize.png' })
    await page?.close()
    await browser?.close()
    await vite?.close()
    expect(errors).toEqual([])
  })

  it('wears a grip in each corner and an edge on each side, with the size underneath', async () => {
    expect(
      await page.$$eval('[data-frame-resize-handle]', (els) =>
        els.map((e) => e.getAttribute('data-frame-resize-handle')),
      ),
    ).toEqual(['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'])
    expect(await page.$eval('[data-frame-size]', (el) => el.textContent)).toBe('600 × 500')
    const se = await handle('se')
    const surface = await page.$eval('[data-frame-surface]', (el) => el.getBoundingClientRect().toJSON() as DOMRect)
    /* on the frame's edge, where the ring's centre line runs */
    expect(se).toEqual({ x: surface.right, y: surface.bottom })
    expect(await page.$eval('[data-frame-surface]', (el) => getComputedStyle(el).outlineOffset)).toBe('-1px')
    await page.screenshot({ path: '/tmp/doop-frame-resize-grips.png' })
  })

  it('keeps the grips and the ring at screen size when zoomed in', async () => {
    /* bounding rects are screen px: the fixture lays its world out at CSS
       zoom k and transforms by the rest, as the Stage does */
    const gripAt = () => page.$eval('[data-frame-resize-handle="se"] > div', (el) => el.getBoundingClientRect().width)
    const frameAt = () => page.$eval('[data-frame-surface]', (el) => el.getBoundingClientRect().width)
    /* the ring is an outline, which no rect measures: its computed width
       times the zoom is its size on screen */
    const ringAt = async (zoom: number) =>
      (await page.$eval('[data-frame-surface]', (el) => parseFloat(getComputedStyle(el).outlineWidth))) * zoom
    expect(await gripAt()).toBe(6)
    expect(await ringAt(1)).toBe(2)
    for (const zoom of [3, 16]) {
      await page.evaluate((z) => window.elementPanelHarness.setZoom(z), zoom)
      expect(await frameAt()).toBe(600 * zoom)
      expect(await gripAt()).toBeCloseTo(6, 3)
      expect(await ringAt(zoom)).toBeCloseTo(2, 3)
    }
    await page.evaluate(() => window.elementPanelHarness.setZoom(1))
    expect(await gripAt()).toBe(6)
  })

  it('drags the south-east grip, saving once and recording one undo step', async () => {
    const before = saves
    await drag('se', 50, 30)
    expect(rect()).toEqual({ x: 40, y: 60, width: 650, height: 530 })
    expect(saves - before).toBe(1)
    expect(await page.$eval('[data-frame-size]', (el) => el.textContent)).toBe('650 × 530')
    await page.evaluate(() => window.elementPanelHarness.undo())
    await expect.poll(() => rect()).toEqual({ x: 40, y: 60, width: 600, height: 500 })
  })

  it('saves a drag under the click threshold, and nothing for a click', async () => {
    await reset()
    const before = saves
    const from = await handle('se')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 2, from.y + 1)
    await page.mouse.up()
    await expect.poll(() => saves).toBe(before + 1)
    expect(rect()).toEqual({ x: 40, y: 60, width: 602, height: 501 })
  })

  it('moves the near edge from a north-west grip and keeps the far corner still', async () => {
    await reset()
    await drag('nw', 20, 10)
    expect(rect()).toEqual({ x: 60, y: 70, width: 580, height: 490 })
    await drag('w', -30, 0)
    expect(rect()).toEqual({ x: 30, y: 70, width: 610, height: 490 })
    await drag('n', 0, 15)
    expect(rect()).toEqual({ x: 30, y: 85, width: 610, height: 475 })
  })

  it('keeps the aspect ratio with Shift', async () => {
    await reset()
    await drag('e', 300, 0, { shift: true })
    expect(rect()).toEqual({ x: 40, y: 60, width: 900, height: 750 })
  })

  it('lets a frame shrink to a single pixel', async () => {
    await reset()
    await drag('se', -700, -600)
    expect(rect()).toEqual({ x: 40, y: 60, width: 1, height: 1 })
    expect(await page.$eval('[data-frame-size]', (el) => el.textContent)).toBe('1 × 1')
  })
})
