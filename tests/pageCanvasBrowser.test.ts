import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { Canvas, Frame } from '../shared/types'

declare global {
  interface Window {
    seedPages: (canvas: Canvas) => void
    pageState: () => {
      activePageId: string
      viewport: { x: number; y: number; zoom: number }
      selectedId: string
      selectedElement: { frameId: string; selector: string } | null
      elementPanelOpen: boolean
      inspectorOpen: boolean
      notice?: string
    }
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

/* Each test loads the whole app (hundreds of unbundled modules) in its own body,
   which on a busy CI runner can take longer than the 5 s default test timeout. */
describe.skipIf(!findBrowserPath())('page camera and snapping', { timeout: 30_000 }, () => {
  let browser: TestBrowser
  let page: Page
  beforeAll(async () => {
    browser = await openBrowser()
    await browser.grantPermissions(['clipboard-read', 'clipboard-sanitized-write'])
    page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800 })
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  async function load(data: Canvas, query = '') {
    await page.goto(fixtureUrl(`pages.html${query}`))
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

  it.each(['first', 'second'])('selects a linked element after its frame mounts on the %s page', async (pageId) => {
    const target = { ...frame('target', pageId, 3000), html: '<main id="hero"><h1>Design</h1></main>' }
    const selector = '#hero > h1:nth-of-type(1)'
    await load(
      canvas([frame('original', 'first', 0), target]),
      `?${new URLSearchParams({ frame: target.id, selector })}`,
    )
    await page.waitForSelector('button[aria-label="Copy link to element"]')
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: pageId,
      selectedId: target.id,
      selectedElement: { frameId: target.id, selector },
      elementPanelOpen: true,
      inspectorOpen: false,
      viewport: { x: -2500, y: 300, zoom: 1 },
    })

    // Copy through the actual element toolbar, then reopen the resulting URL.
    await page.locator('button[aria-label="Copy link to element"]').click()
    await page.waitForFunction(() => window.pageState().notice === 'Element link copied')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    const url = new URL(copied)
    expect(url.pathname).toBe('/c/c')
    expect(url.searchParams.get('frame')).toBe(target.id)
    expect(url.searchParams.get('selector')).toBe(selector)
    expect(await page.evaluate(() => window.pageState().notice)).toBe('Element link copied')
    await load(canvas([target]), url.search)
    await page.waitForSelector('button[aria-label="Copy link to element"]')
    expect(await page.evaluate(() => window.pageState().selectedElement)).toEqual({ frameId: target.id, selector })

    // Deselecting still removes the probe and its panel after a deep link.
    await page.mouse.click(100, 100)
    await page.waitForFunction(() => window.pageState().selectedElement === null)
    expect(await page.evaluate(() => window.pageState().elementPanelOpen)).toBe(false)
  })

  it.each(['#removed', '[invalid'])('falls back to the frame when the linked selector is %s', async (selector) => {
    await load(canvas([frame('target', 'second', 3000)]), `?${new URLSearchParams({ frame: 'target', selector })}`)
    await page.waitForFunction(() => !!window.pageState().notice)
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: 'second',
      selectedElement: null,
      elementPanelOpen: false,
      inspectorOpen: true,
      notice: 'This element no longer exists. Showing its frame instead.',
    })
  })

  it.each(['first', 'second'])('opens links to script-created elements on the %s page', async (pageId) => {
    const target = {
      ...frame('target', pageId, 3000),
      html: `<main></main><script>
        const chart = document.createElement('h1')
        chart.id = 'chart'
        chart.textContent = 'Live chart'
        document.querySelector('main').append(chart)
      </script>`,
    }
    await load(canvas([frame('original', 'first', 0), target]), '?frame=target&selector=%23chart')
    await page.waitForSelector('button[aria-label="Copy link to element"]', { timeout: 5000 })
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: pageId,
      selectedId: target.id,
      selectedElement: { frameId: target.id, selector: '#chart' },
      elementPanelOpen: true,
      inspectorOpen: false,
    })
    expect(await page.evaluate(() => window.pageState().notice)).toBeUndefined()

    await page.locator('button[aria-label="Copy link to element"]').click()
    await page.waitForFunction(() => window.pageState().notice === 'Element link copied')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    await load(canvas([target]), new URL(copied).search)
    await page.waitForSelector('button[aria-label="Copy link to element"]', { timeout: 5000 })
    expect(await page.evaluate(() => window.pageState().selectedElement)).toEqual({
      frameId: target.id,
      selector: '#chart',
    })
  })

  it('falls back to frame details when a script removes an element from the saved HTML', async () => {
    const target = {
      ...frame('target', 'second', 3000),
      html: '<h1 id="chart">Saved chart</h1><script>document.getElementById("chart").remove()</script>',
    }
    await load(canvas([target]), '?frame=target&selector=%23chart')
    await page.waitForFunction(() => !!window.pageState().notice, { timeout: 5000 })
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: 'second',
      selectedId: target.id,
      selectedElement: null,
      elementPanelOpen: false,
      inspectorOpen: true,
      notice: 'This element no longer exists. Showing its frame instead.',
    })
    expect(await page.$('button[aria-label="Copy link to element"]')).toBeNull()
  })

  it('follows another element link and browser history within the same mounted canvas', async () => {
    const target = { ...frame('target', 'first', 0), html: '<h1 id="one">One</h1><h2 id="two">Two</h2>' }
    await load(canvas([target]), '?frame=target&selector=%23one')
    await page.waitForFunction(() => window.pageState().selectedElement?.selector === '#one')
    await page.evaluate(() => {
      history.pushState(null, '', '?frame=target&selector=%23two')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForFunction(() => window.pageState().selectedElement?.selector === '#two')
    await page.waitForSelector('button[aria-label="Copy link to element"]')
    await page.evaluate(() => history.back())
    await page.waitForFunction(() => window.pageState().selectedElement?.selector === '#one')
    await page.evaluate(() => {
      history.pushState(null, '', '?frame=target')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForFunction(() => window.pageState().inspectorOpen && !window.pageState().selectedElement)
    await page.waitForSelector('button[aria-label="Copy link to element"]', { hidden: true })
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
