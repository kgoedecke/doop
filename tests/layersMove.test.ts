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

  it('puts a canvas drop in layout flow while preserving dimensions and transforms', () => {
    const html = page(
      '<div><img style="position:absolute;left:40px;top:20px;translate:10px 20px;transform:rotate(15deg);width:80px;height:60px"></div><section></section>',
    )
    const result = moveElement(html, 'img', { selector: 'section', place: 'inside' }, { order: '0' })!
    const doc = new DOMParser().parseFromString(result.html, 'text/html')
    const image = doc.querySelector('section > img') as HTMLImageElement
    expect(image.style.position).toBe('relative')
    expect(image.style.translate).toBe('none')
    expect(image.style.getPropertyPriority('position')).toBe('important')
    expect(image.style.transform).toBe('rotate(15deg)')
    expect(image.style.width).toBe('80px')
    expect(image.style.height).toBe('60px')
    expect(doc.querySelector(result.selector)).toBe(image)
  })

  it('keeps Layers panel moves from rewriting authored layout styles', () => {
    const result = moveElement(page('<img style="position:absolute;left:40px"><section></section>'), 'img', {
      selector: 'section',
      place: 'inside',
    })
    expect(result?.html).toContain('<section><img style="position:absolute;left:40px"></section>')
  })

  it('refuses locked destinations, cycles, and invalid HTML on canvas drops', () => {
    const locked = page('<div data-doop-locked><section><p>Child</p></section></div><img>')
    expect(moveElement(locked, 'img', { selector: 'section', place: 'inside' }, { order: '0' })).toBeNull()
    expect(moveElement(locked, 'img', { selector: 'p', place: 'before' }, { order: '0' })).toBeNull()
    expect(
      moveElement(
        page('<div><section></section></div>'),
        'div',
        { selector: 'section', place: 'inside' },
        { order: '0' },
      ),
    ).toBeNull()
    expect(
      moveElement(page('<p>Text</p><div>Box</div>'), 'div', { selector: 'p', place: 'inside' }, { order: '0' }),
    ).toBeNull()
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
