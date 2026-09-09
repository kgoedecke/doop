import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'
import { pruneCssInDocument } from '../server/cssPrune.ts'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'

/* The pruner runs inside Chromium and leans on its CSS parser, so it is
   tested in the real thing rather than against a DOM emulation. Skipped where
   no browser is installed. */
describe.skipIf(!findBrowserPath())('unused CSS pruning', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setContent(
      '<!doctype html><html><head></head><body><div class="used"><ul><li>one</li></ul><a href="#">link</a></div></body></html>',
    )
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  const prune = (css: string) => page.evaluate(pruneCssInDocument, css)

  it('keeps rules whose selectors match and drops the rest', async () => {
    const pruned = await prune('.used { color: red } .unused { color: blue } body { margin: 0 }')

    expect(pruned).toContain('.used { color: red; }')
    expect(pruned).toContain('body { margin: 0px; }')
    expect(pruned).not.toContain('.unused')
  })

  it('ignores pseudo-classes and pseudo-elements when matching', async () => {
    const pruned = await prune(
      '.used:hover::after { content: "" } a:focus-visible { outline: 0 } .unused:hover { color: red } .used:not(.x) { top: 0 }',
    )

    expect(pruned).toContain('.used:hover::after')
    expect(pruned).toContain('a:focus-visible')
    expect(pruned).toContain('.used:not(.x)')
    expect(pruned).not.toContain('.unused')
  })

  it('keeps a selector it cannot test rather than guessing', async () => {
    const pruned = await prune('ul > :first-child { margin: 0 } :root { --brand: red }')

    expect(pruned).toContain('ul > :first-child')
    expect(pruned).toContain('--brand: red')
  })

  it('keeps grouping rules only when something inside them survived', async () => {
    const pruned = await prune(
      '@media (max-width: 600px) { .used { color: green } .unused { color: pink } }' +
        '@media print { .unused { display: none } }' +
        '@supports (display: grid) { .used { display: grid } }' +
        '@layer base { .unused { color: red } }',
    )

    expect(pruned).toContain('@media (max-width: 600px)')
    expect(pruned).toContain('color: green')
    expect(pruned).toContain('@supports (display: grid)')
    expect(pruned).not.toContain('@media print')
    expect(pruned).not.toContain('@layer base')
    expect(pruned).not.toContain('.unused')
  })

  it('keeps at-rules that have no selector to test', async () => {
    const pruned = await prune(
      '@font-face { font-family: X; src: url("https://example.com/x.woff2") }' +
        '@keyframes spin { to { transform: rotate(1turn) } }' +
        '@property --n { syntax: "<number>"; inherits: false; initial-value: 0 }',
    )

    expect(pruned).toContain('@font-face')
    expect(pruned).toContain('@keyframes spin')
    expect(pruned).toContain('@property --n')
  })
})
