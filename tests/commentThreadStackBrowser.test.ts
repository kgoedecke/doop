import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { ElementComment, Frame } from '../shared/types'

/* An open comment thread paints above every frame on the page, also when its
   own frame is not selected and a frame in front overlaps where it opens. */

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

  async function seed(rotation?: number) {
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
      COMMENT,
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

  it('opens above a frame in front of its own', async () => {
    await seed()
    await expectThreadOnTop()
  })

  it('opens above a frame in front of its own when that frame is turned', async () => {
    await seed(4)
    await expectThreadOnTop()
  })
})
