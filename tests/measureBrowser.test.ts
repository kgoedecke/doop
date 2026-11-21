import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

const BOXES = `<!doctype html><html><head><style>
  body { margin: 0 }
  div { position: absolute; background: #ddd }
  #a { left: 30px; top: 40px; width: 100px; height: 50px }
  #b { left: 190px; top: 40px; width: 60px; height: 50px }
</style></head><body><div id="a"></div><div id="b"></div></body></html>`

/* ⌥ held with something selected shows the distances to what the pointer is over */
describe.skipIf(!findBrowserPath())('⌥ distances', () => {
  const pages = pagePerTest()
  let page: Page
  const LEFT = { ...canvasFrame({ id: 'left', name: 'Left', x: 0, y: 0, width: 300, height: 200 }), html: BOXES }
  const RIGHT = canvasFrame({ id: 'right', name: 'Right', x: 420, y: 50, width: 200, height: 100 })

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1600, height: 1000 })
    await openCanvasPage(page, [LEFT, RIGHT])
  })

  /** a design point of a frame, on screen */
  async function pointIn(frame: 0 | 1, x: number, y: number) {
    return page.evaluate(
      (frame, x, y) => {
        const surface = document.querySelectorAll('[data-frame-surface]')[frame]!
        const r = surface.getBoundingClientRect()
        const scale = r.width / (surface as HTMLElement).offsetWidth
        return { x: r.left + x * scale, y: r.top + y * scale }
      },
      frame,
      x,
      y,
    )
  }
  async function moveTo(frame: 0 | 1, x: number, y: number) {
    const at = await pointIn(frame, x, y)
    await page.mouse.move(at.x, at.y, { steps: 3 })
  }
  async function distances() {
    return page.$$eval('[data-measure-distance]', (labels) =>
      labels.map((el) => `${el.getAttribute('data-measure-distance')}:${el.textContent}`),
    )
  }

  it('measures the gap from the selected frame to the one under the pointer', async () => {
    await page.click('[data-frame-title]')
    await moveTo(1, 100, 50)
    expect(await distances()).toEqual([])
    await page.keyboard.down('Alt')
    await expect.poll(distances).toEqual(['x:120'])
    /* nothing to measure to over the selection itself */
    await moveTo(0, 280, 180)
    await expect.poll(distances).toEqual([])
    await moveTo(1, 100, 50)
    await expect.poll(distances).toEqual(['x:120'])
    await page.keyboard.up('Alt')
    await expect.poll(distances).toEqual([])
  })

  it('measures a picked element to its sibling, and to the frame from the element itself', async () => {
    const a = await pointIn(0, 80, 65)
    await page.mouse.click(a.x, a.y)
    await page.waitForSelector('[data-element-outline]')
    await page.keyboard.down('Alt')
    await moveTo(0, 220, 65)
    await expect.poll(distances).toEqual(['x:60'])
    await moveTo(0, 80, 65)
    await expect.poll(distances).toEqual(['x:30', 'x:170', 'y:40', 'y:110'])
    /* both picked: one box, measured to the frame even from the other's place */
    const b = await pointIn(0, 220, 65)
    await page.keyboard.up('Alt')
    await page.keyboard.down('Shift')
    await page.mouse.click(b.x, b.y)
    await page.keyboard.up('Shift')
    await page.waitForSelector('[data-picked-element]')
    await page.keyboard.down('Alt')
    await moveTo(0, 221, 66)
    await expect.poll(distances).toEqual(['x:30', 'x:50', 'y:40', 'y:110'])
    /* over another frame the frames are measured */
    await moveTo(1, 100, 50)
    await expect.poll(distances).toEqual(['x:120'])
    await moveTo(0, 80, 65)
    /* a drag owns ⌥ */
    await page.mouse.down()
    await expect.poll(distances).toEqual([])
    await page.mouse.up()
    await page.keyboard.up('Alt')
  })
})
