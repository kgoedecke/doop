import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser, Page } from 'puppeteer-core'
import { PRUNE_DEADLINE_MS, pruneCssInDocument } from '../server/cssPrune.ts'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'

/* The pruner runs inside Chromium and leans on its CSS parser, so it is
   tested in the real thing rather than against a DOM emulation. Skipped where
   no browser is installed. */
describe.skipIf(!findBrowserPath())('unused CSS pruning', () => {
  let browser: Browser
  let page: Page

  /* Launching Chromium on a loaded CI runner can take longer than vitest's
     default 10 s hook timeout. */
  beforeAll(async () => {
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setContent(
      '<!doctype html><html><head></head><body><div class="used"><ul><li>one</li></ul><a href="#">link</a></div><p style="font-family: Inline">inline</p></body></html>',
    )
  }, 60_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  const prune = async (css: string, deadlineMs = PRUNE_DEADLINE_MS) =>
    (await page.evaluate(pruneCssInDocument, css, deadlineMs)).css

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

  it('keeps everything it has not examined once the deadline passes', async () => {
    const pruned = await prune('.used { color: red } .unused { color: blue }', 0)

    expect(pruned).toContain('.used')
    expect(pruned).toContain('.unused')
  })

  it('serialises the document it pruned against', async () => {
    const { html } = await page.evaluate(pruneCssInDocument, '.used { color: red }', PRUNE_DEADLINE_MS)

    expect(html).toContain('<div class="used">')
    expect(html).not.toContain('<style>')
  })

  it('keeps the @font-face blocks the page lays out text with and drops the rest', async () => {
    const pruned = await prune(
      '@font-face { font-family: Used; src: url("https://example.com/u.woff2") }' +
        '@font-face { font-family: "Unused Sans"; src: url("https://example.com/n.woff2") }' +
        '@font-face { font-family: Inline; src: url("https://example.com/i.woff2") }' +
        '.used { font-family: Used, sans-serif }',
    )

    expect(pruned).toContain('font-family: Used')
    expect(pruned).toContain('font-family: Inline')
    expect(pruned).not.toContain('Unused Sans')
  })

  it('keeps @font-face blocks named by rules kept for states the capture is not in', async () => {
    const pruned = await prune(
      '@font-face { font-family: Narrow; src: url("https://example.com/w.woff2") }' +
        '@font-face { font-family: Hover; src: url("https://example.com/h.woff2") }' +
        '@font-face { font-family: Nobody; src: url("https://example.com/x.woff2") }' +
        '@media (max-width: 600px) { .used { font-family: Narrow } }' +
        '.used:hover { font-family: "Hover" }',
    )

    expect(pruned).toContain('font-family: Narrow')
    expect(pruned).toContain('font-family: Hover')
    expect(pruned).not.toContain('Nobody')
  })

  it('keeps every @font-face when a kept rule picks its family through var()', async () => {
    const pruned = await prune(
      '@font-face { font-family: Maybe; src: url("https://example.com/m.woff2") }' +
        ':root { --body-font: Maybe } .used { font-family: var(--body-font) }',
    )

    expect(pruned).toContain('font-family: Maybe')
  })

  it('keeps at-rules that have no selector to test', async () => {
    const pruned = await prune(
      '@keyframes spin { to { transform: rotate(1turn) } }' +
        '@property --n { syntax: "<number>"; inherits: false; initial-value: 0 }',
    )

    expect(pruned).toContain('@keyframes spin')
    expect(pruned).toContain('@property --n')
  })
})
