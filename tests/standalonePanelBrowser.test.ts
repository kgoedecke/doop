import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

const shape = (id: string, x: number, width: number, color: string) => ({
  ...canvasFrame({ id, name: id, x, y: 40, width, height: 80 }),
  html: `<!doctype html><html style="width:100%;height:100%;margin:0"><body data-doop-canvas-element="true" style="width:100%;height:100%;margin:0"><div data-doop-drawing="rect" data-name="${id}" style="position:absolute;inset:0;background:${color}"></div></body></html>`,
})

/* Standalone shapes sit at the Layers root, each the one layer of a frame of
   its own; picking the next one while the element panel is up swaps the
   panel to it, never closing it for the beat the click's probe takes. */
describe.skipIf(!findBrowserPath())('element panel across standalone shapes', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1600, height: 900 })
  })

  async function clickShape(id: string) {
    const box = await page.$eval(`iframe[title="${id}"]`, (el) => {
      const rect = el.getBoundingClientRect()
      /* near the left edge: the element panel floats over the stage's right side */
      return { x: rect.x + 12, y: rect.y + rect.height / 2 }
    })
    await page.mouse.click(box.x, box.y)
  }

  it('keeps the panel up while the next shape is picked', async () => {
    // an ordinary frame too: the fixture waits for a frame title, which a shape has none of
    const board = canvasFrame({ id: 'board', name: 'Board', x: 0, y: 300, width: 200, height: 120 })
    await openCanvasPage(page, [board, shape('one', 0, 120, '#e33'), shape('two', 150, 160, '#33e')])
    await page.waitForSelector('iframe[title="two"]')
    await clickShape('one')
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === '120')
    await page.evaluate(() => {
      Object.assign(window, { panelGone: false })
      new MutationObserver(() => {
        if (!document.querySelector('[aria-label="Width"]')) Object.assign(window, { panelGone: true })
      }).observe(document.body, { childList: true, subtree: true })
    })
    await clickShape('two')
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === '160')
    // the probe that follows the click lands after its double-click wait
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(await page.evaluate(() => (window as unknown as { panelGone: boolean }).panelGone)).toBe(false)
    expect(await page.$('[aria-label="Width"]')).not.toBeNull()
  })
})
