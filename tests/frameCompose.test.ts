import { describe, expect, it } from 'vitest'
import { CSS_ATTR, HEAD_ATTR } from '../shared/components.ts'
import { TOKEN_BLOCK_ATTR, tokensCss, withTokenBlock, type DesignToken } from '../shared/designTokens.ts'
import {
  componentClosure,
  composeFrame,
  composeFrameHtml,
  sourceOf,
  stripSharedBlocks,
  syncComponentHead,
  type FrameResources,
  type SharedComponent,
} from '../shared/frameCompose.ts'

/**
 * A frame's stored HTML is its source; the canvas's component stylesheets, the
 * head tags components brought and the token block are composed in where a
 * document is rendered, and stripped where one comes back. The pair, at string
 * level: round trips, the placement the write pipeline always used, and the
 * components that are special (hollow, deleted, nested).
 */

function token(name: string, value: string, order = 0): DesignToken {
  return { name, type: 'color', value, order, updatedAt: 0, updatedBy: 'test' }
}

function component(id: string, extra: Partial<SharedComponent> = {}): SharedComponent {
  return {
    id,
    name: id,
    template: `<div data-doop-part="a" class="${id}"></div>`,
    css: `:where([data-doop-instance="${id}"]).${id}{color:var(--ink)}`,
    head: [],
    ...extra,
  }
}

const TOKENS = [token('--ink', '#111', 1), token('--paper', '#fff', 2), token('--unused', 'red', 3)]
const BUTTON = component('cbutton')
const CARD = component('ccard', {
  template: '<div data-doop-part="a" class="ccard"><doop-use component="cbutton" data-doop-part="b"></doop-use></div>',
  css: ':where([data-doop-instance="ccard"]).ccard{background:var(--paper)}',
  head: ['<link rel="stylesheet" href="https://fonts.example/inter.css">'],
})
const RESOURCES: FrameResources = { tokens: TOKENS, themes: [], components: [BUTTON, CARD] }

const instance = (id: string) => `<div data-doop-instance="${id}" data-doop-rev="1" class="${id}">x</div>`

const DOCUMENTS = {
  full: `<!doctype html><html><head><title>t</title><style>body{color:var(--ink)}</style></head><body>${instance('ccard')}</body></html>`,
  headOnly: `<head><style>a{color:var(--paper)}</style></head>${instance('cbutton')}`,
  noHead: `<!doctype html><html><body style="color:var(--ink)">${instance('cbutton')}</body></html>`,
  bodyOnly: `<body>${instance('cbutton')}</body>`,
  fragment: `<div style="color:var(--ink)">${instance('cbutton')}</div>`,
  plain: '<!doctype html><html><head></head><body><p>nothing shared</p></body></html>',
}

/** What every frame write did before the pair existed: the components pass, then the tokens. */
function asWritten(html: string, resources: FrameResources): string {
  const used = componentClosure(
    [...html.matchAll(/\sdata-doop-instance="([^"]+)"/g)].map((match) => match[1]!),
    resources.components,
  )
  return withTokenBlock(syncComponentHead(html, used), resources.tokens, resources.themes)
}

describe('composeFrameHtml', () => {
  it.each(Object.entries(DOCUMENTS))('places the blocks where a frame write always has: %s', (_name, html) => {
    expect(composeFrameHtml(html, RESOURCES)).toBe(asWritten(html, RESOURCES))
  })

  it('puts the token block first in the head and the component stylesheets last', () => {
    const composed = composeFrameHtml(DOCUMENTS.full, RESOURCES)
    const head = composed.slice(composed.indexOf('<head>'), composed.indexOf('</head>'))
    expect(head.startsWith(`<head><style ${TOKEN_BLOCK_ATTR}>`)).toBe(true)
    expect(head.endsWith(`<style ${CSS_ATTR}="ccard">\n${CARD.css}\n</style>\n`)).toBe(true)
    /* the frame's own sheet sits between them: the cascade order of a written frame */
    expect(head.indexOf('body{color:var(--ink)}')).toBeGreaterThan(head.indexOf(TOKEN_BLOCK_ATTR))
    expect(head.indexOf('body{color:var(--ink)}')).toBeLessThan(head.indexOf(CSS_ATTR))
  })

  it('carries the tokens its components name, and only the tokens it names', () => {
    const composed = composeFrameHtml(DOCUMENTS.bodyOnly, RESOURCES)
    /* the frame names no token itself: --ink comes through the button's rules */
    expect(composed).toContain(`<style ${TOKEN_BLOCK_ATTR}>${tokensCss([TOKENS[0]!])}</style>`)
    expect(composed).not.toContain('--unused')
  })

  it('brings a nested component along, dependencies first, with the head tags it relies on', () => {
    const composed = composeFrameHtml(DOCUMENTS.full, RESOURCES)
    expect(composed.indexOf(`${CSS_ATTR}="cbutton"`)).toBeGreaterThan(-1)
    expect(composed.indexOf(`${CSS_ATTR}="cbutton"`)).toBeLessThan(composed.indexOf(`${CSS_ATTR}="ccard"`))
    expect(composed).toContain(`<link ${HEAD_ATTR} rel="stylesheet" href="https://fonts.example/inter.css">`)
  })

  it('does not repeat a head tag the frame has of its own', () => {
    const own = DOCUMENTS.full.replace('<title>t</title>', CARD.head[0]!)
    expect(composeFrameHtml(own, RESOURCES)).not.toContain(HEAD_ATTR)
  })

  it('leaves a document that uses nothing shared exactly as it is', () => {
    expect(composeFrameHtml(DOCUMENTS.plain, RESOURCES)).toBe(DOCUMENTS.plain)
  })

  it.each(Object.entries(DOCUMENTS))('is idempotent: %s', (_name, html) => {
    const once = composeFrameHtml(html, RESOURCES)
    expect(composeFrameHtml(once, RESOURCES)).toBe(once)
  })

  it('replaces stale blocks, never doubles them', () => {
    const before: FrameResources = {
      tokens: [token('--ink', 'hotpink', 1), token('--paper', 'black', 2)],
      themes: [],
      components: [
        { ...BUTTON, css: '.old{}' },
        { ...CARD, css: '.older{}', head: ['<script src="https://cdn.tailwindcss.com"></script>'] },
      ],
    }
    const fat = composeFrameHtml(DOCUMENTS.full, before)
    expect(fat).toContain('hotpink')
    const composed = composeFrameHtml(fat, RESOURCES)
    expect(composed).toBe(composeFrameHtml(sourceOf(fat, before.components), RESOURCES))
    expect(composed).toBe(composeFrameHtml(DOCUMENTS.full, RESOURCES))
    expect(composed).not.toContain('hotpink')
    expect(composed).not.toContain('.old{}')
    expect(composed).not.toContain('tailwindcss')
    expect(composed.match(new RegExp(TOKEN_BLOCK_ATTR, 'g'))).toHaveLength(1)
    expect(composed.match(new RegExp(`${CSS_ATTR}="cbutton"`, 'g'))).toHaveLength(1)
  })

  it('drops the blocks of a component the document no longer uses', () => {
    const fat = composeFrameHtml(DOCUMENTS.full, RESOURCES)
    const without = fat.replace(instance('ccard'), '<p>plain</p>')
    const composed = composeFrameHtml(without, RESOURCES)
    expect(composed).not.toContain(CSS_ATTR)
    expect(composed).not.toContain(HEAD_ATTR)
  })

  it('still supplies the stylesheet of a deleted component: its instances keep their look', () => {
    const deleted = { ...BUTTON, status: 'deleted' as const }
    const composed = composeFrameHtml(DOCUMENTS.bodyOnly, { ...RESOURCES, components: [deleted, CARD] })
    expect(composed).toContain(`<style ${CSS_ATTR}="cbutton">`)
  })

  it('a streaming document gets nothing until its top has settled', () => {
    const half = `<!doctype html><ht`
    expect(composeFrameHtml(`${half}${instance('cbutton')}`, RESOURCES, { partial: true })).toBe(
      `${half}${instance('cbutton')}`,
    )
    const settled = `<!doctype html><html><head><title>t</title></head><body>${instance('cbutton')}`
    expect(composeFrameHtml(settled, RESOURCES, { partial: true })).toBe(asWritten(settled, RESOURCES))
  })
})

describe('stripSharedBlocks', () => {
  it.each(Object.entries(DOCUMENTS))('undoes a composition of a stored source: %s', (_name, html) => {
    /* a stored source is what a write leaves: the first strip of its composition */
    const source = sourceOf(composeFrameHtml(html, RESOURCES), RESOURCES.components)
    expect(sourceOf(composeFrameHtml(source, RESOURCES), RESOURCES.components)).toBe(source)
    expect(source).not.toContain(TOKEN_BLOCK_ATTR)
    expect(source).not.toContain(CSS_ATTR)
    expect(source).not.toContain(HEAD_ATTR)
  })

  it.each(['full', 'headOnly', 'plain'] as const)('is exact for a document with a head: %s', (name) => {
    const html = DOCUMENTS[name]
    expect(stripSharedBlocks(composeFrameHtml(html, RESOURCES))).toBe(html)
  })

  it('is exact for the token block wherever it went', () => {
    const tokensOnly: FrameResources = { ...RESOURCES, components: [] }
    for (const html of ['<p style="color:var(--ink)">x</p>', '<!doctype html><p style="color:var(--ink)">x</p>']) {
      const composed = composeFrameHtml(html, tokensOnly)
      expect(composed).toContain(TOKEN_BLOCK_ATTR)
      expect(stripSharedBlocks(composed)).toBe(html)
    }
  })

  it('takes out the blocks as a browser serializes them', () => {
    const serialized =
      '<!doctype html>\n<html><head><style data-doop-tokens="">:root{--ink:#111}</style>' +
      '<link data-doop-component-head="" rel="stylesheet" href="https://fonts.example/inter.css">\n' +
      '<script data-doop-component-head="" src="https://cdn.tailwindcss.com"></script>\n' +
      `<style ${CSS_ATTR}="cbutton">\n.x{}\n</style>\n</head><body>${instance('cbutton')}</body></html>`
    expect(stripSharedBlocks(serialized)).toBe(
      `<!doctype html>\n<html><head></head><body>${instance('cbutton')}</body></html>`,
    )
  })

  it('leaves the frame’s own material alone', () => {
    const own =
      '<head><style data-doop-fonts>@font-face{font-family:X}</style>' +
      '<link rel="stylesheet" data-doop-webfonts href="https://fonts.googleapis.com/css2?family=Inter">' +
      '<style data-doop-detached-css="cbutton.1">.d{}</style><style>.mine{color:var(--ink)}</style></head><body></body>'
    expect(stripSharedBlocks(own)).toBe(own)
    expect(stripSharedBlocks(composeFrameHtml(own, RESOURCES))).toBe(own)
  })

  it('returns the input itself when there is nothing to take out', () => {
    expect(stripSharedBlocks(DOCUMENTS.plain)).toBe(DOCUMENTS.plain)
  })
})

describe('a hollow component', () => {
  /* a definition that lost its markup has no stylesheet to give back: the copy an
     instance's frame holds is the only one, so it stays in the frame */
  const hollow = component('chollow', { template: '', css: '' })
  const resources: FrameResources = { ...RESOURCES, components: [hollow, BUTTON] }
  const kept = `<style ${CSS_ATTR}="chollow">\n.kept{}\n</style>\n`
  const html = `<head>${kept}</head><body>${instance('chollow')}${instance('cbutton')}</body>`

  it('keeps its stylesheet in the source', () => {
    const source = sourceOf(composeFrameHtml(html, resources), resources.components)
    expect(source).toContain(kept)
    expect(source).not.toContain(`${CSS_ATTR}="cbutton"`)
  })

  it('composes with the stylesheet it has, beside the others', () => {
    const composed = composeFrameHtml(html, resources)
    expect(composed).toContain(kept)
    expect(composed).toContain(`${CSS_ATTR}="cbutton"`)
    expect(composeFrameHtml(composed, resources)).toBe(composed)
  })
})

describe('composeFrame', () => {
  it('names what the canvas supplied, the same for any source that takes the same', () => {
    const one = composeFrame(DOCUMENTS.bodyOnly, RESOURCES)
    const other = composeFrame(DOCUMENTS.bodyOnly.replace('>x<', '>edited<'), RESOURCES)
    expect(one.html).toBe(composeFrameHtml(DOCUMENTS.bodyOnly, RESOURCES))
    expect(other.shared).toBe(one.shared)
  })

  it('changes with a token the frame names and not with one it does not', () => {
    const base = composeFrame(DOCUMENTS.bodyOnly, RESOURCES)
    const unrelated = RESOURCES.tokens.map((t) => (t.name === '--unused' ? { ...t, value: 'blue' } : t))
    expect(composeFrame(DOCUMENTS.bodyOnly, { ...RESOURCES, tokens: unrelated })).toEqual(base)
    const named = RESOURCES.tokens.map((t) => (t.name === '--ink' ? { ...t, value: 'blue' } : t))
    expect(composeFrame(DOCUMENTS.bodyOnly, { ...RESOURCES, tokens: named }).shared).not.toBe(base.shared)
  })

  it('changes with the stylesheet of a component the frame uses', () => {
    const base = composeFrame(DOCUMENTS.bodyOnly, RESOURCES)
    const restyled = { ...RESOURCES, components: [{ ...BUTTON, css: '.new{}' }, CARD] }
    expect(composeFrame(DOCUMENTS.bodyOnly, restyled).shared).not.toBe(base.shared)
    const other = { ...RESOURCES, components: [BUTTON, { ...CARD, css: '.new{}' }] }
    expect(composeFrame(DOCUMENTS.bodyOnly, other)).toEqual(base)
  })
})
