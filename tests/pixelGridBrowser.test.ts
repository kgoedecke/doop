import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { ElementComment, Frame } from '../shared/types'

/* The fixture's stage starts 40px down the page. At 800% the grid is fully on. */
const STAGE_TOP = 40
const CAMERA = { x: 40, y: 40, zoom: 8 }
const screen = (x: number, y: number): [number, number] => [
  CAMERA.x + x * CAMERA.zoom,
  STAGE_TOP + CAMERA.y + y * CAMERA.zoom,
]

const FRAME: Frame = {
  id: 'f',
  canvasId: 'c',
  pageId: 'first',
  name: 'Card',
  x: 0,
  y: 0,
  width: 40,
  height: 40,
  html: '<!doctype html><html><body style="margin:0;background:#eee"></body></html>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
}

const comment = (id: string, at: Partial<ElementComment>): ElementComment => ({
  id,
  canvasId: 'c',
  snippet: '',
  from: 'Tester',
  text: id,
  at: 0,
  ...at,
})

const COMMENTS = [
  comment('on-paper', { pageId: 'first', x: 80, y: 10 }),
  comment('on-frame', { frameId: 'f', x: 10, y: 10 }),
]

/** What paints at a screen point, topmost first, counting the pixel grids,
 *  which never take the pointer and so are lifted into hit testing here. */
function stackAt(page: Page, [x, y]: [number, number]) {
  return page.evaluate(
    (x, y) => {
      const grids = [...document.querySelectorAll<HTMLElement>('[data-pixel-grid]')]
      for (const g of grids) g.style.pointerEvents = 'auto'
      const hits = document.elementsFromPoint(x, y)
      for (const g of grids) g.style.pointerEvents = ''
      return hits.map((el) =>
        el.hasAttribute('data-pixel-grid')
          ? `grid:${el.getAttribute('data-pixel-grid')}`
          : el.closest('[title]')?.getAttribute('title')?.startsWith('Tester:')
            ? 'pin'
            : el.tagName === 'IFRAME'
              ? 'iframe'
              : 'other',
      )
    },
    x,
    y,
  )
}

describe.skipIf(!findBrowserPath())('pixel grid', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  const errors: string[] = []

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (err) => errors.push(String(err)))
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(fixtureUrl('rulers.html'))
    await page.waitForFunction(() => !!window.rulersHarness)
    await page.evaluate(
      (f, comments) => {
        window.rulersHarness.seed({
          id: 'c',
          name: 'Grid',
          frames: [f],
          pages: [{ id: 'first', name: 'Main' }],
          createdAt: 0,
          updatedAt: 0,
        })
        window.rulersHarness.comments(comments)
      },
      FRAME,
      COMMENTS,
    )
    await page.waitForSelector('[aria-label="Canvas tools"]')
    await page.evaluate((vp) => window.rulersHarness.viewport(vp), CAMERA)
    await page.waitForSelector('[data-pixel-grid="paper"]:not([hidden])')
    /* the pins pop in; their resting box is the one to hit */
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished),
      ),
    )
  })

  afterAll(() => {
    expect(errors).toEqual([])
  })

  it('draws over the paper and a frame’s document', async () => {
    expect(await stackAt(page, screen(60, 30))).toContain('grid:paper')
    const inFrame = await stackAt(page, screen(30, 30))
    expect(inFrame.indexOf('grid:frame')).toBeGreaterThanOrEqual(0)
    expect(inFrame.indexOf('grid:frame')).toBeLessThan(inFrame.indexOf('iframe'))
    /* the paper's grid is under the frame, which covers it */
    expect(inFrame.indexOf('iframe')).toBeLessThan(inFrame.indexOf('grid:paper'))
    expect(await page.$eval('[data-pixel-grid="frame"]', (el) => getComputedStyle(el).opacity)).toBe('1')
  })

  it('keeps comment pins on the paper and on a frame above the grid', async () => {
    for (const [x, y] of [
      [80, 10],
      [10, 10],
    ] as const) {
      /* the pin is centred on its point */
      const stack = await stackAt(page, screen(x, y))
      expect(stack[0]).toBe('pin')
      const grid = stack.findIndex((s) => s.startsWith('grid:'))
      expect(grid).toBeGreaterThan(0)
    }
  })

  it("goes away with ⇧' and comes back, frames included", async () => {
    const frameOpacity = () => page.$eval('[data-pixel-grid="frame"]', (el) => getComputedStyle(el).opacity)
    const toggle = async () => {
      await page.keyboard.down('Shift')
      await page.keyboard.press('Quote')
      await page.keyboard.up('Shift')
    }
    await toggle()
    await page.waitForSelector('[data-pixel-grid="paper"][hidden]')
    expect(await frameOpacity()).toBe('0')
    await toggle()
    await page.waitForSelector('[data-pixel-grid="paper"]:not([hidden])')
    expect(await frameOpacity()).toBe('1')
  })

  it('fades out with the zoom', async () => {
    await page.evaluate(() => window.rulersHarness.viewport({ x: 40, y: 40, zoom: 2 }))
    await page.waitForSelector('[data-pixel-grid="paper"][hidden]')
    expect(await page.$eval('[data-pixel-grid="frame"]', (el) => getComputedStyle(el).opacity)).toBe('0')
  })
})
