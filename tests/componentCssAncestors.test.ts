import { describe, expect, it } from 'vitest'
import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes as Tree } from 'parse5'
import { extractComponentCss, unmatchedSelectors } from '../server/componentCss.ts'

/*
 * A main's CSS is how it looks where it sits: a rule reaching it through an ancestor
 * (`.login__card h2`) loses that ancestor, as the main always has it. Agent report
 * (2026-11-11): the ancestor was dropped without asking whether the main had it, so a header
 * made a component took `.login__card h2 {font-size:36px}` from a card elsewhere in the frame,
 * as a bare `h2` rule.
 */
function mainIn(html: string, marker = 'data-main'): Tree.Element {
  const stack: Tree.Node[] = [parse(html)]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if ('tagName' in node && node.attrs.some((attr) => attr.name === marker)) return node
    if ('childNodes' in node) stack.push(...node.childNodes)
  }
  throw new Error('no main')
}

const SHEET = `
.login__hero p { font-size: 18px }
.login__card h2 { font-size: 36px }
.site-header h2 { letter-spacing: 1px }
.site-header > .bar a { color: gold }
.elsewhere > .bar a { color: red }
[data-doop-theme="dark"] .bar { background: black }
.bar:hover a { text-decoration: underline }
`

const FRAME = `<!doctype html><html><head></head><body>
<div class="site-header"><header class="bar" data-main><h2>Brand</h2><a href="#">Home</a><p>Tag</p></header></div>
<section class="login__hero"><p>Hero</p></section>
<div class="login__card"><h2>Sign in</h2></div>
</body></html>`

describe('a main taking CSS from its frame', () => {
  const { css, rawCss } = extractComponentCss(SHEET, mainIn(FRAME), 'cmp')

  it('leaves behind rules that reach it only through ancestors it does not have', () => {
    expect(rawCss).not.toContain('36px')
    expect(rawCss).not.toContain('18px')
    expect(rawCss).not.toContain('red')
  })

  it('keeps rules through the ancestors it has, as how it looks there', () => {
    expect(rawCss).toContain('letter-spacing: 1px')
    expect(rawCss).toContain('color: gold')
    expect(rawCss).toContain('text-decoration: underline')
    expect(css).not.toContain('.site-header')
  })

  it('keeps a theme condition on the document as a condition', () => {
    expect(rawCss).toMatch(/\[data-doop-theme="dark"\] \.bar\s*\{/)
    expect(css).toMatch(/\[data-doop-theme="dark"\] :where\(\[data-doop-instance="cmp"\]\)/)
  })

  it('reports the rules it left behind', () => {
    expect(unmatchedSelectors(SHEET, mainIn(FRAME))).toEqual(
      expect.arrayContaining(['.login__hero p', '.login__card h2', '.elsewhere > .bar a']),
    )
  })

  it('reads a document condition by its value: a light page keeps the dark rule conditional', () => {
    const light = FRAME.replace('<html>', '<html data-doop-theme="light">')
    const result = extractComponentCss(SHEET, mainIn(light), 'cmp')
    expect(result.rawCss).toMatch(/\[data-doop-theme="dark"\] \.bar\s*\{/)
    expect(result.rawCss).not.toMatch(/(^|\n)\.bar\s*\{\s*background: black/)
  })

  it('takes `>` as the parent only, not an ancestor further out', () => {
    const sheet = '.outer > .bar a { color: teal }\n.outer .bar a { color: navy }'
    const nested =
      '<!doctype html><html><head></head><body><div class="outer"><div class="mid"><header class="bar" data-main><a>x</a></header></div></div></body></html>'
    const { rawCss } = extractComponentCss(sheet, mainIn(nested), 'cmp')
    expect(rawCss).not.toContain('teal')
    expect(rawCss).toContain('navy')
  })

  describe('matching ancestors as the browser does', () => {
    const page = (wrap: (main: string) => string, html = '<html>') =>
      `<!doctype html>${html}<head></head><body>${wrap('<header class="bar" data-main><a>x</a></header>')}</body></html>`
    const kept = (sheet: string, frame: string) => extractComponentCss(sheet, mainIn(frame), 'cmp').rawCss

    it('tries a farther ancestor when the nearest one of the same kind does not fit', () => {
      const frame = page(
        (main) =>
          `<div class="outer"><div class="mid"><div class="wrapper"><div class="mid">${main}</div></div></div></div>`,
      )
      expect(kept('.outer > .mid .bar a { color: teal }', frame)).toContain('teal')
    })

    it('reads an attribute inside :not() as a condition, not a requirement', () => {
      const frame = page((main) => `<div class="outer">${main}</div>`)
      expect(kept('.outer:not([data-state="closed"]) .bar a { color: teal }', frame)).toContain('teal')
    })

    it('decodes an escaped attribute value', () => {
      const frame = page((main) => `<div data-label="foo:bar">${main}</div>`)
      expect(kept('[data-label="foo\\:bar"] .bar a { color: teal }', frame)).toContain('teal')
    })

    it('compares a case-insensitive HTML attribute without the i flag', () => {
      const frame = page((main) => `<form method="POST">${main}</form>`)
      expect(kept('form[method="post"] .bar a { color: teal }', frame)).toContain('teal')
    })

    it('counts a hover on an ancestor as a state the main is in some of the time', () => {
      const frame = page((main) => `<nav class="menu">${main}</nav>`)
      expect(kept('.menu:hover .bar a { color: teal }', frame)).toContain('teal')
    })

    it('keeps a rule for when an ancestor is not hovered, as well as for when it is', () => {
      const frame = page((main) => `<nav class="menu">${main}</nav>`)
      expect(kept('.menu:not(:hover) .bar a { color: teal }', frame)).toContain('teal')
    })

    it('leaves a quoted value that reads like a state alone', () => {
      const frame = page((main) => `<div data-label="search:focus">${main}</div>`)
      expect(kept('[data-label="search:focus"] .bar a { color: teal }', frame)).toContain('teal')
    })

    it('keeps a theme condition set on a part of the page, and cuts the wrapper around it', () => {
      const frame = page((main) => `<div class="shell"><div data-doop-theme="light">${main}</div></div>`)
      const css = kept('.shell [data-doop-theme="dark"] .bar a { color: teal }', frame)
      expect(css).toMatch(/(^|\n)\[data-doop-theme="dark"\] \.bar a\s*\{/)
    })

    it('still leaves a themed rule behind when the rest of what it names is not there', () => {
      const frame = page((main) => `<div data-doop-theme="light">${main}</div>`)
      expect(kept('.elsewhere [data-doop-theme="dark"] .bar a { color: teal }', frame)).not.toContain('teal')
    })

    it('keeps a rule whose ancestor state is grouped in :is()', () => {
      const frame = page((main) => `<nav class="menu">${main}</nav>`)
      expect(kept('.menu:is(:hover, :focus-within) .bar a { color: teal }', frame)).toContain('teal')
    })

    it('keeps a dark rule on the document without the wrapper the main sat in', () => {
      const frame = page((main) => `<div class="outer">${main}</div>`, '<html class="light">')
      const css = kept('html.dark .outer .bar a { color: teal }', frame)
      expect(css).toMatch(/(^|\n)html\.dark \.bar a\s*\{/)
    })

    it('keeps what :not() excludes for good when it lets go of a state', () => {
      const frame = page((main) => `<nav class="menu disabled">${main}</nav>`)
      expect(kept('.menu:not(.disabled, :hover) .bar a { color: teal }', frame)).not.toContain('teal')
    })

    it('keeps a direct relationship between two themes', () => {
      const frame = page((main) => `<div data-doop-theme="light"><div data-doop-theme="light">${main}</div></div>`)
      const css = kept('[data-doop-theme="dark"] > [data-doop-theme="light"] .bar a { color: teal }', frame)
      expect(css).toMatch(/\[data-doop-theme="dark"\] > \[data-doop-theme="light"\] \.bar a/)
    })

    it('does not turn an exclusion that names a state into one that always holds', () => {
      const frame = page((main) => `<nav class="menu disabled">${main}</nav>`)
      expect(kept('.menu:not(.disabled:hover, :focus) .bar a { color: teal }', frame)).toContain('teal')
    })

    it('keeps a static exclusion however its nested list is spaced', () => {
      const frame = page((main) => `<nav class="menu disabled">${main}</nav>`)
      expect(kept('.menu:not(:is(.disabled,.hidden)) .bar a { color: teal }', frame)).not.toContain('teal')
    })
  })
})
