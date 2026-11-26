import { describe, expect, it } from 'vitest'
import { linkSegments } from '../src/lib/linkify'

const links = (text: string) => linkSegments(text).flatMap((part) => (part.href ? [part.href] : []))

describe('linkSegments', () => {
  it('cuts a bare address out of the text around it, keeping every character', () => {
    const text = 'https://chromewebstore.google.com/detail/doop-capture/piegednp?pli=1\n\nThis could be an option'
    const parts = linkSegments(text)
    expect(parts).toEqual([
      {
        text: 'https://chromewebstore.google.com/detail/doop-capture/piegednp?pli=1',
        href: 'https://chromewebstore.google.com/detail/doop-capture/piegednp?pli=1',
      },
      { text: '\n\nThis could be an option' },
    ])
    expect(parts.map((part) => part.text).join('')).toBe(text)
  })

  it('leaves text with no address as one plain run', () => {
    expect(linkSegments('it uses context.dev. lol')).toEqual([{ text: 'it uses context.dev. lol' }])
  })

  it('drops the punctuation that ends the sentence around an address', () => {
    expect(links('see https://doop.design.')).toEqual(['https://doop.design'])
    expect(links('(https://doop.design/docs)')).toEqual(['https://doop.design/docs'])
    expect(links('"https://doop.design/a?b=1", then')).toEqual(['https://doop.design/a?b=1'])
  })

  it('keeps a bracket the address opened itself', () => {
    expect(links('https://en.wikipedia.org/wiki/Doop_(film) is it')).toEqual([
      'https://en.wikipedia.org/wiki/Doop_(film)',
    ])
  })

  it('links www. addresses over https and finds several in one line', () => {
    expect(links('www.doop.design and http://localhost:4300/c/abc')).toEqual([
      'https://www.doop.design',
      'http://localhost:4300/c/abc',
    ])
  })

  it('ignores a scheme with nothing after it', () => {
    expect(links('type https:// first')).toEqual([])
  })

  it('never links other schemes', () => {
    expect(links('javascript:alert(1) data:text/html,x')).toEqual([])
  })
})
