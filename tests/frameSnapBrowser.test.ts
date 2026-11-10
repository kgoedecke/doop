import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { Canvas, Frame } from '../shared/types'

/* the part of the rulers fixture's harness used here (rulersBrowser.test.ts
   declares the whole of it on Window) */
type Harness = {
  seed: (canvas: Canvas) => void
  viewport: (viewport: { x: number; y: number; zoom: number }) => void
}

/**
 * Frames on whole device pixels (src/lib/frameSnap.ts), on the real Stage and
 * FrameView. The light line this prevents shows only on a GPU-rasterized
 * page, which headless Chromium does not draw, so the test is on the
 * geometry that rules it out: no frame edge between two device pixels.
 */

const frame = (id: string, at: Partial<Frame>): Frame => ({
  id,
  canvasId: 'c',
  pageId: 'first',
  name: id,
  x: 0,
  y: 0,
  width: 988,
  height: 910,
  html: '<!doctype html><html><body style="margin:0;height:100vh;background:#0b1530"></body></html>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
  ...at,
})

const FRAMES = [
  frame('plain', { x: 1578, y: -38 }),
  frame('odd', { x: -412.5, y: 355.25, width: 760.4, height: 560.7 }),
  frame('turned', { x: 3000, y: 0, rotation: 12 }),
]

const ZOOMS = [0.1, 0.13, 0.29, 0.4653, 0.5749, 0.75, 1, 1.3, 2.5]
const OFFSETS = [0, 0.19, 0.37, 0.62, 0.88]
/* how far off a device pixel an edge may sit: the browser lays a fractional
   frame box out in 1/64 px steps, which the snap cannot see */
const ON_GRID = 0.05
/* the layout zoom and the snap follow 250ms after the camera stops */
const SETTLED_MS = 450

describe.skipIf(!findBrowserPath())('frame snap', { timeout: 120_000 }, () => {
  let browser: TestBrowser
  let page: Page

  const camera = (viewport: { x: number; y: number; zoom: number }) =>
    page.evaluate((v) => (window as unknown as { rulersHarness: Harness }).rulersHarness.viewport(v), viewport)
  const settled = () => new Promise((resolve) => setTimeout(resolve, SETTLED_MS))

  /** how far each edge of a frame's surface is from a device pixel, at most */
  const offGrid = (name: string) =>
    page.$eval(`iframe[title="${name}"]`, (iframe) => {
      const box = iframe.closest('[data-frame-surface]')!.getBoundingClientRect()
      const dpr = window.devicePixelRatio
      return Math.max(
        ...[box.left, box.top, box.right, box.bottom].map((edge) => Math.abs(edge * dpr - Math.round(edge * dpr))),
      )
    })

  async function open(deviceScaleFactor: number) {
    await page?.close()
    page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor })
    await page.goto(fixtureUrl('rulers.html'))
    await page.waitForFunction(() => !!(window as unknown as { rulersHarness?: unknown }).rulersHarness)
    await page.evaluate(
      (frames) =>
        (window as unknown as { rulersHarness: Harness }).rulersHarness.seed({
          id: 'c',
          name: 'Snap',
          frames,
          pages: [{ id: 'first', name: 'Main' }],
          createdAt: 0,
          updatedAt: 0,
        }),
      FRAMES,
    )
    await page.waitForSelector('iframe[title="turned"]')
  }

  beforeAll(async () => {
    browser = await openBrowser()
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  for (const dpr of [1, 2])
    it(`puts every upright frame on whole device pixels at ${dpr}x`, async () => {
      await open(dpr)
      const worst: Record<string, number> = {}
      for (const zoom of ZOOMS) {
        await camera({ x: 140.37, y: 96.62, zoom })
        await settled()
        /* as the settle left it: a new layout zoom rewrites the world's
           transform, and must round the camera as every other write does */
        for (const name of ['plain', 'odd']) {
          const off = await offGrid(name)
          if (off > ON_GRID) worst[`${name} ${zoom} settled`] = off
        }
        for (const offset of OFFSETS) {
          /* a pan keeps the zoom, so it needs no settle: the camera itself
             moves in whole device pixels */
          await camera({ x: 140 + offset, y: 96 - offset, zoom })
          for (const name of ['plain', 'odd']) {
            const off = await offGrid(name)
            if (off > ON_GRID) worst[`${name} ${zoom} +${offset}`] = off
          }
        }
      }
      expect(worst).toEqual({})
    })

  it('drops the snaps while the camera zooms and restores them once it rests', async () => {
    await open(2)
    await camera({ x: 140.37, y: 96.62, zoom: 0.4653 })
    await settled()
    const snap = () =>
      page.$eval('iframe[title="plain"]', (iframe) => {
        const surface = iframe.closest<HTMLElement>('[data-frame-surface]')!
        return {
          transform: getComputedStyle(surface).transform,
          overscan: getComputedStyle(iframe).transform,
          zooming: 'zooming' in surface.closest<HTMLElement>('.world')!.dataset,
        }
      })
    expect(await snap()).toMatchObject({ zooming: false })
    expect((await snap()).transform).not.toBe('none')
    expect((await snap()).overscan).not.toBe('none')

    await camera({ x: 140.37, y: 96.62, zoom: 0.52 })
    expect(await snap()).toEqual({ transform: 'none', overscan: 'none', zooming: true })

    await settled()
    expect(await snap()).toMatchObject({ zooming: false })
    expect(await offGrid('plain')).toBeLessThan(ON_GRID)
  })

  it('reaches the iframe under a device pixel past its surface, right and bottom only', async () => {
    await open(2)
    await camera({ x: 140.37, y: 96.62, zoom: 0.4653 })
    await settled()
    const past = await page.$eval('iframe[title="plain"]', (iframe) => {
      const inner = iframe.getBoundingClientRect()
      const outer = iframe.closest('[data-frame-surface]')!.getBoundingClientRect()
      const dpr = window.devicePixelRatio
      return {
        left: (outer.left - inner.left) * dpr,
        top: (outer.top - inner.top) * dpr,
        right: (inner.right - outer.right) * dpr,
        bottom: (inner.bottom - outer.bottom) * dpr,
      }
    })
    expect(Math.abs(past.left)).toBeLessThan(ON_GRID)
    expect(Math.abs(past.top)).toBeLessThan(ON_GRID)
    for (const reach of [past.right, past.bottom]) {
      expect(reach).toBeGreaterThan(0.5)
      expect(reach).toBeLessThan(1)
    }
  })

  it('leaves a turned frame as it is', async () => {
    await open(2)
    await camera({ x: -600.37, y: 96.62, zoom: 0.4653 })
    await settled()
    const transform = await page.$eval(
      'iframe[title="turned"]',
      (iframe) => getComputedStyle(iframe.closest('[data-frame-surface]')!).transform,
    )
    expect(transform).toBe('none')
  })
})
