import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { Frame } from '../shared/types'
import type { ElementInfo, GeometryEdit } from '../src/lib/frameBridge'
import { ROTATE_ZONE_PX } from '../src/lib/frameRotate'

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
      panelOpen: () => boolean
      picked: () => string[]
      pickAlso: (selector: string) => void
      nudge: (dx: number, dy: number) => boolean
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

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }

describe.skipIf(!findBrowserPath())('frame rotate zones', () => {
  let browser: TestBrowser
  let page: Page
  let saved: Frame
  let saves = 0
  const copies: Frame[] = []
  const errors: string[] = []

  const box = (selector: string) =>
    page.$eval(selector, (el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } as Box
    })
  const zone = (corner: string) => box(`[data-frame-rotate-handle="${corner}"]`)
  const centre = async () => {
    const b = await box('[data-frame-surface]')
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  }
  /** the point `degrees` further clockwise around the frame's centre than `from` */
  const swung = (c: { x: number; y: number }, from: { x: number; y: number }, degrees: number) => {
    const rad = (degrees * Math.PI) / 180
    const dx = from.x - c.x
    const dy = from.y - c.y
    return { x: c.x + dx * Math.cos(rad) - dy * Math.sin(rad), y: c.y + dx * Math.sin(rad) + dy * Math.cos(rad) }
  }
  const cursorOf = (corner: string) =>
    page.$eval(
      `[data-frame-rotate-handle="${corner}"]`,
      (el) => decodeURIComponent(getComputedStyle(el).cursor).match(/data-cursor="([^"]+)"/)?.[1],
    )
  const transform = () => page.$eval('[data-frame-surface]', (el) => (el.parentElement as HTMLElement).style.transform)

  /** a drag from a corner's zone, swinging the pointer `degrees` around the centre */
  async function turn(corner: string, degrees: number, { shift = false, escape = false } = {}) {
    const z = await zone(corner)
    const from = { x: z.left + z.width / 2, y: z.top + z.height / 2 }
    const c = await centre()
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    if (shift) await page.keyboard.down('Shift')
    const mid = swung(c, from, degrees / 2)
    const to = swung(c, from, degrees)
    await page.mouse.move(mid.x, mid.y)
    await page.mouse.move(to.x, to.y, { steps: 4 })
    if (escape) await page.keyboard.press('Escape')
    await page.mouse.up()
    if (shift) await page.keyboard.up('Shift')
  }
  async function reset() {
    await page.evaluate(() => window.elementPanelHarness.setZoom(1))
    await page.evaluate(() => window.elementPanelHarness.deselect())
    saved = { ...saved, x: 40, y: 60, width: 600, height: 500, rotation: undefined, updatedAt: saved.updatedAt + 1 }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    await page.evaluate(() => window.elementPanelHarness.selectFrame())
    await page.waitForSelector('[data-frame-rotate-handle]')
  }

  beforeAll(async () => {
    browser = await openBrowser()
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
      } else if (new URL(request.url()).pathname === '/api/canvases/c/frames' && request.method() === 'POST') {
        const copy = { ...saved, rotation: undefined, ...JSON.parse(request.postData()!), id: `copy-${copies.length}` }
        copies.push(copy)
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(copy) })
      } else await request.continue()
    })
    await page.goto(fixtureUrl('elementPanel.html'))
    await page.waitForFunction(() => !!window.elementPanelHarness)
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Turn',
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
    await page?.screenshot({ path: '/tmp/doop-frame-rotate.png' })
    await page?.close()
    await browser?.close()
    expect(errors).toEqual([])
  })

  it('wears a zone just outside each corner, clear of the corner grip, with the rotate cursor', async () => {
    expect(
      await page.$$eval('[data-frame-rotate-handle]', (els) =>
        els.map((e) => e.getAttribute('data-frame-rotate-handle')),
      ),
    ).toEqual(['nw', 'ne', 'se', 'sw'])
    const surface = await box('[data-frame-surface]')
    const se = await zone('se')
    expect(se.width).toBe(ROTATE_ZONE_PX)
    expect(se.height).toBe(ROTATE_ZONE_PX)
    /* past the corner on both axes, and beyond the corner grip's hit box */
    const grip = await box('[data-frame-resize-handle="se"]')
    expect(se.left).toBeGreaterThanOrEqual(grip.right)
    expect(se.top).toBeGreaterThanOrEqual(grip.bottom)
    expect(se.left).toBeGreaterThan(surface.right)
    expect(se.top).toBeGreaterThan(surface.bottom)
    const nw = await zone('nw')
    expect(nw.right).toBeLessThan(surface.left)
    expect(nw.bottom).toBeLessThan(surface.top)
    for (const corner of ['nw', 'ne', 'se', 'sw']) expect(await cursorOf(corner)).toBe('rotate')
    await page.screenshot({ path: '/tmp/doop-frame-rotate-zones.png' })
  })

  it('keeps the zones at screen size when zoomed in', async () => {
    for (const zoom of [3, 16]) {
      await page.evaluate((z) => window.elementPanelHarness.setZoom(z), zoom)
      expect((await zone('se')).width).toBeCloseTo(ROTATE_ZONE_PX, 3)
    }
    await page.evaluate(() => window.elementPanelHarness.setZoom(1))
  })

  it('turns the frame about its centre, saving once and recording one undo step', async () => {
    const before = saves
    await turn('se', 90)
    await expect.poll(() => saves).toBe(before + 1)
    expect(saved.rotation).toBeCloseTo(90, 1)
    /* the box itself is untouched: the turn is a transform on it */
    expect(saved).toMatchObject({ x: 40, y: 60, width: 600, height: 500 })
    expect(await transform()).toMatch(/^rotate\(9\d(\.\d+)?deg\)$|^rotate\(90deg\)$/)
    expect(await page.$eval('[data-frame-size]', (el) => el.textContent)).toBe('600 × 500')
    /* the turned frame's bounds are the swapped box, around the same centre */
    const b = await box('[data-frame-surface]')
    expect(b.width).toBeCloseTo(500, 0)
    expect(b.height).toBeCloseTo(600, 0)
    expect(b.left + b.width / 2).toBeCloseTo(340, 0)
    expect(b.top + b.height / 2).toBeCloseTo(310, 0)
    await page.evaluate(() => window.elementPanelHarness.undo())
    await expect.poll(() => saved.rotation).toBe(0)
    expect(await transform()).toBe('')
  })

  it('snaps to fifteen degrees with Shift', async () => {
    await reset()
    const before = saves
    await turn('ne', 50, { shift: true })
    await expect.poll(() => saves).toBe(before + 1)
    expect(saved.rotation).toBe(45)
    expect(await transform()).toBe('rotate(45deg)')
    await page.screenshot({ path: '/tmp/doop-frame-rotate-turned.png' })
  })

  it('turns the rotate cursors with the frame', async () => {
    /* the glyph is drawn for the north-east corner, so at 45° it turns by the frame's 45° */
    const angle = await page.$eval(
      '[data-frame-rotate-handle="ne"]',
      (el) => decodeURIComponent(getComputedStyle(el).cursor).match(/rotate\((\d+) 12 12\)/)?.[1],
    )
    expect(angle).toBe('45')
  })

  it('resizes a turned frame along its own axes and keeps the far edge still', async () => {
    await reset()
    saved = { ...saved, rotation: 90, updatedAt: saved.updatedAt + 1 }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    await page.evaluate(() => window.elementPanelHarness.selectFrame())
    await page.waitForFunction(() => document.querySelector('[data-frame-resize-handle="e"]'))
    /* turned a quarter, the east grip hangs under the frame's centre */
    const grip = await box('[data-frame-resize-handle="e"]')
    const c = await centre()
    const from = { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2 }
    expect(Math.abs(from.x - c.x)).toBeLessThan(2)
    expect(from.y).toBeGreaterThan(c.y)
    const before = saves
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x, from.y + 20)
    await page.mouse.move(from.x, from.y + 40, { steps: 4 })
    await page.mouse.up()
    await expect.poll(() => saves).toBe(before + 1)
    /* 40px of width; the far (west) edge, which sits at the top on the
       canvas, has not moved: the box shifts to keep it there */
    expect(saved).toMatchObject({ x: 20, y: 80, width: 640, height: 500, rotation: 90 })
  })

  it('puts the frame back on Escape and saves nothing', async () => {
    await reset()
    const before = saves
    await turn('sw', 60, { escape: true })
    expect(await transform()).toBe('')
    /* a click on a zone is not a turn either */
    const z = await zone('nw')
    await page.mouse.click(z.left + z.width / 2, z.top + z.height / 2)
    await new Promise((r) => setTimeout(r, 100))
    expect(saves).toBe(before)
    expect(saved.rotation).toBeUndefined()
  })
  it('keeps the rotation on the copy left behind by Alt+Shift-drag', async () => {
    await reset()
    saved = { ...saved, rotation: 30, updatedAt: saved.updatedAt + 1 }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    await page.evaluate(() => window.elementPanelHarness.selectFrame())
    const title = await box('[data-frame-title]')
    const from = { x: title.left + title.width / 2, y: title.top + title.height / 2 }
    const before = copies.length
    await page.mouse.move(from.x, from.y)
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await page.mouse.down()
    await page.mouse.move(from.x + 80, from.y + 40, { steps: 4 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    await expect.poll(() => copies.length).toBe(before + 1)
    expect(copies[before]).toMatchObject({ rotation: 30, x: 40, y: 60, width: 600, height: 500 })
    await expect.poll(() => saved.x).not.toBe(40)
    expect(saved.rotation).toBe(30)
  })
})
