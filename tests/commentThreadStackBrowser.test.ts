import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { ElementComment, Frame } from '../shared/types'

/* An open comment thread paints above every frame on the page and above any
   frame's size badge, also when its own frame is not selected and a frame in
   front overlaps where it opens. It stays on its pin while the camera pans and
   zooms, as Figma's does. */

const frame = (id: string, x: number, createdAt: number, rotation?: number): Frame => ({
  id,
  canvasId: 'c',
  pageId: 'first',
  name: id,
  x,
  y: 0,
  width: 200,
  height: 300,
  html: '<!doctype html><html><body style="margin:0;background:#eee"></body></html>',
  createdAt,
  updatedAt: createdAt,
  updatedBy: 'Tester',
  ...(rotation ? { rotation } : {}),
})

/* `front` is made later, so it stacks over `back`'s right half */
const frames = (rotation?: number) => [frame('back', 0, 0, rotation), frame('front', 120, 1)]

const COMMENT: ElementComment = {
  id: 'thread',
  canvasId: 'c',
  frameId: 'back',
  x: 90,
  y: 20,
  snippet: '',
  from: 'Tester',
  text: 'Behind?',
  at: 0,
}

describe.skipIf(!findBrowserPath())('comment thread stacking', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  const errors: string[] = []

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (err) => errors.push(String(err)))
    await page.setViewport({ width: 1200, height: 800 })
  })

  async function seed(rotation?: number, comment: ElementComment = COMMENT) {
    await page.goto(fixtureUrl('rulers.html'))
    await page.waitForFunction(() => !!window.rulersHarness)
    await page.evaluate(
      (frames, c) => {
        window.rulersHarness.seed({
          id: 'c',
          name: 'Stack',
          frames,
          pages: [{ id: 'first', name: 'Main' }],
          createdAt: 0,
          updatedAt: 0,
        })
        window.rulersHarness.comments([c])
      },
      frames(rotation),
      comment,
    )
    await page.waitForSelector('[aria-label="Canvas tools"]')
    await page.evaluate(() => window.rulersHarness.viewport({ x: 40, y: 40, zoom: 1 }))
  }

  afterAll(() => {
    expect(errors).toEqual([])
  })

  async function expectThreadOnTop() {
    const pin = await page.waitForSelector('[title^="Tester:"]')
    await pin!.click()
    const popover = await page.waitForSelector('[data-comment-popover]')
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished),
      ),
    )
    const box = (await popover!.boundingBox())!
    /* a point of the popover over the front frame, whose document is there too */
    const x = box.x + box.width - 20
    const y = box.y + box.height / 2
    const stack = await page.evaluate(
      (x, y) =>
        document
          .elementsFromPoint(x, y)
          .map((el) =>
            el.closest('[data-comment-popover]')
              ? 'popover'
              : el.tagName === 'IFRAME'
                ? el.getAttribute('title')
                : null,
          )
          .filter(Boolean),
      x,
      y,
    )
    expect(stack).toContain('front')
    expect(stack[0]).toBe('popover')
  }

  /* where the open thread sits relative to its pin */
  async function offsetFromPin() {
    const pin = (await (await page.$('[title^="Tester:"]'))!.boundingBox())!
    const popover = (await (await page.$('[data-comment-popover]'))!.boundingBox())!
    return { x: Math.round(popover.x - pin.x), y: Math.round(popover.y - pin.y) }
  }

  it('stays on its pin while the camera zooms and pans', async () => {
    await seed()
    await (await page.waitForSelector('[title^="Tester:"]'))!.click()
    await page.waitForSelector('[data-comment-popover]')
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
    const before = await offsetFromPin()
    for (const viewport of [
      { x: 40, y: 40, zoom: 2.5 },
      { x: -120, y: 10, zoom: 0.4 },
      { x: 100, y: 10, zoom: 1.3 },
    ]) {
      await page.evaluate((viewport) => window.rulersHarness.viewport(viewport), viewport)
      expect(await offsetFromPin()).toEqual(before)
    }
  })

  it("paints above another frame's size badge", async () => {
    /* the pin sits by back's bottom edge, so the thread hangs over the badge
       under front, which is selected */
    await seed(undefined, { ...COMMENT, x: 100, y: 285 })
    await page.evaluate(() => window.rulersHarness.select(['front']))
    const badge = (await (await page.waitForSelector('[data-frame-size]'))!.boundingBox())!
    await (await page.waitForSelector('[title^="Tester:"]'))!.click()
    const popover = (await (await page.waitForSelector('[data-comment-popover]'))!.boundingBox())!
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
    const left = Math.max(badge.x, popover.x)
    const right = Math.min(badge.x + badge.width, popover.x + popover.width)
    const top = Math.max(badge.y, popover.y)
    const bottom = Math.min(badge.y + badge.height, popover.y + popover.height)
    expect(right > left && bottom > top).toBe(true)
    const stack = await page.evaluate(
      (x, y) => {
        /* the badge takes no pointer events, which hit testing would skip */
        document.querySelector<HTMLElement>('[data-frame-size]')!.style.pointerEvents = 'auto'
        return document
          .elementsFromPoint(x, y)
          .map((el) =>
            el.closest('[data-comment-popover]') ? 'popover' : el.closest('[data-frame-size]') ? 'badge' : null,
          )
          .filter(Boolean)
      },
      (left + right) / 2,
      (top + bottom) / 2,
    )
    expect(stack[0]).toBe('popover')
  })

  it('opens above a frame in front of its own', async () => {
    await seed()
    await expectThreadOnTop()
  })

  it('opens above a frame in front of its own when that frame is turned', async () => {
    await seed(4)
    await expectThreadOnTop()
  })
})
