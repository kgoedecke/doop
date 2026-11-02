// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildLayerTree, isElementHidden, setElementHidden } from '../src/lib/layers'

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`
const P = 'p:nth-of-type(1)'

describe('setElementHidden', () => {
  it('marks the element and switches it off inline, so every renderer agrees', () => {
    const html = setElementHidden(page('<p>hello</p>'), P, true)
    expect(html).toContain('data-doop-hidden="true"')
    expect(html).toMatch(/<p[^>]*style="display: none !important;?"/)
    expect(isElementHidden(html!, P)).toBe(true)
  })

  it('remembers an inline display and puts it back on show', () => {
    const hidden = setElementHidden(page('<p style="display: flex; color: red">hello</p>'), P, true)!
    expect(hidden).toContain('data-doop-display="flex"')
    expect(hidden).toMatch(/<p[^>]*style="[^"]*display: none !important/)
    expect(hidden).toContain('color: red')
    const shown = setElementHidden(hidden, P, false)!
    expect(shown).not.toContain('data-doop')
    expect(shown).toMatch(/<p style="display: flex; color: red;?">hello<\/p>/)
    expect(isElementHidden(shown, P)).toBe(false)
  })

  it('keeps an inline display’s !important through hide and show', () => {
    const hidden = setElementHidden(page('<p style="display: flex !important">hello</p>'), P, true)!
    expect(hidden).toContain('data-doop-display="flex !important"')
    const shown = setElementHidden(hidden, P, false)!
    expect(shown).not.toContain('data-doop')
    expect(shown).toMatch(/<p style="display: flex !important;?">hello<\/p>/)
  })

  it('leaves no empty style attribute behind', () => {
    const hidden = setElementHidden(page('<p>hello</p>'), P, true)!
    const shown = setElementHidden(hidden, P, false)!
    expect(shown).toContain('<p>hello</p>')
  })

  it('hands the input back when the element is already in that state', () => {
    const html = page('<p>hello</p>')
    expect(setElementHidden(html, P, false)).toBe(html)
    const hidden = setElementHidden(html, P, true)!
    expect(setElementHidden(hidden, P, true)).toBe(hidden)
  })

  it('returns null when the selector no longer resolves', () => {
    expect(setElementHidden(page('<p>hello</p>'), 'section:nth-of-type(1)', true)).toBeNull()
    expect(isElementHidden(page('<p>hello</p>'), 'section:nth-of-type(1)')).toBeNull()
  })

  it('shows up on the layer tree as the row’s hidden flag', () => {
    const html = setElementHidden(page('<section><p>hello</p></section><p>after</p>'), 'section:nth-of-type(1)', true)!
    const [section, after] = buildLayerTree(html)
    expect(section?.hidden).toBe(true)
    expect(section?.children[0]?.hidden).toBe(false)
    expect(after?.hidden).toBe(false)
  })
})
