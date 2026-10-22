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
    zoom: (k: number) => Promise<{ width: number; height: number }>
  }
}

/* Past 100% the settled canvas zoom is a CSS zoom on the world, which each
   iframe element undoes (zoom 1/k, scale k): the document paints at the
   world's resolution while its own zoom, viewport and rects stay at design
   size. Zooming the document inside instead broke viewport units — a 100vh
   column grew k× and pushed its footer off the clipped bottom — and passing
   the world's zoom into the document made WebKit lay it out at the zoomed
   width. A real browser is needed: DOM emulators have no layout or zoom. */
describe('layout zoom', () => {
  it('stays within a float32 ulp of the settled zoom, clamped to [1, max]', () => {
    expect(layoutZoomFor(0.5, 3)).toBe(1)
    expect(layoutZoomFor(4, 3)).toBe(3)
    expect(layoutZoomFor(9, 8)).toBe(8)
    for (let zoom = 1; zoom <= 8; zoom += 0.0007) {
      expect(Math.abs(layoutZoomFor(zoom, 8) / zoom - 1)).toBeLessThan(2e-7)
    }
  })

  it('gives every layout zoom an iframe zoom that undoes it exactly in float32', () => {
    for (let zoom = 1; zoom <= 8; zoom += 0.0007) {
      const k = layoutZoomFor(zoom, 8)
      expect(Math.fround(Math.fround(k) * Math.fround(counterZoom(k)))).toBe(1)
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

  it('scales the frame on screen while its document keeps the design viewport', async () => {
    expect(await page.evaluate(() => window.viewport())).toEqual({ innerWidth: 400, innerHeight: 300, dpr: 1 })
    const box = await page.evaluate(() => window.zoom(2))
    expect(box).toEqual({ width: 800, height: 600 })
    expect(await page.evaluate(() => window.viewport())).toEqual({ innerWidth: 400, innerHeight: 300, dpr: 1 })
  })

  it('leaves a 100vh column and its bottom-anchored footer where they were', async () => {
    await page.evaluate(() => window.zoom(1))
    const rest = {
      body: await page.evaluate(() => window.rect('body')),
      foot: await page.evaluate(() => window.rect('.foot')),
    }
    expect(rest.body).toEqual({ x: 0, y: 0, width: 400, height: 300 })
    expect(rest.foot.y).toBe(250)

    /* 1.31 and 1.1111 are zooms whose plain 1/k leaves the document's zoom at
       0.99999994 in float32, which nudged its layout off the design size */
    for (const k of [1.31, 1.1111, 1.5, 2, 3, 5.5, 8]) {
      await page.evaluate((k) => window.zoom(k), k)
      expect(await page.evaluate(() => window.rect('body'))).toEqual(rest.body)
      expect(await page.evaluate(() => window.rect('.foot'))).toEqual(rest.foot)
    }
    await page.evaluate(() => window.zoom(1))
    expect(await page.evaluate(() => window.rect('.foot'))).toEqual(rest.foot)
  })
})
