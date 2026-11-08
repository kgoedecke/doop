import { describe, expect, it } from 'vitest'
import { chordHint, firstChord, matchesChord } from '../src/lib/actions/chords'

const key = (k: string, mods: Partial<KeyboardEvent> = {}, code = '') =>
  ({ key: k, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent

describe('matchesChord', () => {
  it('reads mod as ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(matchesChord(key('k', { metaKey: true }), { key: 'k', mod: true }, true)).toBe(true)
    expect(matchesChord(key('k', { ctrlKey: true }), { key: 'k', mod: true }, true)).toBe(false)
    expect(matchesChord(key('k', { ctrlKey: true }), { key: 'k', mod: true }, false)).toBe(true)
  })

  it('wants the modifiers exactly', () => {
    expect(matchesChord(key('g', { metaKey: true, shiftKey: true }), { key: 'g', mod: true }, true)).toBe(false)
    expect(matchesChord(key('G', { metaKey: true, shiftKey: true }), { key: 'g', mod: true, shift: true }, true)).toBe(
      true,
    )
  })

  it('names ⌥ chords by the physical key, since macOS types another character', () => {
    const optionA = key('å', { altKey: true }, 'KeyA')
    expect(matchesChord(optionA, { code: 'KeyA', alt: true }, true)).toBe(true)
  })

  it('keeps a Mac-only chord off other systems', () => {
    expect(matchesChord(key('c', { ctrlKey: true }), { key: 'c', ctrl: true, macOnly: true }, false)).toBe(false)
    expect(matchesChord(key('c', { ctrlKey: true }), { key: 'c', ctrl: true, macOnly: true }, true)).toBe(true)
  })
})

describe('chordHint', () => {
  it('writes Mac glyphs in the usual order', () => {
    expect(chordHint({ code: 'KeyG', mod: true, alt: true }, true)).toBe('⌥⌘G')
    expect(chordHint({ code: 'KeyH', alt: true, ctrl: true }, true)).toBe('⌃⌥H')
    expect(chordHint({ key: 'z', mod: true, shift: true }, true)).toBe('⇧⌘Z')
    expect(chordHint({ key: 'Backspace', mod: true }, true)).toBe('⌘⌫')
  })

  it('spells chords out elsewhere', () => {
    expect(chordHint({ key: 'k', mod: true, shift: true }, false)).toBe('Ctrl+Shift+K')
    expect(chordHint({ code: 'Slash', alt: true }, false)).toBe('Alt+/')
  })

  it('shows the first chord bound on this system', () => {
    expect(firstChord([{ key: 'c', ctrl: true, macOnly: true }], false)).toBeNull()
    expect(firstChord([{ key: 'c', ctrl: true, macOnly: true }, { key: 'x' }], false)).toEqual({ key: 'x' })
  })
})
