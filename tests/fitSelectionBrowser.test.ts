import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import { canvasFrame, prepareCanvasPage, showCanvasPage } from './canvasPageFixture'

/* ⇧2 fits the selection into the part of the stage the panels leave open,
   not the whole window under them */
describe.skipIf(!findBrowserPath())('zoom to selection with the panels open', () => {
  const pages = pagePerTest()
  let page: Page
  const WIDE = canvasFrame({ id: 'wide', name: 'Wide', x: 0, y: 0, width: 1440, height: 900 })
  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1600, height: 1000 })
    await prepareCanvasPage(page)
    /* localStorage belongs to the file's browser context, and the docked
       tests leave their layout in it; it is cleared on the fixture's origin
       before the page that reads it loads */
    await page.goto(fixtureUrl('canvasPage.html'))
    await page.evaluate(() => localStorage.removeItem('doop:panel-layout'))
    await showCanvasPage(page, [WIDE])
  })

  /** the open stage: right of the tool rail (which follows the Layers
   *  panel), left of the islands (which follow the Inspector and Agents) */
  async function openArea() {
    return page.evaluate(() => ({
      left: document.querySelector('[aria-label="Canvas tools"]')!.getBoundingClientRect().right,
      right: document.querySelector('[aria-label="Account"]')!.getBoundingClientRect().left,
    }))
  }

  /** select the frame with the Inspector and Agents open, press ⇧2 and
   *  return where the frame landed */
  async function fitWithPanelsOpen() {
    /* a title click selects the frame and opens the Inspector */
    await page.click('[data-frame-title]')
    if (await page.$('[aria-label^="Agents"]')) await page.click('[aria-label^="Agents"]')
    await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Resize"]').length >= 2)
    await page.keyboard.down('Shift')
    await page.keyboard.press('Digit2')
    await page.keyboard.up('Shift')
    await new Promise((r) => setTimeout(r, 300))
    return page.$eval('[data-frame-surface]', (el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right }
    })
  }

  it('keeps the fitted frame clear of the side panels and centred between them', async () => {
    const frame = await fitWithPanelsOpen()
    const area = await openArea()
    expect(frame.left).toBeGreaterThan(area.left)
    expect(frame.right).toBeLessThan(area.right)
    expect(Math.abs((frame.left + frame.right) / 2 - (area.left + area.right) / 2)).toBeLessThan(40)
  })

  it('fits a linked frame beside the Inspector the link opens', async () => {
    await showCanvasPage(page, [WIDE], '?frame=wide')
    await page.waitForSelector('[aria-label="Account"]')
    /* the link opens the Inspector, whose header offers to close it */
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="panel"]').length >= 2)
    await new Promise((r) => setTimeout(r, 300))
    const frame = await page.$eval('[data-frame-surface]', (el) => el.getBoundingClientRect().right)
    const area = await openArea()
    expect(frame).toBeLessThan(area.right)
  })

  it('docked: the stage fills the gap between the columns and fits there', async () => {
    await page.evaluate(() => localStorage.setItem('doop:panel-layout', 'docked'))
    await showCanvasPage(page, [WIDE])
    const frame = await fitWithPanelsOpen()
    const area = await openArea()
    const stage = await page.$eval('.stage', (el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top }
    })
    /* the columns butt against the stage on both sides, under the 44px bar */
    expect(Math.abs(stage.left - area.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(stage.right - area.right)).toBeLessThanOrEqual(1)
    expect(stage.top).toBe(44)
    expect(frame.left).toBeGreaterThan(stage.left)
    expect(frame.right).toBeLessThan(stage.right)
    expect(Math.abs((frame.left + frame.right) / 2 - (stage.left + stage.right) / 2)).toBeLessThan(2)
  })

  it('docked: fits a linked frame inside the stage the Inspector narrows', async () => {
    await page.evaluate(() => localStorage.setItem('doop:panel-layout', 'docked'))
    await showCanvasPage(page, [WIDE], '?frame=wide')
    await page.waitForSelector('[aria-label="Account"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="panel"]').length >= 2)
    await new Promise((r) => setTimeout(r, 300))
    const frame = await page.$eval('[data-frame-surface]', (el) => el.getBoundingClientRect().right)
    const stage = await page.$eval('.stage', (el) => el.getBoundingClientRect().right)
    expect(frame).toBeLessThan(stage)
  })
})
