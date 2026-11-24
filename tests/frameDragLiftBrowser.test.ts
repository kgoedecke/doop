import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import sharp from 'sharp'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { Canvas, Frame } from '../shared/types'

/* the part of the rulers fixture's harness used here (rulersBrowser.test.ts
   declares the whole of it on Window) */
type Harness = {
  seed: (canvas: Canvas) => void
  select: (ids: string[]) => void
  viewport: (viewport: { x: number; y: number; zoom: number }) => void
}

/**
 * A frame held by its name wears nothing beyond its selection ring, as in
 * Figma. It used to lift with a ring and a drop shadow written in px, which
 * grew with the camera: at 1600% the dark theme's 1px light ring was a 16px
 * band around the frame.
 */

const FRAME: Frame = {
  id: 'f',
  canvasId: 'c',
  pageId: 'first',
  name: 'Lifted',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  html: '<!doctype html><html><body style="margin:0;height:100vh;background:#0b1530"></body></html>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
}

/* where the frame's top-left corner sits on screen at every zoom */
const CORNER = { x: 500, y: 250 }
/* how far past the frame's left edge the strip reaches, and how far below its top */
const STRIP = 40
const BELOW_TOP = 100
/* the strip's innermost pixels hold the selection ring, whose anti-aliased edge
   moves a few levels from one paint to the next: only what lies past it counts */
const RING = 4

describe.skipIf(!findBrowserPath())('a dragged frame', { timeout: 60_000 }, () => {
  const pages = pagePerTest()
  let page: Page

  async function settle(zoom: number) {
    await page.evaluate(
      (viewport) => (window as unknown as { rulersHarness: Harness }).rulersHarness.viewport(viewport),
      { x: CORNER.x, y: CORNER.y, zoom },
    )
    /* the layout zoom follows 250ms after the camera stops */
    await new Promise((r) => setTimeout(r, 450))
  }

  const surfaceBox = () =>
    page.$eval('[data-frame-surface]', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y }
    })

  /** the brightness (mean of R, G, B) of each pixel in the strip left of the frame, outermost first */
  async function strip() {
    const box = await surfaceBox()
    const png = await page.screenshot({
      clip: { x: Math.round(box.x) - STRIP, y: Math.round(box.y) + BELOW_TOP, width: STRIP, height: 1 },
      type: 'png',
    })
    const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    return Array.from({ length: STRIP }, (_, i) => (data[i * 3]! + data[i * 3 + 1]! + data[i * 3 + 2]!) / 3)
  }

  /** what holding the frame by its name at `zoom` does to the strip: each
   *  pixel's brightness held, less the frame selected and not held (the
   *  canvas's dots and the selection ring, which pressing the name also
   *  draws, cancel out), so anything left is drawn by the hold alone */
  async function held(zoom: number) {
    await page.evaluate(() => (window as unknown as { rulersHarness: Harness }).rulersHarness.select(['f']))
    await settle(zoom)
    const selected = await strip()
    const title = await page.$eval('[data-frame-title]', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y + r.height / 2 }
    })
    await page.mouse.move(title.x + 10, title.y)
    await page.mouse.down()
    /* two frames for the press to render */
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const pressed = await strip()
    await page.mouse.up()
    return pressed.map((v, i) => v - selected[i]!)
  }

  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 })
    /* no pixel grid, which fades in from 300% and would tell the zooms apart */
    await page.evaluateOnNewDocument(() =>
      localStorage.setItem('doop:view-options', JSON.stringify({ pixelGrid: false })),
    )
    await page.goto(fixtureUrl('rulers.html'))
    await page.waitForFunction(() => !!(window as unknown as { rulersHarness?: unknown }).rulersHarness)
  }, 120_000)

  afterEach(async () => {
    await page.mouse.up().catch(() => {})
  })

  async function seed(theme: 'dark' | 'light') {
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark')
    await page.evaluate(
      (frames) =>
        (window as unknown as { rulersHarness: Harness }).rulersHarness.seed({
          id: 'c',
          name: 'Lift',
          frames,
          pages: [{ id: 'first', name: 'Main' }],
          createdAt: 0,
          updatedAt: 0,
        }),
      [FRAME],
    )
    await page.waitForSelector('[data-frame-surface]')
  }

  for (const theme of ['dark', 'light'] as const)
    for (const zoom of [1, 16])
      it(`draws nothing past the selection ring at ${zoom * 100}% (${theme})`, async () => {
        await seed(theme)
        const drawn = (await held(zoom)).slice(0, STRIP - RING)
        expect(
          drawn.filter((v) => Math.abs(v) > 2),
          JSON.stringify(drawn),
        ).toEqual([])
      })
})
