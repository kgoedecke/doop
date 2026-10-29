import { describe, expect, it } from 'vitest'
import { elementIdAt, hasElementId, stampElementId } from '../server/elementIds.ts'
import { elementIdOf, elementIdSelector, isElementId, newElementId } from '../shared/elementId.ts'

/**
 * Stamping `data-doop-id` into frame HTML from the positional selector the
 * frame runtime answers a click with. The attribute is written by source
 * offset, so the rest of the document comes through byte for byte.
 */

const HTML = `<!doctype html>
<html><head><style>p { color: red }</style></head>
<body>
  <main class="hero">
    <h1>Title</h1>
    <p>First</p>
    <p class="lead" data-x='1'>Second</p>
    <img src="a.png"/>
  </main>
  <section id="price:usd"><button>Buy</button></section>
</body></html>`

describe('element ids', () => {
  it('are six lowercase alphanumerics', () => {
    const id = newElementId()
    expect(isElementId(id)).toBe(true)
    expect(elementIdOf(elementIdSelector(id))).toBe(id)
    expect(elementIdOf('#id')).toBeNull()
    expect(isElementId('ABCDEF')).toBe(false)
    expect(isElementId('abcde')).toBe(false)
  })
})

describe('stampElementId', () => {
  it('writes the attribute into the start tag the runtime path names and nothing else', () => {
    const path = 'body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(2)'
    const out = stampElementId(HTML, path, { id: 'abc123' })!
    expect(out.id).toBe('abc123')
    expect(out.html).toBe(
      HTML.replace(`<p class="lead" data-x='1'>`, `<p class="lead" data-x='1' data-doop-id="abc123">`),
    )
    expect(elementIdAt(out.html, path)).toBe('abc123')
    expect(hasElementId(out.html, 'abc123')).toBe(true)
    expect(hasElementId(HTML, 'abc123')).toBe(false)
  })

  it('keeps the id an element already carries', () => {
    const once = stampElementId(HTML, 'body > main > h1', { id: 'first0' })!
    const twice = stampElementId(once.html, 'body > main > h1', { id: 'second' })!
    expect(twice.id).toBe('first0')
    expect(twice.html).toBe(once.html)
    /* and finds it back by its own selector */
    expect(stampElementId(once.html, elementIdSelector('first0'))?.id).toBe('first0')
  })

  it('resolves paths from an escaped id and self-closing tags', () => {
    const fromId = stampElementId(HTML, '#price\\:usd > button:nth-of-type(1)', { id: 'buy000' })!
    expect(fromId.html).toContain('<button data-doop-id="buy000">Buy</button>')
    const img = stampElementId(HTML, 'body > main > img', { id: 'img000' })!
    expect(img.html).toContain('<img src="a.png" data-doop-id="img000"/>')
  })

  it('resolves a path given from inside the body, as other clients send it', () => {
    expect(stampElementId(HTML, 'main > p:nth-of-type(1)', { id: 'p00001' })?.html).toContain(
      '<p data-doop-id="p00001">First</p>',
    )
  })

  it('refuses what is not there: a drifted path, a missing id, a selector it does not know, an implied tag', () => {
    expect(stampElementId(HTML, 'body > main > p:nth-of-type(3)')).toBeUndefined()
    expect(stampElementId(HTML, '#nope > p')).toBeUndefined()
    expect(stampElementId(HTML, '.hero p')).toBeUndefined()
    expect(stampElementId(HTML, '[invalid')).toBeUndefined()
    expect(stampElementId('<p>no body tag</p>', 'body')).toBeUndefined()
    expect(stampElementId(HTML, elementIdSelector('zzzzzz'))).toBeUndefined()
  })

  it('stamps a fragment without a document shell the way the browser parses it', () => {
    const out = stampElementId('<h1>Hi</h1><p>There</p>', 'body:nth-of-type(1) > p:nth-of-type(1)', { id: 'frag00' })!
    expect(out.html).toBe('<h1>Hi</h1><p data-doop-id="frag00">There</p>')
  })

  it('replaces a malformed id instead of doubling the attribute, however it was spelled', () => {
    const out = stampElementId('<p data-doop-id="BAD">x</p>', 'body > p', { id: 'good00' })!
    expect(out.html).toBe('<p data-doop-id="good00">x</p>')
    const shouted = stampElementId('<p class="a" DATA-DOOP-ID = BAD title="t">x</p>', 'body > p', { id: 'good00' })!
    expect(shouted.html).toBe('<p class="a" title="t" data-doop-id="good00">x</p>')
  })

  it('does not throw on an escape past Unicode or on deeply nested markup', () => {
    expect(stampElementId(HTML, '#\\ffffff > p')).toBeUndefined()
    const deep = '<div>'.repeat(20_000) + '<p id="x">bottom</p>' + '</div>'.repeat(20_000)
    expect(stampElementId(deep, '#x', { id: 'deep00' })?.html).toContain('<p id="x" data-doop-id="deep00">')
  })

  it('goes after the last attribute, so an unquoted value ending in a slash keeps it', () => {
    const out = stampElementId('<p><img src=/assets/logo/></p>', 'body > p > img', { id: 'img001' })!
    expect(out.html).toBe('<p><img src=/assets/logo/ data-doop-id="img001"></p>')
    const bare = stampElementId('<p><br/></p>', 'body > p > br', { id: 'br0000' })!
    expect(bare.html).toBe('<p><br data-doop-id="br0000"/></p>')
  })

  it('matches an unchanged SVG element whose attributes carry a namespace or camel case', () => {
    const svg = '<svg><use xlink:href="#icon"></use><text textLength="40">Hi</text></svg>'
    expect(stampElementId(svg, 'body > svg > use', { like: '<use xlink:href="#icon"></use>' })).toBeDefined()
    expect(stampElementId(svg, 'body > svg > text', { like: '<text textLength="40">Hi</text>' })).toBeDefined()
    expect(stampElementId(svg, 'body > svg > use', { like: '<use xlink:href="#other"></use>' })).toBeUndefined()
  })

  it('with two stale attributes, either puts the new id first or refuses', () => {
    /* a parser keeps the first of duplicate attributes: the stamp takes the
       first one's place, so it wins… */
    expect(stampElementId('<p data-doop-id="BAD" data-doop-id="OTHER">x</p>', 'body > p', { id: 'new000' })?.html).toBe(
      '<p data-doop-id="new000" data-doop-id="OTHER">x</p>',
    )
    /* …unless another attribute pushes it behind the duplicate, in which
       case the output is checked and the stamp refused rather than returned
       as an id nothing resolves */
    expect(stampElementId('<p data-doop-id="BAD" data-doop-id="OTHER" class="a">x</p>', 'body > p')).toBeUndefined()
  })

  it('finds an existing id however the attribute is quoted or cased', () => {
    for (const html of [
      "<p data-doop-id='abc123'>x</p>",
      '<p data-doop-id=abc123>x</p>',
      '<p DATA-DOOP-ID="abc123">x</p>',
    ]) {
      expect(hasElementId(html, 'abc123')).toBe(true)
      expect(stampElementId(html, 'body > p')?.id).toBe('abc123')
    }
  })

  it('splits a path only on unescaped child separators', () => {
    const html = '<div id="a>b"><span>in</span></div>'
    const out = stampElementId(html, '#a\\>b > span:nth-of-type(1)', { id: 'span00' })!
    expect(out.html).toBe('<div id="a>b"><span data-doop-id="span00">in</span></div>')
  })

  it('refuses a path whose saved element is not the one the live document described', () => {
    /* a script put another paragraph first: the live p:nth-of-type(1) is not the saved one */
    const path = 'body > main > p:nth-of-type(1)'
    expect(stampElementId(HTML, path, { like: '<p class="fresh">Injected</p>' })).toBeUndefined()
    expect(stampElementId(HTML, path, { like: '<span>First</span>' })).toBeUndefined()
    /* the same element, with the runtime's own markers on it, passes */
    expect(stampElementId(HTML, path, { like: '<p data-v-hover="1">First</p>', id: 'p00001' })?.id).toBe('p00001')
    expect(
      stampElementId(HTML, 'body > main > p:nth-of-type(2)', { like: `<p class="lead" data-x="1">Second</p>` }),
    ).toBeDefined()
    /* an excerpt cut before its start tag closed cannot vouch either way */
    expect(stampElementId(HTML, path, { like: '<p class="fres' })).toBeDefined()
  })
})
