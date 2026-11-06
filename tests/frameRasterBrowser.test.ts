import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'

interface Rendered {
  type: string
  topLeft: number[]
  width: number
  height: number
  block: number[]
  pic: number[]
  paper: number[]
  made: number[]
  chart: number[]
  adopted: number[]
  picked: number[]
  blobbed: number[]
}

/* the user-triggered export is drawn by the browser showing the frame:
   the document, its images and fonts inlined into one SVG, painted to a
   canvas, with no server render */
describe.skipIf(!findBrowserPath())('rasterizing a frame in the browser', () => {
  let browser: TestBrowser
  let page: Page
  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    await page.goto(fixtureUrl('frameRaster.html'))
    await page.waitForFunction(() => typeof (window as { render?: unknown }).render === 'function')
  }, 30_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  const render = (opts: Record<string, unknown> = {}) =>
    page.evaluate((o) => (window as unknown as { render: (o: unknown) => Promise<Rendered> }).render(o), opts)

  it('paints the frame, its image included, at the frame size', async () => {
    const out = await render()
    expect(out.type).toBe('image/png')
    expect([out.width, out.height]).toEqual([300, 300])
    expect(out.block).toEqual([255, 0, 0, 255])
    expect(out.pic).toEqual([0, 0, 255, 255])
    expect(out.paper).toEqual([255, 255, 255, 255])
  })

  it('renders at 2x for a retina export', async () => {
    const out = await render({ scale: 2 })
    expect([out.width, out.height]).toEqual([600, 600])
    expect(out.block).toEqual([255, 0, 0, 255])
    expect(out.pic).toEqual([0, 0, 255, 255])
  })

  it('keeps only the clipped box, drawn from the whole document, for an element export', async () => {
    const out = await render({ scale: 2, clip: { x: 200, y: 0, width: 100, height: 100 } })
    expect([out.width, out.height]).toEqual([200, 200])
    /* the image at the frame's right edge is now at the origin */
    expect(out.topLeft).toEqual([0, 0, 255, 255])
  })

  it('encodes a JPEG on request', async () => {
    const out = await render({ type: 'jpeg' })
    expect(out.type).toBe('image/jpeg')
    expect(out.block[0]).toBeGreaterThan(240)
    expect(out.block[1]).toBeLessThan(16)
  })

  it('paints white where the document has no background', async () => {
    const out = await render({ html: '<html><body></body></html>' })
    expect(out.paper).toEqual([255, 255, 255, 255])
  })

  it('exports what the runtime shows: script-made elements, canvas pixels, adopted sheets, picked sources', async () => {
    const out = await render({ live: true, html: '<html><body></body></html>' })
    expect(out.made).toEqual([0, 128, 0, 255])
    expect(out.chart).toEqual([128, 0, 128, 255])
    expect(out.adopted).toEqual([255, 128, 0, 255])
    expect(out.picked).toEqual([0, 0, 255, 255])
    expect(out.blobbed).toEqual([0, 128, 128, 255])
  })

  it('rejects a frame with an image the browser cannot fetch, for the server to render', async () => {
    /* a host nothing answers on; the fixture server itself answers any
       path with the app page */
    const failed = await page.evaluate(() =>
      (window as unknown as { render: (o: unknown) => Promise<Rendered> })
        .render({ html: '<html><body><img src="http://127.0.0.1:9/no-cors.png"></body></html>' })
        .then(
          () => null,
          (error: Error) => error.message,
        ),
    )
    expect(failed).toMatch(/fetch/i)
  })
})
