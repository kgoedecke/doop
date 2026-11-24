import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot.ts'
import { framePreviewHtml, previewOf, type CanvasPreview } from '../server/chatgptApp.ts'
import type { Frame } from '../shared/types.ts'
import { pagePerTest } from './browser.ts'

/*
 * The preview card an embedding MCP client (Claude, ChatGPT) shows beside a tool
 * result, run in Chromium on ChatGPT's dialect: the result on `window.openai.toolOutput`,
 * links opened through `openExternal`, which the test records. "Open in Doop" used to
 * open the bare canvas even when the card showed one frame.
 */

const canvas = { id: 'cv1', name: 'Landing' }

function frame(id: string, name: string): Frame {
  return { id, name, width: 1440, height: 900, updatedAt: 1, html: '<p>hi</p>' } as Frame
}

describe.skipIf(!findBrowserPath())('the frame preview card', () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
  })

  /** Loads the card with `data` as its tool output; links it opens land in `window.opened`. */
  async function showCard(data: CanvasPreview): Promise<void> {
    const host = `<script>window.opened = []; window.openai = { toolOutput: ${JSON.stringify(data)}, openExternal: function (o) { window.opened.push(o.href) } }</script>`
    await page.setContent(framePreviewHtml().replace('<script>', `${host}<script>`), { waitUntil: 'load' })
    await page.waitForSelector('.open')
  }

  const opened = () => page.evaluate(() => (window as unknown as { opened: string[] }).opened)
  const hrefOf = (selector: string) => page.$eval(selector, (el) => el.getAttribute('data-href'))

  it('opens the one frame it shows, from the button and from the image', async () => {
    const data = previewOf(canvas, [frame('f1', 'Hero')])
    expect(data.frames[0]!.url).toBe(`${data.canvas.url}?frame=f1`)
    await showCard(data)

    expect(await hrefOf('.open')).toBe(data.frames[0]!.url)
    await page.click('.open')
    /* off centre: with no server the render fails, and the placeholder's Retry sits in the middle */
    await (await page.$('.card > a'))!.click({ offset: { x: 4, y: 4 } })
    expect(await opened()).toEqual([data.frames[0]!.url, data.frames[0]!.url])
    /* the button already says where it goes: no second link on the frame */
    expect(await page.$('.frame-open')).toBeNull()
  })

  it('gives each of several frames its own visible Open link and keeps the button for the canvas', async () => {
    const data = previewOf(canvas, [frame('f1', 'Hero'), frame('f2', 'Pricing'), frame('f3', 'Footer')])
    await showCard(data)

    expect(await hrefOf('.open')).toBe(data.canvas.url)
    const links = await page.$$eval('.frame-open', (els) =>
      els.map((el) => ({
        href: el.getAttribute('data-href'),
        text: el.textContent,
        shown: el.getClientRects().length > 0,
      })),
    )
    expect(links).toEqual(data.frames.map((f) => ({ href: f.url, text: 'Open', shown: true })))

    const [, pricing] = await page.$$('.frame-open')
    await pricing!.click()
    await page.click('.open')
    expect(await opened()).toEqual([`${data.canvas.url}?frame=f2`, data.canvas.url])
  })

  it('sends the frames past the ones shown to the canvas', async () => {
    const data = previewOf(
      canvas,
      Array.from({ length: 8 }, (_, i) => frame(`f${i}`, `Screen ${i}`)),
    )
    await showCard(data)

    expect(await page.$$eval('.frame-open', (els) => els.length)).toBe(6)
    expect(await hrefOf('.card.more')).toBe(data.canvas.url)
  })
})
