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

  it('renders at any picked scale, 3x included', async () => {
    const out = await render({ scale: 3 })
    expect([out.width, out.height]).toEqual([900, 900])
    expect(out.block).toEqual([255, 0, 0, 255])
    expect(out.pic).toEqual([0, 0, 255, 255])
  })

  it('saves an SVG that draws the frame wherever it is opened, cropped by a clip', async () => {
    const svg = (opts: Record<string, unknown>) =>
      page.evaluate(
        (o) =>
          (
            window as unknown as {
              renderSvg: (o: unknown) => Promise<{ type: string; width: number; height: number } & Rendered>
            }
          ).renderSvg(o),
        opts,
      )
    const whole = await svg({})
    expect(whole.type).toBe('image/svg+xml;charset=utf-8')
    expect([whole.width, whole.height]).toEqual([300, 300])
    expect(whole.block).toEqual([255, 0, 0, 255])
    expect(whole.paper).toEqual([255, 255, 255, 255])
    const piece = await svg({ clip: { x: 200, y: 0, width: 100, height: 100 } })
    expect([piece.width, piece.height]).toEqual([100, 100])
    expect(piece.topLeft).toEqual([0, 0, 255, 255])
  })

  it('lays an SVG opened as a page out at the frame size, not the window', async () => {
    const html = `<html><head>
      <style>@import url("/tests/fixtures/svgStandalone.css?direct");</style>
      <style>
        body { margin: 0 }
        .box { width: 10px; height: 10px; background: rgb(255, 0, 0) }
        @media (min-width: 600px) { .box { background: rgb(0, 128, 0) } }
        .half { width: 50vw; height: 10px }
      </style>
      <style media="(min-width: 600px)">.box { outline: 3px solid rgb(0, 0, 0) }</style>
      </head><body><div class="box"></div><div class="half"></div><div class="tall imported"></div></body></html>`
    const text = await page.evaluate(
      (h) => (window as unknown as { svgText: (o: unknown) => Promise<string> }).svgText({ html: h }),
      html,
    )
    /* a window far wider and taller than the 300px frame */
    const standalone = await browser.newPage()
    try {
      await standalone.setViewport({ width: 1400, height: 900 })
      await standalone.goto(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`)
      const laid = await standalone.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
        return {
          box: style('.box').backgroundColor,
          outline: style('.box').outlineStyle,
          half: style('.half').width,
          tall: style('.tall').height,
          imported: style('.imported').backgroundColor,
        }
      })
      expect(laid).toEqual({
        box: 'rgb(255, 0, 0)',
        outline: 'none',
        half: '150px',
        tall: '300px',
        imported: 'rgba(0, 0, 0, 0)',
      })
    } finally {
      await standalone.close()
    }
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
