// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { isCanvasChord } from '../src/lib/actions/registry'
import { isMenuTarget } from '../src/lib/keys'

/* While a menu is open the canvas's shortcuts rest, as in Figma: the menu
   has the keyboard. */
describe('keys typed into an open menu', () => {
  afterEach(() => document.body.replaceChildren())

  it('belong to the menu and its items', () => {
    const content = document.createElement('div')
    content.setAttribute('role', 'menu')
    const item = document.createElement('div')
    item.setAttribute('role', 'menuitem')
    content.append(item)
    document.body.append(content)
    expect(isMenuTarget(content)).toBe(true)
    expect(isMenuTarget(item)).toBe(true)
  })

  it('leave the rest of the page to the shortcuts', () => {
    const div = document.createElement('div')
    document.body.append(div)
    expect(isMenuTarget(div)).toBe(false)
    expect(isMenuTarget(document.body)).toBe(false)
    expect(isMenuTarget(null)).toBe(false)
  })
})

describe('isCanvasChord', () => {
  const chord = (key: string, code: string, mods: Partial<Record<'metaKey' | 'shiftKey', boolean>> = {}) => ({
    key,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  })

  it('knows the canvas own chords, so a menu keeps them from the browser', () => {
    expect(isCanvasChord(chord('d', 'KeyD', { metaKey: true }), true)).toBe(true)
    expect(isCanvasChord(chord('z', 'KeyZ', { metaKey: true }), true)).toBe(true)
  })

  it('leaves the browser its own', () => {
    expect(isCanvasChord(chord('r', 'KeyR', { metaKey: true }), true)).toBe(false)
    expect(isCanvasChord(chord('w', 'KeyW', { metaKey: true }), true)).toBe(false)
  })
})
