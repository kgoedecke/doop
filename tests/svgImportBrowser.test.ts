import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { Frame } from '../shared/types'

/* `window.drawingHarness` is declared by drawingBrowser.test.ts, whose fixture this shares */

/* the fixture's stage starts 40px down the page; the viewport below puts
   world (0,0) at stage (40,20) and doubles everything */
const VIEWPORT = { x: 40, y: 20, zoom: 2 }
const screen = (wx: number, wy: number): [number, number] => [
  VIEWPORT.x + wx * VIEWPORT.zoom,
  40 + VIEWPORT.y + wy * VIEWPORT.zoom,
]

describe.skipIf(!findBrowserPath())('importing SVG files', { timeout: 30_000 }, () => {
  let browser: TestBrowser
  let page: Page
  let saved: Frame[] = []
  const errors: string[] = []

  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (err) => errors.push(String(err)))
    await page.setRequestInterception(true)
    page.on('request', async (req) => {
      const path = new URL(req.url()).pathname
      if (path.startsWith('/api/frames/') && req.method() === 'PATCH') {
        const id = path.split('/').at(-1)
        const frame = { ...saved.find((f) => f.id === id), ...JSON.parse(req.postData()!), updatedAt: Date.now() }
        saved = saved.map((f) => (f.id === id ? frame : f))
        await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(frame) })
      } else await req.continue()
    })
  }, 60_000)

  beforeEach(async () => {
    saved = []
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(fixtureUrl('drawing.html'))
    await page.waitForFunction(() => !!window.drawingHarness)
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    expect(errors).toEqual([])
  })

  /** The attributes and inline style of every match in an HTML document, read in the page. */
  function inspect(html: string, selector: string) {
    return page.evaluate(
      (html, selector) =>
        [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll<HTMLElement>(selector)].map((el) => ({
          attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
          style: { left: el.style.left, width: el.style.width, transform: el.style.transform },
        })),
      html,
      selector,
    )
  }

  async function seed(frames: Frame[]) {
    saved = frames
    await page.evaluate(
      (frames) =>
        window.drawingHarness.seed({
          id: 'c',
          name: 'Import',
          frames,
          pages: [{ id: 'first', name: 'Main' }],
          createdAt: 0,
          updatedAt: 0,
        }),
      frames,
    )
    await page.waitForSelector('[aria-label="Canvas tools"]')
    await page.evaluate((viewport) => window.drawingHarness.viewport(viewport), VIEWPORT)
  }

  it('reads the paint the browser computes: class rules, currentColor and inherited fills', async () => {
    const result = await page.evaluate(() =>
      window.drawingHarness.importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
          <style>.st0{fill:#ff0000;stroke:#00ff00;stroke-width:0.5}</style>
          <g style="color:blue">
            <rect class="st0" width="4" height="4"/>
            <circle cx="7" cy="7" r="2" fill="currentColor"/>
          </g>
        </svg>`,
        'styled',
      ),
    )
    expect(result).not.toBeNull()
    const [rect, circle] = await inspect(result!.html, 'svg[data-doop-drawing="path"] > path')
    expect(rect!.attrs).toMatchObject({ fill: 'rgb(255, 0, 0)', stroke: 'rgb(0, 255, 0)', 'stroke-width': '0.5' })
    expect(circle!.attrs['fill']).toBe('rgb(0, 0, 255)')
    /* the file's style block stayed in its shadow root and is gone with it */
    expect(
      await page.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent?.includes('.st0'))),
    ).toBe(false)
  })

  it('keeps the effects a style block gives shapes, text and images, as the browser computes them', async () => {
    const result = await page.evaluate(() =>
      window.drawingHarness.importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
          <style>.cut{clip-path:url(#c)} .veil{mask:url(#m)} .soft{filter:url(#f)}</style>
          <defs>
            <clipPath id="c"><rect width="10" height="10"/></clipPath>
            <mask id="m"><rect width="5" height="10" fill="white"/></mask>
            <filter id="f"><feGaussianBlur stdDeviation="1"/></filter>
          </defs>
          <g transform="translate(20 0)"><rect class="veil" width="10" height="10"/></g>
          <text class="soft" x="2" y="30" opacity="0.5">Hi</text>
          <image class="cut" href="data:image/png;base64,AAAA" width="20" height="20"/>
        </svg>`,
        'effects',
      ),
    )
    expect(result).not.toBeNull()
    const [rect] = await inspect(result!.html, 'svg[data-doop-drawing="path"] > path')
    expect(rect!.attrs['mask']).toMatch(/^url\(#k-m-mask-\d+\)$/)
    const [copy] = await inspect(result!.html, 'mask[id^="k-m-mask-"] > g')
    expect(copy!.attrs['transform']).toBe('matrix(1 0 0 1 20 0)')
    const [text, image] = await inspect(result!.html, '[data-doop-drawing="svg"]')
    expect(text!.attrs['opacity']).toBe('0.5')
    const [inner, img] = await inspect(result!.html, '[data-doop-drawing="svg"] text, [data-doop-drawing="svg"] image')
    expect(inner!.attrs['opacity']).toBeUndefined()
    expect(inner!.attrs['style']).toContain('filter:url(#k-f)')
    expect(image!.attrs['opacity']).toBeUndefined()
    expect(img!.attrs['style']).toContain('clip-path:url(#k-c)')
  })

  it('opens the path editor on a shape inside an imported group, keeps its percentage layout and adds points on the outline', async () => {
    const result = (await page.evaluate(() =>
      window.drawingHarness.importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <rect width="40" height="40" fill="red"/>
          <rect x="60" y="60" width="40" height="40" fill="blue"/>
        </svg>`,
        'two',
      ),
    ))!
    const frame: Frame = {
      id: 'import',
      canvasId: 'c',
      pageId: 'first',
      name: 'two',
      x: 100,
      y: 100,
      width: result.width,
      height: result.height,
      html: result.html,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'User',
    }
    await seed([frame])
    await page.waitForSelector('iframe[title="two"]')
    /* the red square's ink runs from file (0,0) to (40,40): its middle on the
       canvas is the shell's corner plus the two px pad plus twenty */
    await page.mouse.click(...screen(frame.x + 22, frame.y + 22), { count: 2, delay: 60 })
    await page.waitForSelector('[data-path-edit-anchor="3"]')
    expect(await page.$$('[data-path-edit-anchor]')).toHaveLength(4)
    /* Figma's editing cursors: a node badge on anchors, a pen with + on the outline */
    const cursorOf = (selector: string) =>
      page.$eval(selector, (el) => decodeURIComponent(getComputedStyle(el).cursor).match(/data-cursor='([^']+)'/)?.[1])
    expect(await cursorOf('[data-path-edit-anchor="0"]')).toBe('node')
    expect(await cursorOf('[data-path-segment="0-0"]')).toBe('pen-add')

    /* drag the top-left anchor inward: the shape re-places itself in the group */
    const anchor = await page.$eval('[data-path-edit-anchor="0"]', (el) => {
      const box = el.getBoundingClientRect()
      return [box.x + box.width / 2, box.y + box.height / 2] as [number, number]
    })
    await page.mouse.move(...anchor)
    await page.mouse.down()
    await page.mouse.move(anchor[0] + 20, anchor[1] + 20, { steps: 5 })
    await page.mouse.up()
    await page.waitForFunction(() => window.drawingHarness.state().frames[0]!.updatedAt > 0)
    await page.waitForFunction(() => !document.querySelector('[data-path-editor] button:disabled'))
    const [red, blue] = await inspect(saved[0]!.html, 'svg[data-doop-drawing="path"]')
    expect(red!.style.left).toMatch(/%$/)
    expect(red!.style.width).toMatch(/%$/)
    expect(red!.style.transform).toBe('none')
    const [redPath, bluePath] = await inspect(saved[0]!.html, 'svg[data-doop-drawing="path"] > path')
    expect(redPath!.attrs['d']).toBe('M 10 10 L 40 0 L 40 40 L 0 40 Z')
    /* the group's shell did not move or grow: the anchor went inward */
    expect(saved[0]).toMatchObject({ x: frame.x, y: frame.y, width: frame.width, height: frame.height })

    /* a click on the outline adds an anchor there */
    const segment = await page.$eval('[data-path-segment="0-2"]', (el) => {
      const box = el.getBoundingClientRect()
      return [box.x + box.width / 2, box.y + box.height / 2] as [number, number]
    })
    await page.mouse.click(...segment)
    await page.waitForFunction(() => document.querySelectorAll('[data-path-edit-anchor]').length === 5)
    await page.waitForFunction(() => !document.querySelector('[data-path-editor] button:disabled'))
    expect(saved[0]!.html).toContain('L 40 40 L 20 40 L 0 40')

    /* the blue square is untouched and still a layer of its own */
    expect(blue!.attrs['data-name']).toBe('Rectangle')
    expect(bluePath!.attrs['d']).toBe('M 60 60 L 100 60 L 100 100 L 60 100 Z')
  })
})
