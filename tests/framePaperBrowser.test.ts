import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { openBrowser, type TestBrowser } from './browser'
import { FRAME_PAPER_STYLE, withPaperRule } from '../shared/framePaper'

/** The cascade the frame paper relies on, in a real engine: the rule keeps an
 *  unstyled body white and loses to every way a design gives the body a
 *  background. */

const page_ = (head: string, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const WHITE = 'rgb(255, 255, 255)'
const DARK = 'rgb(16, 17, 17)'

describe.skipIf(!findBrowserPath())('frame paper cascade', { timeout: 60_000 }, () => {
  let browser: TestBrowser
  let page: Page

  async function bodyBackground(html: string) {
    await page.setContent(html)
    return page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  }

  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  it('keeps a body nothing styles white', async () => {
    expect(await bodyBackground(page_(FRAME_PAPER_STYLE))).toBe(WHITE)
    expect(await bodyBackground(page_(`${FRAME_PAPER_STYLE}<style>body.dark{background:#101111}</style>`))).toBe(WHITE)
  })

  it('loses to a design that styles the body, wherever the rule sits', async () => {
    for (const design of [
      '<style>body{background:#101111}</style>',
      '<style>@layer design{body{background:#101111}}</style>',
      '<style>@layer base,components;@layer base{body{background:#101111}}</style>',
      '<style>:where(body){background:#101111}</style>',
      '<style>*{background:#101111}</style>',
    ])
      expect(await bodyBackground(page_(FRAME_PAPER_STYLE + design)), design).toBe(DARK)
  })

  it('heals a frame drawn before: the design inside wins, an empty one stays white', async () => {
    const shell = 'width: 100%; height: 100%; margin: 0px;'
    const drawn = (content: string) =>
      `<!doctype html>\n<html style="${shell}"><head></head><body style="${shell} background: ${WHITE};">${content}</body></html>`
    const design = '<style>body{background:#101111}</style><main></main>'
    expect(await bodyBackground(drawn(design))).toBe(WHITE)
    expect(await bodyBackground(withPaperRule(drawn(design)))).toBe(DARK)
    expect(await bodyBackground(withPaperRule(drawn('')))).toBe(WHITE)
  })
})
