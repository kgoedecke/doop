// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildLayerTree, holdsChildren, moveElement, moveElements } from '../src/lib/layers'

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
    /* placed by its own inline styles: those go, and the flow places it */
    expect(image.getAttribute('style')).toBe('transform: rotate(15deg); width: 80px; height: 60px;')
    expect(image.style.transform).toBe('rotate(15deg)')
    expect(image.style.width).toBe('80px')
    expect(image.style.height).toBe('60px')
    expect(doc.querySelector(result.selector)).toBe(image)
  })

  it('overrides a stylesheet that places the element, which inline styles cannot remove', () => {
    const html = page('<style>img{position:absolute;left:40px}</style><div><img></div><section></section>')
    const result = moveElement(html, 'img', { selector: 'section', place: 'inside' }, { order: '0' })!
    const image = new DOMParser().parseFromString(result.html, 'text/html').querySelector('section > img')!
    expect((image as HTMLImageElement).style.position).toBe('relative')
    expect((image as HTMLImageElement).style.getPropertyPriority('position')).toBe('important')
  })

  it('places a drop into a box that places its layers by hand absolute, and drops an emptied group', () => {
    const html = page(
      '<div data-doop-drawing="group" style="display:flex"><p style="flex-shrink:0;translate:4px 2px">a</p></div><i style="position:absolute"></i>',
    )
    const result = moveElement(
      html,
      'p',
      { selector: 'i', place: 'after' },
      { order: '0', absolute: { left: 12, top: 30 } },
    )!
    expect(new DOMParser().parseFromString(result.html, 'text/html').body.innerHTML).toBe(
      '<i style="position:absolute"></i><p style="position: absolute; left: 12px; top: 30px;">a</p>',
    )
  })

  it('reorders an element already in flow with only its drag offset removed', () => {
    const html = page('<div style="display:flex"><p>a</p><p style="flex-shrink:0;translate:4px 2px">b</p></div>')
    const result = moveElement(
      html,
      'p:nth-of-type(2)',
      { selector: 'p', place: 'before' },
      { order: '0', fromFlow: true, flexItem: true },
    )!
    expect(result.html).toContain('<div style="display:flex"><p style="flex-shrink: 0;">b</p><p>a</p></div>')
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

describe('moveElements', () => {
  const body = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.innerHTML

  it('moves the elements as one run, in document order however they were picked', () => {
    const moved = moveElements(page('<p>a</p><i>x</i><p>b</p><em>y</em>'), ['p:nth-of-type(2)', 'p:nth-of-type(1)'], {
      selector: 'em',
      place: 'before',
    })!
    expect(body(moved.html)).toBe('<i>x</i><p>a</p><p>b</p><em>y</em>')
    /* the returned selectors follow the input order, primary last as given */
    const doc = new DOMParser().parseFromString(moved.html, 'text/html')
    expect(doc.querySelector(moved.selectors[0]!)?.textContent).toBe('b')
    expect(doc.querySelector(moved.selectors[1]!)?.textContent).toBe('a')
  })

  it('moves them after a target, first after it and each after the last', () => {
    const moved = moveElements(page('<i>x</i><p>a</p><p>b</p>'), ['i', 'p:nth-of-type(1)'], {
      selector: 'p:nth-of-type(2)',
      place: 'after',
    })!
    expect(body(moved.html)).toBe('<p>b</p><i>x</i><p>a</p>')
  })

  it('moves them into a box, keeping their order', () => {
    const moved = moveElements(
      page('<p>a</p><p>b</p><section><i>x</i></section>'),
      ['p:nth-of-type(1)', 'p:nth-of-type(2)'],
      {
        selector: 'section',
        place: 'inside',
      },
    )!
    expect(body(moved.html)).toBe('<section><p>a</p><p>b</p><i>x</i></section>')
  })

  it('lets a member inside another member ride along with it', () => {
    const moved = moveElements(page('<i>x</i><div><p>in</p></div>'), ['div > p', 'div'], {
      selector: 'i',
      place: 'before',
    })!
    expect(body(moved.html)).toBe('<div><p>in</p></div><i>x</i>')
    const doc = new DOMParser().parseFromString(moved.html, 'text/html')
    /* the absorbed child's path still resolves after the move */
    expect(doc.querySelector(moved.selectors[0]!)?.textContent).toBe('in')
    expect(doc.querySelector(moved.selectors[1]!)?.tagName).toBe('DIV')
  })

  it('refuses a target that is a member or sits inside one', () => {
    const html = page('<div><p>in</p></div><i>x</i><p>out</p>')
    expect(moveElements(html, ['div', 'i'], { selector: 'div > p', place: 'before' })).toBeNull()
    expect(moveElements(html, ['div', 'i'], { selector: 'div', place: 'after' })).toBeNull()
  })

  it('refuses a drop that changes nothing, a locked destination, and a missing member', () => {
    expect(
      moveElements(page('<p>a</p><p>b</p><i>x</i>'), ['p:nth-of-type(1)', 'p:nth-of-type(2)'], {
        selector: 'i',
        place: 'before',
      }),
    ).toBeNull()
    const locked = page('<div data-doop-locked><p>a</p></div><i>x</i><p>b</p>')
    expect(moveElements(locked, ['i', 'p'], { selector: 'div > p', place: 'after' })).toBeNull()
    expect(moveElements(page('<p>a</p><i>x</i>'), ['p', 'gone'], { selector: 'i', place: 'after' })).toBeNull()
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
