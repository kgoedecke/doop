import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'
import { counterZoom, layoutZoomFor } from '../src/lib/layoutZoom.ts'

type Rect = { x: number; y: number; width: number; height: number }
declare global {
  interface Window {
    testReady: boolean
    rect: (selector: string) => Promise<Rect>
    viewport: () => Promise<{ innerWidth: number; innerHeight: number; dpr: number }>
    shippedPath: FramePath
    zoom: (k: number, path?: FramePath) => Promise<{ width: number; height: number }>
  }
}
/* how FrameView styles a frame iframe under the world's layout zoom: Chromium
   takes the zoom as pixel density, WebKit gets it undone */
type FramePath = 'density' | 'counter'
const PATHS: FramePath[] = ['density', 'counter']

/* Past 100% the settled canvas zoom is a CSS zoom on the world. Chromium
   passes it into each frame document as pixel density; elsewhere the iframe
   element undoes it (zoom 1/k, scale k). Either way the document keeps its
   design-size viewport and rects. Zooming the document inside instead broke viewport units — a 100vh
   column grew k× and pushed its footer off the clipped bottom — and passing
   the world's zoom into the document made WebKit lay it out at the zoomed
   width. A real browser is needed: DOM emulators have no layout or zoom. */
describe('layout zoom', () => {
  it('stays within a float32 ulp of the settled zoom, clamped to [1, max]', () => {
    expect(layoutZoomFor(0.5, 3, false)).toBe(1)
    expect(layoutZoomFor(4, 3, false)).toBe(3)
    expect(layoutZoomFor(17, 16, false)).toBe(16)
    for (let zoom = 1; zoom <= 16; zoom += 0.0007) {
      expect(Math.abs(layoutZoomFor(zoom, 16, false) / zoom - 1)).toBeLessThan(2e-7)
    }
  })

  it('gives every layout zoom an iframe zoom that undoes it exactly in float32', () => {
    for (let zoom = 1; zoom <= 16; zoom += 0.0007) {
      const k = layoutZoomFor(zoom, 16, false)
      expect(Math.fround(Math.fround(k) * Math.fround(counterZoom(k)))).toBe(1)
    }
  })

  it('rounds a density-path zoom up to a whole number, so design sizes scale exactly', () => {
    expect(layoutZoomFor(0.5, 16, true)).toBe(1)
    expect(layoutZoomFor(2, 16, true)).toBe(2)
    expect(layoutZoomFor(2.0000001, 16, true)).toBe(2)
    expect(layoutZoomFor(2.01, 16, true)).toBe(3)
    expect(layoutZoomFor(17, 16, true)).toBe(16)
    for (let zoom = 1; zoom <= 16; zoom += 0.0007) {
      const k = layoutZoomFor(zoom, 16, true)
      expect(Number.isInteger(k)).toBe(true)
      expect(k).toBeGreaterThanOrEqual(zoom - 1e-3)
      expect(k).toBeLessThan(zoom + 1)
    }
  })
})

describe.skipIf(!findBrowserPath())('settled canvas zoom', () => {
  let server: ViteDevServer
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    server = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await server.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 })
    await page.goto(`${server.resolvedUrls!.local[0]}tests/fixtures/frameRasterZoom.html`)
    await page.waitForFunction(() => window.testReady, { timeout: 60_000 })
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await server?.close()
  })

  it('takes the zoom as pixel density in Chromium, the path FrameView ships there', async () => {
    expect(await page.evaluate(() => window.shippedPath)).toBe('density')
  })

  it.each(PATHS)('scales the frame on screen while its document keeps the design viewport (%s)', async (path) => {
    await page.evaluate((p) => window.zoom(1, p), path)
    expect(await page.evaluate(() => window.viewport())).toEqual({ innerWidth: 400, innerHeight: 300, dpr: 1 })
    const box = await page.evaluate((p) => window.zoom(2, p), path)
    expect(box).toEqual({ width: 800, height: 600 })
    /* the density path draws the document at the zoom; the counter-zoom
       path leaves it at 1x for the engine to rasterize from the world */
    expect(await page.evaluate(() => window.viewport())).toEqual({
      innerWidth: 400,
      innerHeight: 300,
      dpr: path === 'density' ? 2 : 1,
    })
  })

  it.each(PATHS)('leaves a 100vh column and its bottom-anchored footer where they were (%s)', async (path) => {
    await page.evaluate((p) => window.zoom(1, p), path)
    const rest = {
      body: await page.evaluate(() => window.rect('body')),
      foot: await page.evaluate(() => window.rect('.foot')),
    }
    expect(rest.body).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    expect(rest.foot.y).toBe(250)

    /* 1.31 and 1.1111 are zooms whose plain 1/k leaves the document's zoom at
       0.99999994 in float32, which nudged its layout off the design size */
    for (const k of [1.31, 1.1111, 1.5, 2, 3, 5.5, 8, 16]) {
      await page.evaluate(([k, p]) => window.zoom(k, p), [k, path] as const)
      expect(await page.evaluate(() => window.rect('body'))).toEqual(rest.body)
      expect(await page.evaluate(() => window.rect('.foot'))).toEqual(rest.foot)
    }
    await page.evaluate((p) => window.zoom(1, p), path)
    expect(await page.evaluate(() => window.rect('.foot'))).toEqual(rest.foot)
  })
})
