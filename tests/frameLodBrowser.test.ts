import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { Frame } from '../shared/types'

describe.skipIf(!findBrowserPath())('frames drawn as images', () => {
  let browser: TestBrowser
  let page: Page
  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    await page.setViewport({ width: 1000, height: 900 })
    await page.goto(fixtureUrl('elementContextMenu.html'))
    await page.waitForFunction(() => !!window.contextMenuHarness?.drawAsImage)
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  it('selects the frame on a surface click and brings its document in', async () => {
    const frame: Frame = {
      id: 'f',
      canvasId: 'c',
      name: 'Image',
      x: 40,
      y: 60,
      width: 600,
      height: 400,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
      html: '<!doctype html><html><body><p id="target">Pick me</p></body></html>',
    }
    await page.evaluate((f) => {
      window.contextMenuHarness.seed([f])
      window.contextMenuHarness.drawAsImage(true)
    }, frame)
    await page.waitForSelector('img[src^="/i/f.jpg"]')
    expect(await page.$('iframe')).toBeNull()

    /* the element-move path waits for a document an image does not have,
       and gave up after two seconds with nothing selected */
    await page.mouse.click(frame.x + 300, frame.y + 200)
    await page.waitForFunction(() => window.contextMenuHarness.selectedIds().includes('f'), { timeout: 1_000 })
    const document = (await (await page.waitForSelector('iframe'))!.contentFrame())!
    await document.waitForSelector('#target')
  })
})
