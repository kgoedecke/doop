import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ElementHandle, KeyInput, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { ElementComment, Frame } from '../shared/types'

/* The wheel over an open comment thread scrolls the thread, not the canvas:
   the Stage pans on every other wheel turn, so it has to leave the ones over a
   box that scrolls to the browser, and keep the turns past that box's end from
   panning. ⌘/Ctrl+wheel still zooms the canvas there. */

const FRAME: Frame = {
  id: 'f',
  canvasId: 'c',
  pageId: 'first',
  name: 'Card',
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  html: '<!doctype html><html><body style="margin:0;background:#eee"></body></html>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
}

const ROOT: ElementComment = {
  id: 'root',
  canvasId: 'c',
  frameId: 'f',
  x: 40,
  y: 20,
  snippet: '',
  from: 'Tester',
  text: 'Can we tighten this?',
  at: 0,
}

/* enough replies that the thread's list is much taller than its 240px */
const THREAD: ElementComment[] = [
  ROOT,
  ...Array.from({ length: 12 }, (_, i) => ({
    ...ROOT,
    id: `reply-${i}`,
    parentId: ROOT.id,
    text: `Reply ${i}: a longer note that wraps onto a second line in the thread.`,
    at: i + 1,
  })),
]

const CAMERA = { x: 40, y: 40, zoom: 1 }

describe.skipIf(!findBrowserPath())('wheel over a comment thread', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  const errors: string[] = []

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (err) => errors.push(String(err)))
    await page.setViewport({ width: 1200, height: 800 })
  })

  afterAll(() => {
    expect(errors).toEqual([])
  })

  /** Opens the thread and answers its scrolling list, scrolled to the newest message. */
  async function openThread(): Promise<ElementHandle<HTMLElement>> {
    await page.goto(fixtureUrl('rulers.html'))
    await page.waitForFunction(() => !!window.rulersHarness)
    await page.evaluate(
      (frame, comments) => {
        window.rulersHarness.seed({
          id: 'c',
          name: 'Wheel',
          frames: [frame],
          pages: [{ id: 'first', name: 'Main' }],
          createdAt: 0,
          updatedAt: 0,
        })
        window.rulersHarness.comments(comments)
      },
      FRAME,
      THREAD,
    )
    await page.waitForSelector('[aria-label="Canvas tools"]')
    await page.evaluate((camera) => window.rulersHarness.viewport(camera), CAMERA)
    await (await page.waitForSelector('[title^="Tester:"]'))!.click()
    await page.waitForSelector('[data-comment-popover]')
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
    const list = await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLElement>('[data-comment-popover] *')].find(
        (el) => el.scrollHeight > el.clientHeight + 100 && el.scrollTop > 0,
      ),
    )
    return list as ElementHandle<HTMLElement>
  }

  const camera = () => page.evaluate(() => window.rulersHarness.state().viewport)
  const scrollTop = (list: ElementHandle<HTMLElement>) => list.evaluate((el) => el.scrollTop)

  /* the Stage flushes its pan once per animation frame */
  const settle = () =>
    page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))

  async function wheelOver(handle: ElementHandle, deltaY: number, modifier?: KeyInput, deltaX = 0) {
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    if (modifier) await page.keyboard.down(modifier)
    await page.mouse.wheel({ deltaX, deltaY })
    if (modifier) await page.keyboard.up(modifier)
    await settle()
  }

  it('scrolls the thread and leaves the canvas where it was', async () => {
    const list = await openThread()
    const before = await scrollTop(list)
    await wheelOver(list, -150)
    await page.waitForFunction((el, top) => el.scrollTop < top, {}, list, before)
    expect(await camera()).toEqual(CAMERA)
  })

  /* a trackpad turn is often diagonal, and mostly sideways here, where the
     thread cannot scroll: its vertical part still belongs to the thread */
  it('scrolls the thread on a diagonal turn, not the canvas', async () => {
    const list = await openThread()
    const before = await scrollTop(list)
    await wheelOver(list, -60, undefined, 120)
    await page.waitForFunction((el, top) => el.scrollTop < top, {}, list, before)
    expect(await camera()).toEqual(CAMERA)
  })

  it('keeps the turns past the top of the thread from panning the canvas', async () => {
    const list = await openThread()
    await list.evaluate((el) => el.scrollTo({ top: 0 }))
    await wheelOver(list, -150)
    expect(await scrollTop(list)).toBe(0)
    expect(await camera()).toEqual(CAMERA)
  })

  it('still pans the canvas from its empty paper', async () => {
    await openThread()
    const stage = (await page.$('.stage'))!
    const box = (await stage.boundingBox())!
    await page.mouse.move(box.x + box.width - 60, box.y + box.height - 60)
    await page.mouse.wheel({ deltaY: 150 })
    await settle()
    expect(await camera()).toEqual({ ...CAMERA, y: CAMERA.y - 150 })
  })

  it('zooms the canvas on Ctrl+wheel over the thread', async () => {
    const list = await openThread()
    const before = await scrollTop(list)
    await wheelOver(list, -40, 'Control')
    expect((await camera()).zoom).toBeGreaterThan(CAMERA.zoom)
    expect(await scrollTop(list)).toBe(before)
  })
})
