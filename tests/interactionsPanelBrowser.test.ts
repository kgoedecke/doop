import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import type { Frame } from '../shared/types'

/* the part of tests/fixtures/elementPanel.html's harness this suite drives */
type Harness = {
  elementPanelHarness: {
    seed: (frame: Frame) => void
    select: (selector: string) => void
    undo: () => Promise<void>
  }
}

/* The Prototype tab of the element panel writes interactions into the frame
   HTML through the ordinary save path, one undo step per change. */
describe.skipIf(!findBrowserPath())('interactions panel', { timeout: 30_000 }, () => {
  let vite: ViteDevServer
  let browser: Browser
  let page: Page
  let saved: Frame

  beforeAll(async () => {
    vite = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await vite.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(8_000)
    await page.setViewport({ width: 1000, height: 800 })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      if (new URL(request.url()).pathname === '/api/frames/f' && request.method() === 'PATCH') {
        saved = { ...saved, ...JSON.parse(request.postData()!) }
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) })
      } else await request.continue()
    })
    await page.goto(`${vite.resolvedUrls!.local[0]}tests/fixtures/elementPanel.html`)
    await page.waitForFunction(() => !!(window as unknown as Harness).elementPanelHarness)
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Screen',
      x: 40,
      y: 60,
      width: 500,
      height: 400,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
      html: '<!doctype html><html><head></head><body><button id="cta">Continue</button></body></html>',
    }
    await page.evaluate((frame) => (window as unknown as Harness).elementPanelHarness.seed(frame), saved)
    const iframe = (await (await page.waitForSelector('iframe'))!.contentFrame())!
    await iframe.waitForSelector('#cta')
    await page.evaluate(() => (window as unknown as Harness).elementPanelHarness.select('#cta'))
  }, 60_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
  })

  it('adds, edits, undoes and removes an interaction', async () => {
    const tab = await page.waitForSelector('[role="tab"]::-p-text(Prototype)')
    await tab!.click()
    await page.locator('button[aria-label="Add interaction"]').click()
    await page.waitForFunction(() => !!document.querySelector('select[aria-label="Trigger 1"]'))
    expect(saved.html).toContain('data-doop-on="click"')
    expect(saved.html).toContain('data-doop-action="back"')

    await page.select('select[aria-label="Trigger 1"]', 'key')
    await page.waitForFunction(() => !!document.querySelector('input[aria-label="Key 1"]'))
    expect(saved.html).toContain('data-doop-on="key:ArrowRight"')

    await page.evaluate(() => (window as unknown as Harness).elementPanelHarness.undo())
    await page.waitForFunction(() => !document.querySelector('input[aria-label="Key 1"]'))
    expect(saved.html).toContain('data-doop-on="click"')

    await page.locator('button[aria-label="Remove interaction 1"]').click()
    await page.waitForFunction(() => !document.querySelector('select[aria-label="Trigger 1"]'))
    expect(saved.html).not.toContain('data-doop-')
  })
})
