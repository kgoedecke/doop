import type { Page } from 'puppeteer-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { LAYERS_MIN_PX, PAGES_MIN_PX } from '../src/lib/pagesSplit'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage, showCanvasPage } from './canvasPageFixture'

/* enough pages to reach the Pages list's 30vh cap in an 800px window */
const PAGES = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `Page ${i + 1}` }))
const FRAMES = [canvasFrame({ id: 'f1', name: 'Home', x: 0, y: 0, width: 100, height: 100 })]

describe.skipIf(!findBrowserPath())('the Pages and Layers split', () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1280, height: 800 })
    await openCanvasPage(page, FRAMES, '', PAGES)
  })

  /** the Pages section, the Layers tree and the rail they share, in px */
  const sizes = () =>
    page.evaluate(() => {
      const pagesEl = document.querySelector<HTMLElement>('[data-slot="pages-panel"]')!
      const rail = pagesEl.closest<HTMLElement>('[data-slot="panel"]')!
      const tree = rail.querySelector<HTMLElement>('[role="tree"]')!
      return {
        pages: pagesEl.getBoundingClientRect().height,
        tree: tree.getBoundingClientRect().height,
        rail: rail.getBoundingClientRect().height,
      }
    })

  /** press the split and drag it `dy` px, in steps the way a hand moves */
  async function dragSplit(dy: number) {
    const box = await (await page.$('[data-slot="pages-split"]'))!.boundingBox()
    const x = box!.x + box!.width / 2
    const y = box!.y + box!.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + dy, { steps: 8 })
    await page.mouse.up()
  }

  it('dragging the split up gives the Layers tree the room the Pages list gives up', async () => {
    const before = await sizes()
    await dragSplit(-120)
    const after = await sizes()
    expect(before.pages - after.pages).toBeCloseTo(120, 0)
    expect(after.tree - before.tree).toBeCloseTo(120, 0)
  })

  it('stops the split where the Layers tree keeps its minimum room', async () => {
    await dragSplit(2000)
    const { pages: pagesPx, rail } = await sizes()
    expect(pagesPx).toBeCloseTo(rail - LAYERS_MIN_PX, 0)
  })

  it('moves the split 10px an arrow press, and Home and End take it to its limits', async () => {
    const start = await sizes()
    await (await page.$('[data-slot="pages-split"]'))!.focus()
    await page.keyboard.press('ArrowUp')
    expect((await sizes()).pages).toBeCloseTo(start.pages - 10, 0)
    await page.keyboard.press('Home')
    expect((await sizes()).pages).toBeCloseTo(PAGES_MIN_PX, 0)
    await page.keyboard.press('End')
    const end = await sizes()
    expect(end.pages).toBeCloseTo(end.rail - LAYERS_MIN_PX, 0)
  })

  it('keeps the split when the page loads again', async () => {
    await dragSplit(-120)
    const dragged = await sizes()
    await showCanvasPage(page, FRAMES, '', PAGES)
    expect((await sizes()).pages).toBeCloseTo(dragged.pages, 0)
  })

  it('keeps one page row and the move picker inside the Pages section while a frame is selected', async () => {
    await page.click('[role="treeitem"][data-row-key="f1"]')
    await page.waitForSelector('[data-slot="pages-panel"] [data-slot="select-trigger"]')
    await (await page.$('[data-slot="pages-split"]'))!.focus()
    await page.keyboard.press('Home')
    const fit = await page.evaluate(() => {
      const edges = (el: Element) => {
        const { top, bottom, height } = el.getBoundingClientRect()
        return { top, bottom, height }
      }
      const pagesEl = document.querySelector('[data-slot="pages-panel"]')!
      const row = pagesEl.querySelector('[data-page-id]')!
      return {
        pages: edges(pagesEl),
        list: edges(row.parentElement!),
        row: edges(row),
        picker: edges(pagesEl.querySelector('[data-slot="select-trigger"]')!),
      }
    })
    expect(fit.row.bottom).toBeLessThanOrEqual(fit.list.bottom + 0.5)
    expect(fit.picker.bottom).toBeLessThanOrEqual(fit.pages.bottom + 0.5)
  })
})
