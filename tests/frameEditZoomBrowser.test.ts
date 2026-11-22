import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage, showCanvasPage } from './canvasPageFixture'

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

  /** the frame's live document, once it is in text editing */
  async function editingFrame() {
    for (let i = 0; i < 100; i++) {
      for (const f of page.frames()) {
        if (f === page.mainFrame() || f.detached) continue
        if (await f.$('style[data-v-edit]').catch(() => null)) return f
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('the frame never entered text editing')
  }

  /** select the frame by its title, then double-click its text into editing;
   *  returns the screen point clicked, inside the text near its start */
  async function editText(rotation = 0) {
    await page.click('[data-frame-title]')
    const at = await textPoint(rotation)
    await page.mouse.click(at.x, at.y, { count: 2 })
    await editingFrame()
    return at
  }

  async function textPoint(rotation = 0) {
    /* a point in the text (design px 70, 62), turned with the frame about
       its centre; the zoom read off the turned box's width */
    const box = await page.$eval('[data-frame-surface]', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width }
    })
    const turn = (rotation * Math.PI) / 180
    const zoom = box.width / (600 * Math.abs(Math.cos(turn)) + 400 * Math.abs(Math.sin(turn)))
    const dx = (70 - 300) * zoom
    const dy = (62 - 200) * zoom
    const at = {
      x: box.x + dx * Math.cos(turn) - dy * Math.sin(turn),
      y: box.y + dx * Math.sin(turn) + dy * Math.cos(turn),
    }
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
    expect(await editingFrame()).toBeTruthy()
  })

  it('zooms as strongly over the edited frame as over the shield above 100%', async () => {
    /* two notches over the shield take the camera past 100%, where a frame's
       document takes the world's zoom as pixel density */
    const start = (await surface()).width
    /* about the text, so it and the frame's title stay in view */
    const shield = await textPoint()
    await wheelWith('Control', shield, -40)
    await wheelWith('Control', shield, -40)
    expect((await surface()).width / start).toBeGreaterThan(1.9)
    await new Promise((r) => setTimeout(r, 400))
    const at = await editText()
    const before = (await surface()).width
    await wheelWith('Control', at, -20)
    /* the stage's own mapping: exp(-deltaY / 100) */
    expect((await surface()).width / before).toBeCloseTo(Math.exp(0.2), 2)
  })

  it('zooms about the pointer on a rotated frame', async () => {
    await showCanvasPage(page, [{ ...TEXT, rotation: 30 }])
    const centre = () =>
      page.$eval('[data-frame-surface]', (el) => {
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width }
      })
    const at = await editText(30)
    const before = await centre()
    await wheelWith('Control', at, -100)
    const after = await centre()
    const scale = after.width / before.width
    expect(scale).toBeGreaterThan(1.3)
    /* zooming by s about the pointer p moves the frame's centre c to p + s(c - p) */
    expect(Math.abs(at.x + scale * (before.x - at.x) - after.x)).toBeLessThan(2)
    expect(Math.abs(at.y + scale * (before.y - at.y) - after.y)).toBeLessThan(2)
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
