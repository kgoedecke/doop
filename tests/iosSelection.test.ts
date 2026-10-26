// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('ios/Doop/SelectionDOM.js', 'utf8')
const edit = new Function(source + '; return globalThis.doopEditSelection;')() as (
  html: string,
  selector: string,
  action: string,
  markup?: string,
) => string
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const frame =
  '<html><head><style>.pill { color: red }</style></head><body><div id="group"><span class="pill">Hello</span><p>Keep me</p></div></body></html>'

describe('iOS selection actions', () => {
  it('rejects ambiguous selectors rather than acting on the first matching element', () => {
    const html = '<body><p id="same">First</p><p id="same">Second</p></body>'
    for (const action of ['copy', 'delete', 'duplicate', 'paste']) {
      expect(() => edit(html, '#same', action, '<span>Paste</span>')).toThrow('more than one element')
    }
    expect(edit(html, 'body > p:nth-of-type(2)', 'copy')).toBe('<p id="same">Second</p>')
  })

  it('copies only the selected element and deletes it without touching siblings or styles', () => {
    expect(edit(frame, '.pill', 'copy')).toBe('<span class="pill">Hello</span>')
    const result = parse(edit(frame, '.pill', 'delete'))
    expect(result.querySelector('.pill')).toBeNull()
    expect(result.querySelector('p')?.textContent).toBe('Keep me')
    expect(result.querySelector('style')?.textContent).toContain('color: red')
  })

  it('duplicates a subtree and remaps IDs, labels, SVG paints and internal links', () => {
    const html =
      '<body><section id="card"><label for="field">Name</label><input id="field"><svg><defs><linearGradient id="paint"></linearGradient></defs><rect fill="url(#paint)"></rect><use href="#paint"></use></svg><a href="#outside">External</a></section></body>'
    const result = parse(edit(html, '#card', 'duplicate'))
    const copy = result.querySelector('#card-copy')!
    expect(result.querySelectorAll('section')).toHaveLength(2)
    expect(copy.querySelector('label')?.getAttribute('for')).toBe('field-copy')
    expect(copy.querySelector('input')?.id).toBe('field-copy')
    expect(copy.querySelector('rect')?.getAttribute('fill')).toBe('url(#paint-copy)')
    expect(copy.querySelector('use')?.getAttribute('href')).toBe('#paint-copy')
    expect(copy.querySelector('a')?.getAttribute('href')).toBe('#outside')
    const second = parse(edit(result.documentElement.outerHTML, '#card', 'duplicate'))
    expect(second.querySelector('#card-copy-2')).not.toBeNull()
  })

  it('pastes after an element or into the frame body', () => {
    const result = parse(edit(frame, '.pill', 'paste', '<button>Paste</button>'))
    expect(result.querySelector('.pill')?.nextElementSibling?.textContent).toBe('Paste')
    expect(parse(edit(frame, '', 'paste', '<p>Last</p>')).body.lastElementChild?.textContent).toBe('Last')
  })

  it('preserves table and SVG contexts', () => {
    const table = parse(edit('<body><table><tbody><tr><td>A</td></tr></tbody></table></body>', 'tr', 'duplicate'))
    expect(table.querySelectorAll('tbody > tr > td')).toHaveLength(2)
    const svg = parse(edit('<body><svg><circle r="10"></circle></svg></body>', 'circle', 'duplicate'))
    expect(svg.querySelectorAll('svg > circle')).toHaveLength(2)
    expect(svg.querySelector('circle')?.namespaceURI).toBe('http://www.w3.org/2000/svg')
  })

  it('rejects missing targets, locked ancestors, document deletion and invalid paste fragments', () => {
    expect(() => edit(frame, '.missing', 'delete')).toThrow('changed')
    expect(() => edit('<body><div data-doop-locked><span>A</span></div></body>', 'span', 'duplicate')).toThrow('Unlock')
    expect(() => edit(frame, 'body', 'delete')).toThrow('Select an element')
    expect(() => edit(frame, '.pill', 'paste', '<p>One</p><p>Two</p>')).toThrow('one element')
    expect(() => edit(frame, '.pill', 'paste', 'plain text')).toThrow('one element')
  })

  it('does not execute scripts in copied or pasted markup', () => {
    const html = '<body><div><script>throw new Error("Frame script executed")</script><p>Safe</p></div></body>'
    expect(edit(html, 'div', 'duplicate')).toContain('Safe')
  })
})
