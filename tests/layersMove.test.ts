// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildLayerTree, holdsChildren, moveElement } from '../src/lib/layers'

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

describe('moveElement', () => {
  it('moves an element into a box that can hold it', () => {
    const moved = moveElement(page('<section></section><p>hello</p>'), 'p:nth-of-type(1)', {
      selector: 'section:nth-of-type(1)',
      place: 'inside',
    })
    expect(moved?.html).toContain('<section><p>hello</p></section>')
    expect(moved?.selector).toBe('body:nth-of-type(1) > section:nth-of-type(1) > p:nth-of-type(1)')
  })

  it.each(['input', 'hr', 'textarea'])('refuses an inside drop into <%s>, which would lose the content', (tag) => {
    const html = page(`<${tag}></${tag}><p>hello</p>`)
    const moved = moveElement(html, 'p:nth-of-type(1)', { selector: `${tag}:nth-of-type(1)`, place: 'inside' })
    expect(moved).toBeNull()
  })

  it.each(['select', 'table', 'tr'])('refuses an inside drop into <%s>, whose children the parser rewrites', (tag) => {
    const html = page(`<${tag}></${tag}><p>hello</p>`)
    const moved = moveElement(html, 'p:nth-of-type(1)', { selector: `${tag}:nth-of-type(1)`, place: 'inside' })
    expect(moved).toBeNull()
  })

  it('refuses any move the saved markup would not preserve, listed or not', () => {
    /* a <p> is not on the rail's list and the DOM happily nests one in
       another, but the parser closes the outer paragraph at the inner one's
       start tag — the round-trip check is what catches a tag the list does not */
    const moved = moveElement(page('<p>outer</p><p>hello</p>'), 'p:nth-of-type(2)', {
      selector: 'p:nth-of-type(1)',
      place: 'inside',
    })
    expect(moved).toBeNull()
  })

  it('still drops next to an element that cannot hold children', () => {
    const moved = moveElement(page('<input><p>hello</p>'), 'p:nth-of-type(1)', {
      selector: 'input:nth-of-type(1)',
      place: 'before',
    })
    expect(moved?.html).toContain('<p>hello</p><input>')
  })
})

describe('holdsChildren', () => {
  it('names the elements the rail may offer an inside drop on', () => {
    expect(holdsChildren('div')).toBe(true)
    expect(holdsChildren('INPUT')).toBe(false)
    expect(holdsChildren('hr')).toBe(false)
  })

  it('classifies a void element as a box, so the guard is what stops the drop', () => {
    const [input] = buildLayerTree(page('<input>'))
    expect(input?.kind).toBe('box')
    expect(holdsChildren(input!.tag)).toBe(false)
  })
})
