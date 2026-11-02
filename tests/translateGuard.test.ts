// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { installTranslateGuard } from '../src/lib/translateGuard'

installTranslateGuard()

/* what page translation does to a React text node: moves it into a <font>
   wrapper React does not know about */
function translated() {
  const parent = document.createElement('div')
  const text = document.createTextNode('Hello')
  parent.append(text)
  const font = document.createElement('font')
  parent.replaceChild(font, text)
  font.append(text)
  return { parent, text, font }
}

describe('translate guard', () => {
  it('skips removing a node that page translation moved', () => {
    const { parent, text, font } = translated()
    expect(() => parent.removeChild(text)).not.toThrow()
    expect(text.parentNode).toBe(font)
  })

  it('inserts before the wrapper that now holds the reference node', () => {
    const { parent, text, font } = translated()
    const tail = document.createElement('b')
    parent.append(tail)
    const added = document.createElement('span')
    expect(() => parent.insertBefore(added, text)).not.toThrow()
    expect([...parent.childNodes]).toEqual([added, font, tail])
  })

  it('appends when the reference node left the parent', () => {
    const { parent, text, font } = translated()
    font.removeChild(text)
    const added = document.createElement('span')
    expect(() => parent.insertBefore(added, text)).not.toThrow()
    expect([...parent.childNodes]).toEqual([font, added])
  })

  it('leaves ordinary removes and inserts alone', () => {
    const parent = document.createElement('div')
    const a = document.createElement('a')
    const b = document.createElement('b')
    parent.append(b)
    expect(parent.insertBefore(a, b)).toBe(a)
    expect(parent.insertBefore(document.createElement('i'), null).tagName).toBe('I')
    expect(parent.removeChild(b)).toBe(b)
    expect([...parent.childNodes].map((n) => n.nodeName)).toEqual(['A', 'I'])
  })
})
