import { describe, expect, it } from 'vitest'
import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes as Tree } from 'parse5'
import { extractComponentCss, unmatchedSelectors } from '../server/componentCss.ts'

/*
 * A state the main is not in when it is made (`[open]` on a `<details>`, an `.is-on` class a
 * script toggles) is still the main's own: the rule is how it looks in that state. #517: such
 * selectors were taken for ancestors outside the main, found on none, and the rule dropped and
 * reported as naming nothing, while `.card:hover .light` was kept.
 */
function mainIn(html: string): Tree.Element {
  const stack: Tree.Node[] = [parse(html)]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if ('tagName' in node && node.attrs.some((attr) => attr.name === 'data-main')) return node
    if ('childNodes' in node) stack.push(...node.childNodes)
  }
  throw new Error('no main')
}

const frame = (main: string) => `<!doctype html><html><head></head><body><div class="page">${main}</div></body></html>`

const SCOPE = ':where([data-doop-instance="cmp"])'

describe('a main taking rules for states it is not in yet', () => {
  it('keeps an attribute state on its root, as a condition', () => {
    const sheet = '.faq-row[open] summary::after { content: "−" }'
    const root = mainIn(frame('<details class="faq-row" data-main><summary>Q</summary><p>A</p></details>'))
    const { css, rawCss } = extractComponentCss(sheet, root, 'cmp')
    expect(rawCss).toContain('.faq-row[open] summary::after {')
    expect(css).toContain(`.faq-row[open]${SCOPE} summary::after`)
    expect(unmatchedSelectors(sheet, root)).toEqual([])
  })

  it('keeps an attribute state on a bare tag', () => {
    const sheet = 'details[open] > summary { font-weight: 600 }'
    const root = mainIn(frame('<details class="faq-row" data-main><summary>Q</summary><p>A</p></details>'))
    const { css, rawCss } = extractComponentCss(sheet, root, 'cmp')
    expect(rawCss).toContain('details[open] > summary {')
    expect(css).toContain(`details[open]${SCOPE} > summary`)
    expect(unmatchedSelectors(sheet, root)).toEqual([])
  })

  it('keeps a class state, as a condition', () => {
    const sheet = '.card.is-on .light { background: lime }'
    const root = mainIn(frame('<div class="card" data-main><span class="light"></span></div>'))
    const { css, rawCss } = extractComponentCss(sheet, root, 'cmp')
    expect(rawCss).toContain('.card.is-on .light {')
    expect(css).toContain(`.card.is-on${SCOPE} .light`)
    expect(rawCss).not.toMatch(/(^|\n)\.light\s*\{/)
    expect(unmatchedSelectors(sheet, root)).toEqual([])
  })

  it('keeps a state on the subject itself', () => {
    const sheet = '.light.is-on { background: lime }'
    const root = mainIn(frame('<div class="card" data-main><span class="light"></span></div>'))
    expect(extractComponentCss(sheet, root, 'cmp').rawCss).toContain('.light.is-on {')
    expect(unmatchedSelectors(sheet, root)).toEqual([])
  })

  it('still keeps a pseudo-class state', () => {
    const sheet = '.card:hover .light { background: lime }'
    const root = mainIn(frame('<div class="card" data-main><span class="light"></span></div>'))
    expect(extractComponentCss(sheet, root, 'cmp').rawCss).toContain('.card:hover .light {')
    expect(unmatchedSelectors(sheet, root)).toEqual([])
  })

  it('cuts an ancestor the main has before reading a state', () => {
    const sheet = '.page .card.is-on .light { background: lime }'
    const root = mainIn(frame('<div class="card" data-main><span class="light"></span></div>'))
    const { rawCss } = extractComponentCss(sheet, root, 'cmp')
    expect(rawCss).toContain('.card.is-on .light {')
    expect(rawCss).not.toContain('.page')
  })

  it('still drops a rule for something the main does not have', () => {
    const sheet = '.other.is-on .light { color: red }\n.panel[open] .light { color: red }'
    const root = mainIn(frame('<div class="card" data-main><span class="light"></span></div>'))
    expect(extractComponentCss(sheet, root, 'cmp').rawCss).not.toContain('red')
    expect(unmatchedSelectors(sheet, root)).toEqual(['.other.is-on .light', '.panel[open] .light'])
  })
})
