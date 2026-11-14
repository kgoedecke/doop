import { beforeEach, describe, expect, it } from 'vitest'
import type { Frame, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { ElementInfo, StylePatch } from '../src/lib/frameBridge'

type Fixture = {
  messages: {
    type: string
    reqId?: string
    html?: string
    info?: ElementInfo
    px?: number
    hit?: { selector: string }
  }[]
}

/* A drawn path, as `drawingElement` writes one on a standalone element. */
const PATH_HTML =
  '<body data-doop-canvas-element="true" style="width:100%;height:100%;margin:0">' +
  '<svg id="vec" data-doop-drawing="path" viewBox="0 0 100 100" preserveAspectRatio="none" ' +
  'style="position:absolute;left:0;top:0;width:100%;height:100%;margin:0">' +
  '<path d="M10 10 C 40 90, 60 90, 90 10" fill="none" stroke="#ffffff" stroke-width="2"></path></svg></body>'

describe.skipIf(!findBrowserPath())('vector paint in the Design panel', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  let frame: Frame

  beforeEach(async () => {
    page = await pages.open()
    await page.goto(fixtureUrl('frameReplay.html'))
    await page.waitForFunction(() =>
      (window as unknown as Fixture).messages?.some((m) => m.type === 'doop:frame-ready'),
    )
    frame = page.frames().find((f) => f !== page.mainFrame())!
    await page.evaluate(
      (html) => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'doop:html', html }, '*'),
      PATH_HTML,
    )
    await frame.waitForSelector('#vec path')
  })

  let nextReq = 0
  async function ask(type: string, payload: Record<string, unknown>) {
    const reqId = `req-${++nextReq}`
    await page.evaluate((message) => document.querySelector('iframe')!.contentWindow!.postMessage(message, '*'), {
      ...payload,
      type,
      reqId,
    })
    await page.waitForFunction(
      (reqId) => (window as unknown as Fixture).messages.some((m) => m.reqId === reqId),
      {},
      reqId,
    )
    return page.evaluate((reqId) => (window as unknown as Fixture).messages.find((m) => m.reqId === reqId)!.info, reqId)
  }
  const style = (styles: StylePatch) => ask('doop:style', { selector: '#vec', styles })
  const gesture = (phase: 'begin' | 'commit' | 'cancel') => ask('doop:style-gesture', { selector: '#vec', phase })
  const paint = () =>
    frame.$eval('#vec', (svg) => {
      const path = getComputedStyle(svg.querySelector('path')!)
      const box = getComputedStyle(svg)
      return { stroke: path.stroke, strokeWidth: path.strokeWidth, fill: path.fill, border: box.borderTopStyle }
    })
  async function savedHtml() {
    return page.evaluate(
      () => (window as unknown as Fixture).messages.filter((m) => m.type === 'doop:edited').at(-1)?.html ?? '',
    )
  }

  it('reports the path paint, not the box border', async () => {
    const info = await ask('doop:inspect', { selector: '#vec' })
    expect(info?.vector).toMatchObject({ stroke: 'rgb(255, 255, 255)', strokeWidth: 2, fill: 'none' })
  })

  it('strokes and fills the path itself, and saves it', async () => {
    const info = await style({ stroke: '#ff0000', 'stroke-width': '4px' })
    expect(info?.vector).toMatchObject({ stroke: 'rgb(255, 0, 0)', strokeWidth: 4 })
    await style({ fill: '#00ff00' })
    expect(await paint()).toEqual({
      stroke: 'rgb(255, 0, 0)',
      strokeWidth: '4px',
      fill: 'rgb(0, 255, 0)',
      border: 'none',
    })
    await expect
      .poll(savedHtml)
      .toMatch(/<path [^>]*style="stroke: rgb\(255, 0, 0\); stroke-width: 4px; fill: rgb\(0, 255, 0\);"/)
  })

  it('puts a cancelled stroke-width scrub back on the path', async () => {
    await gesture('begin')
    await style({ 'stroke-width': '9px' })
    expect((await paint()).strokeWidth).toBe('9px')
    await gesture('cancel')
    expect((await paint()).strokeWidth).toBe('2px')
    expect(await frame.$eval('#vec path', (path) => path.getAttribute('style'))).toBeNull()
  })

  it('saves a committed scrub once', async () => {
    await gesture('begin')
    await style({ 'stroke-width': '6px' })
    await gesture('commit')
    await expect.poll(savedHtml).toContain('stroke-width: 6px')
  })

  it('keeps a paint scrub over a remote update, and commits the scrubbed value', async () => {
    await gesture('begin')
    await style({ 'stroke-width': '9px' })
    await page.evaluate(
      (html) => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'doop:html', html }, '*'),
      PATH_HTML.replace('stroke="#ffffff"', 'stroke="#0000ff"'),
    )
    await frame.waitForFunction(() => document.querySelector('#vec path')!.getAttribute('stroke') === '#0000ff')
    expect(await paint()).toMatchObject({ stroke: 'rgb(0, 0, 255)', strokeWidth: '9px' })
    await gesture('commit')
    await expect.poll(savedHtml).toMatch(/stroke="#0000ff"[^>]*style="stroke-width: 9px;"/)
  })

  it('reports an imported fill-opacity apart from the fill colour', async () => {
    await page.evaluate(
      (html) => document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'doop:html', html }, '*'),
      PATH_HTML.replace('fill="none"', 'fill="red" fill-opacity="0.5"'),
    )
    await frame.waitForFunction(() => document.querySelector('#vec path')!.getAttribute('fill') === 'red')
    expect((await ask('doop:inspect', { selector: '#vec' }))?.vector).toMatchObject({
      fill: 'rgb(255, 0, 0)',
      fillOpacity: 0.5,
    })
    await style({ fill: '#ff0000', 'fill-opacity': '0.25' })
    expect(await frame.$eval('#vec path', (path) => getComputedStyle(path).fillOpacity)).toBe('0.25')
  })

  describe('a stroke wider than its box', () => {
    /* the fixture's iframe sized as FrameView sizes it: the frame plus the margin */
    async function sizeFrame(width: number, height: number, margin: number) {
      await page.evaluate(
        (width, height, margin) => {
          const iframe = document.querySelector('iframe')!
          iframe.style.cssText = `border:0;width:${width + 2 * margin}px;height:${height + 2 * margin}px`
          iframe.contentWindow!.postMessage({ type: 'doop:bleed', px: margin }, '*')
        },
        width,
        height,
        margin,
      )
      await frame.waitForFunction((w) => innerWidth === w, {}, width + 2 * margin)
    }
    const wanted = () =>
      page.evaluate(
        () => (window as unknown as Fixture).messages.filter((m) => m.type === 'doop:bleed-want').at(-1)?.px,
      )

    beforeEach(() => sizeFrame(100, 100, 0))

    it('asks for no margin while the stroke fits the box, and for one that holds it past', async () => {
      await style({ 'stroke-width': '1px' })
      await new Promise((r) => setTimeout(r, 100))
      expect(await wanted()).toBeFalsy()
      /* the curve's ends sit 10px from the edge: a 40px stroke reaches 10px past */
      await style({ 'stroke-width': '40px', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
      await expect.poll(wanted).toBe(16)
      await style({ 'stroke-width': '2px' })
      await expect.poll(wanted).toBe(0)
    })

    it('holds a miter join out to the path own miter limit', async () => {
      /* the default limit of 4: a 40px stroke's corner reaches 80px from its
         point, 70px past the box */
      await style({ 'stroke-width': '40px', 'stroke-linejoin': 'miter' })
      await expect.poll(wanted).toBe(80)
      /* an imported limit of 10 reaches 200px: 190px past, in a 16px step */
      await frame.$eval('#vec path', (path) => path.setAttribute('stroke-miterlimit', '10'))
      await expect.poll(wanted).toBe(192)
    })

    it('keeps the frame coordinates and paints the stroke into the margin', async () => {
      await style({ stroke: '#ff0000', 'stroke-width': '40px' })
      await expect.poll(wanted).toBeGreaterThan(0)
      const margin = (await wanted())!
      await sizeFrame(100, 100, margin)
      const info = await ask('doop:inspect', { selector: '#vec' })
      expect(info?.rect).toMatchObject({ x: 0, y: 0, width: 100, height: 100 })
      /* a point in the frame's own px still finds the shape */
      const reqId = 'probe-bleed'
      await page.evaluate(
        (reqId) =>
          document
            .querySelector('iframe')!
            .contentWindow!.postMessage({ type: 'doop:probe', reqId, x: 50, y: 72, grouped: false }, '*'),
        reqId,
      )
      await page.waitForFunction(
        (reqId) => (window as unknown as Fixture).messages.some((m) => m.reqId === reqId),
        {},
        reqId,
      )
      const hit = await page.evaluate(
        (reqId) => (window as unknown as Fixture).messages.find((m) => m.reqId === reqId)!.hit,
        reqId,
      )
      expect(hit?.selector).toBe('#vec')
      /* the stroke beside the curve's start, left of the box, is drawn in the margin */
      const painted = await frame.evaluate((margin) => {
        const el = document.elementFromPoint(margin - 5, margin + 16)
        return el?.tagName.toLowerCase()
      }, margin)
      expect(painted).toBe('path')
    })
  })

  it('leaves a box layer on background and border', async () => {
    await page.evaluate(() =>
      document
        .querySelector('iframe')!
        .contentWindow!.postMessage(
          { type: 'doop:html', html: '<div id="vec" style="width:50px;height:50px"></div>' },
          '*',
        ),
    )
    await frame.waitForFunction(() => !document.querySelector('#vec path'))
    expect((await ask('doop:inspect', { selector: '#vec' }))?.vector).toBeNull()
  })
})
