import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import type { Canvas, Frame } from '../shared/types'

declare global {
  interface Window {
    seedPages: (canvas: Canvas) => void
    pageState: () => { activePageId: string; viewport: { x: number; y: number; zoom: number }; selectedId: string }
  }
}
const frame = (id: string, pageId: string, x: number): Frame => ({
  id,
  canvasId: 'c',
  pageId,
  name: id,
  x,
  y: 0,
  width: 200,
  height: 200,
  html: '<h1>Design</h1>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'User',
})
const canvas = (frames: Frame[]): Canvas => ({
  id: 'c',
  name: 'Design',
  pages: [
    { id: 'first', name: 'Main' },
    { id: 'second', name: 'Exploration' },
  ],
  frames,
  createdAt: 0,
  updatedAt: 0,
})

/* The first load transforms the whole app through a cold Vite dev server, which
   on a CI runner regularly takes longer than the 5 s default test timeout. */
describe.skipIf(!findBrowserPath())('page camera and snapping', { timeout: 30_000 }, () => {
  let vite: ViteDevServer
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    vite = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await vite.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800 })
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
  })

  async function load(data: Canvas, query = '') {
    await page.goto(`${vite.resolvedUrls!.local[0]}tests/fixtures/pages.html${query}`)
    await page.waitForFunction(() => typeof window.seedPages === 'function')
    await page.evaluate((data) => window.seedPages(data), data)
    await page.waitForSelector('iframe[data-doop-frame]')
  }

  it('centers the linked frame on a different page instead of fitting its distant siblings', async () => {
    await load(
      canvas([frame('original', 'first', 0), frame('target', 'second', 3000), frame('distant', 'second', 12000)]),
      '?frame=target',
    )
    await page.waitForFunction(() => window.pageState().activePageId === 'second')
    await page.waitForFunction(() => window.pageState().viewport.zoom === 1 && window.pageState().viewport.x === -2500)
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: 'second',
      selectedId: 'target',
      viewport: { x: -2500, y: 300, zoom: 1 },
    })
    expect(await page.$('iframe[title="original"]')).toBeNull()
  })

  it('does not snap a drag to the invisible frame on another page', async () => {
    const visible = frame('visible', 'first', 0)
    await load(canvas([visible, frame('hidden', 'second', 30)]))
    await page.waitForFunction(() => window.pageState().viewport.zoom === 1.25)
    await page.setRequestInterception(true)
    const patches: Record<string, unknown>[] = []
    const onRequest = async (request: import('puppeteer-core').HTTPRequest) => {
      if (request.url().endsWith('/api/frames/visible') && request.method() === 'PATCH') {
        const patch = JSON.parse(request.postData()!)
        patches.push(patch)
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...visible, ...patch }),
        })
      } else await request.continue()
    }
    page.on('request', onRequest)
    try {
      const box = await page.$eval('iframe[title="visible"]', (el) => {
        const rect = el.getBoundingClientRect()
        return { x: rect.x, y: rect.y }
      })
      const response = page.waitForResponse(
        (response) => response.url().endsWith('/api/frames/visible') && response.request().method() === 'PATCH',
      )
      await page.mouse.move(box.x + 50, box.y - 12)
      await page.mouse.down()
      await page.mouse.move(box.x + 85, box.y - 12, { steps: 5 })
      await page.mouse.up()
      await response
      expect(patches.at(-1)).toMatchObject({ x: 28 })
    } finally {
      page.off('request', onRequest)
      await page.setRequestInterception(false)
    }
  })
})
