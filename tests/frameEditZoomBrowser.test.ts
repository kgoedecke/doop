import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

/* While a frame's text is being edited the canvas lifts its shield, so a
   ⌘/Ctrl+wheel (a trackpad pinch) over the frame lands in the frame's own
   document. It still zooms the canvas, about the pointer, as it does over
   any other part of the board, rather than zooming the whole page. */
describe.skipIf(!findBrowserPath())('zooming over a frame being edited', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  const TEXT = canvasFrame({ id: 'text', name: 'Text', x: 0, y: 0, width: 600, height: 400 })
  TEXT.html = '<body style="margin:0"><p id="copy" style="font:32px/1.4 Arial;margin:40px">Edit me</p></body>'

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1400, height: 900 })
    await openCanvasPage(page, [TEXT])
  })

  const surface = () =>
    page.$eval('[data-frame-surface]', (el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width }
    })

  /** select the frame by its title, then double-click its text into editing */
  async function editText() {
    await page.click('[data-frame-title]')
    const box = await surface()
    const at = { x: box.left + 80 * (box.width / 600), y: box.top + 70 * (box.width / 600) }
    await page.mouse.click(at.x, at.y, { count: 2 })
    const frame = page.frames().find((f) => f !== page.mainFrame())!
    await frame.waitForSelector('style[data-v-edit]')
    return at
  }

  async function wheelWith(modifier: 'Control' | 'Meta', at: { x: number; y: number }, deltaY: number) {
    await page.mouse.move(at.x, at.y)
    await page.keyboard.down(modifier)
    await page.mouse.wheel({ deltaY })
    await page.keyboard.up(modifier)
    /* the stage flushes wheel deltas once per animation frame */
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  }

  it.each(['Control', 'Meta'] as const)('%s+wheel zooms the canvas about the pointer', async (modifier) => {
    const at = await editText()
    const before = await surface()
    /* the design point under the pointer, as a fraction of the frame */
    const fx = (at.x - before.left) / before.width
    await wheelWith(modifier, at, -100)
    const after = await surface()
    expect(after.width).toBeGreaterThan(before.width * 1.3)
    /* the same design point stays under the pointer */
    expect(Math.abs(after.left + fx * after.width - at.x)).toBeLessThan(2)
    /* the page itself never zoomed, and the text is still being edited */
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)
    const frame = page.frames().find((f) => f !== page.mainFrame())!
    expect(await frame.$('style[data-v-edit]')).not.toBeNull()
  })

  it('leaves a plain wheel to the frame being edited', async () => {
    const at = await editText()
    const before = await surface()
    await page.mouse.move(at.x, at.y)
    await page.mouse.wheel({ deltaY: 100 })
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    expect(await surface()).toEqual(before)
  })
})
