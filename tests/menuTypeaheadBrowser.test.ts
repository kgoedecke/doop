import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

/* With a context menu open the menu has the keyboard, as in Figma: a letter
   is its typeahead, moving to the item starting with it, and no tool key or
   command runs, ⌘ chords included. */
describe.skipIf(!findBrowserPath())('typing into an open context menu', () => {
  const pages = pagePerTest()
  let page: Page
  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1400, height: 900 })
    await openCanvasPage(page, [canvasFrame({ id: 'board', name: 'Board', x: 0, y: 0, width: 300, height: 200 })])
  })

  const pressedTool = () =>
    page.$$eval('button[aria-pressed="true"]', (nodes) => nodes.map((node) => node.getAttribute('aria-label')))
  const focusedItem = () => page.evaluate(() => document.activeElement?.textContent ?? '')

  /* the canvas below the frame, clear of the floating panels */
  async function openMenu() {
    const frame = await page.$eval('iframe[data-doop-frame]', (el) => el.getBoundingClientRect().toJSON())
    await page.mouse.click(frame.x + 20, frame.bottom + 60, { button: 'right' })
    await page.waitForSelector('[role="menu"]')
  }
  async function closeMenu() {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
  }
  const zoom = () => page.$eval('[aria-label="Zoom level"] span', (el) => el.textContent)

  it('selects the matching item and leaves the canvas shortcuts alone', { timeout: 20_000 }, async () => {
    await openMenu()
    /* R is the Rectangle tool, F the Frame tool */
    await page.keyboard.press('KeyR')
    await page.keyboard.press('KeyF')
    expect(await pressedTool()).toContain('Select')
    expect(await page.$('[role="menu"]')).not.toBeNull()
    await closeMenu()
    expect(await pressedTool()).toContain('Select')

    /* N, the next frame, is the menu's "New frame" */
    await openMenu()
    await page.keyboard.press('KeyN')
    expect(await focusedItem()).toContain('New frame')
    await closeMenu()

    await page.keyboard.press('KeyR')
    expect(await pressedTool()).toContain('Rectangle')
  })

  it('runs no chord while the menu is open, as Figma does', { timeout: 20_000 }, async () => {
    const before = await zoom()
    await openMenu()
    await page.keyboard.down('Meta')
    await page.keyboard.press('Equal')
    await page.keyboard.up('Meta')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await zoom()).toBe(before)
    await closeMenu()

    /* the same chord zooms once the menu is gone */
    await page.keyboard.down('Meta')
    await page.keyboard.press('Equal')
    await page.keyboard.up('Meta')
    await page.waitForFunction(
      (was) => document.querySelector('[aria-label="Zoom level"] span')?.textContent !== was,
      {},
      before,
    )
  })
})
