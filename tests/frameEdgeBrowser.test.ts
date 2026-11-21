import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import sharp from 'sharp'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { Canvas, Frame } from '../shared/types'

/* the part of the rulers fixture's harness used here (rulersBrowser.test.ts
   declares the whole of it on Window) */
type Harness = {
  seed: (canvas: Canvas) => void
  viewport: (viewport: { x: number; y: number; zoom: number }) => void
}

/**
 * The edge where a frame's design meets the canvas. The frame's document is
 * its own layer, scaled by the canvas zoom and antialiased at its edge; white
 * painted by the page behind it, to the edge, showed through as a light 1px
 * line between a dark design and the dark canvas at many zooms.
 */

const frame = (id: string, name: string, x: number, html: string): Frame => ({
  id,
  canvasId: 'c',
  pageId: 'first',
  name,
  x,
  y: 0,
  width: 1440,
  height: 1024,
  html,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
})

const DARK = frame(
  'dark',
  'Dark design',
  1560,
  '<!doctype html><html><body style="margin:0;height:100vh;background:#0b1530"></body></html>',
)
/* no background of its own: it must still sit on white */
const PLAIN = frame('plain', 'Plain design', 3200, '<!doctype html><html><body><p>No background</p></body></html>')

/* zooms where the line showed before the fix, at 1 device pixel per CSS
   pixel, each with the camera at a few sub-pixel offsets: the line shows where
   the frame's edge falls between device pixels */
const ZOOMS = [0.1, 0.11, 0.13, 0.18, 0.2, 0.24, 0.29]
const OFFSETS = [0.13, 0.37, 0.62, 0.88]

describe.skipIf(!findBrowserPath())('frame edge', { timeout: 60_000 }, () => {
  const pages = pagePerTest()
  let page: Page

  const iframeBox = (name: string) =>
    page.$eval(`iframe[title="${name}"]`, (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })

  /** a screenshot's pixels, as brightness (mean of R, G, B) per pixel */
  async function grab(clip: { x: number; y: number; width: number; height: number }) {
    const png = await page.screenshot({ clip, type: 'png' })
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => {
      const i = (y * info.width + x) * 3
      return (data[i]! + data[i + 1]! + data[i + 2]!) / 3
    }
    return { at, width: info.width, height: info.height }
  }

  async function settle(zoom: number, offset = 0) {
    await page.evaluate(
      (viewport) => (window as unknown as { rulersHarness: Harness }).rulersHarness.viewport(viewport),
      { x: 300 - 1560 * zoom + offset, y: 80, zoom },
    )
    /* the layout zoom follows 250ms after the camera stops */
    await new Promise((r) => setTimeout(r, 450))
  }

  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 })
    await page.goto(fixtureUrl('rulers.html'))
    await page.waitForFunction(() => !!(window as unknown as { rulersHarness?: unknown }).rulersHarness)
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await page.evaluate(
      (frames) =>
        (window as unknown as { rulersHarness: Harness }).rulersHarness.seed({
          id: 'c',
          name: 'Edges',
          frames,
          pages: [{ id: 'first', name: 'Main' }],
          createdAt: 0,
          updatedAt: 0,
        }),
      [DARK, PLAIN],
    )
    await page.waitForSelector('iframe[title="Dark design"]')
    await settle(0.2)
    /* the designs have rendered once the dark frame's middle is dark */
    for (let i = 0; i < 50; i++) {
      const box = await iframeBox(DARK.name)
      const { at } = await grab({
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2),
        width: 1,
        height: 1,
      })
      if (at(0, 0) < 60) break
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 120_000)

  it('shows no line lighter than both the canvas and the design along the edge', async () => {
    const worst: Record<string, number> = {}
    for (const zoom of ZOOMS)
      for (const offset of OFFSETS) {
        await settle(zoom, offset)
        const box = await iframeBox(DARK.name)
        const band = await grab({
          x: Math.floor(box.x) - 4,
          y: Math.round(box.y) + 10,
          width: 8,
          height: Math.round(box.height) - 20,
        })
        let max = 0
        for (let y = 0; y < band.height; y++)
          for (let x = 2; x < band.width - 2; x++)
            max = Math.max(max, band.at(x, y) - Math.max(band.at(x - 2, y), band.at(x + 2, y)))
        worst[`${Math.round(zoom * 100)}% +${offset}`] = Math.round(max)
      }
    /* antialiasing alone stays well under this; the line was 40-110 brighter */
    expect(Object.entries(worst).filter(([, excess]) => excess > 25)).toEqual([])
  })

  it('keeps a design without a background on white', async () => {
    await settle(0.2)
    const box = await iframeBox(PLAIN.name)
    const { at } = await grab({
      x: Math.round(box.x + box.width * 0.7),
      y: Math.round(box.y + box.height * 0.7),
      width: 1,
      height: 1,
    })
    expect(at(0, 0)).toBe(255)
  })
})
