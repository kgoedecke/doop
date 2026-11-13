import { beforeEach, describe, expect, it } from 'vitest'
import type { Frame, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { ElementInfo, StylePatch } from '../src/lib/frameBridge'

type Fixture = {
  messages: { type: string; reqId?: string; html?: string; info?: ElementInfo }[]
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
