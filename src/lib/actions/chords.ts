/* A keyboard chord, as the action registry binds it. `mod` is ⌘ on a Mac and
   Ctrl elsewhere; `ctrl` is the Control key itself, which only a Mac tells
   apart from `mod`. Chords with ⌥ or ⇧ on a digit or punctuation key name the
   physical key by `code`, since macOS types another character for ⌥ chords
   and ⇧1 is '!' on most layouts. */

export interface Chord {
  /** `KeyboardEvent.key`, compared case-insensitively */
  key?: string
  /** `KeyboardEvent.code`, the physical key */
  code?: string
  mod?: boolean
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
  /** bound on a Mac only: elsewhere the chord belongs to the system (⌃C is copy) */
  macOnly?: boolean
  /** bound everywhere but a Mac, where the chord means something else (⌘Y is outlines there) */
  notMac?: boolean
  /** acts from inside text fields too (⌘K, ⌘/) */
  global?: boolean
}

type KeyInput = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

export const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

/** Whether the event is this chord, modifiers exactly. */
export function matchesChord(e: KeyInput, chord: Chord, mac = IS_MAC): boolean {
  if ((chord.macOnly && !mac) || (chord.notMac && mac)) return false
  const wantMeta = mac ? !!chord.mod : false
  const wantCtrl = mac ? !!chord.ctrl : !!chord.mod || !!chord.ctrl
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl) return false
  if (e.altKey !== !!chord.alt || e.shiftKey !== !!chord.shift) return false
  if (chord.code) return e.code === chord.code
  return !!chord.key && e.key.toLowerCase() === chord.key.toLowerCase()
}

const KEY_GLYPHS: Record<string, string> = {
  Backspace: '⌫',
  Delete: '⌦',
  Enter: '↩',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Home: 'Home',
  End: 'End',
  Tab: '⇥',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Period: '.',
  Comma: ',',
  Quote: "'",
  Equal: '+',
  Minus: '−',
}

/** The key's face: a letter upper-cased, a code turned back into its key. */
function keyFace(chord: Chord): string {
  if (chord.code) {
    if (chord.code.startsWith('Key')) return chord.code.slice(3)
    if (chord.code.startsWith('Digit')) return chord.code.slice(5)
    return KEY_GLYPHS[chord.code] ?? chord.code
  }
  const key = chord.key ?? ''
  if (key === '?') return '?'
  return KEY_GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
}

/** The chord as a menu shows it: ⌃⌥⇧⌘K on a Mac, Ctrl+Alt+Shift+K elsewhere. */
export function chordHint(chord: Chord, mac = IS_MAC): string {
  const face = keyFace(chord)
  if (mac) {
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}${face}`
  }
  const parts = [chord.mod || chord.ctrl ? 'Ctrl' : '', chord.alt ? 'Alt' : '', chord.shift ? 'Shift' : '', face]
  return parts.filter(Boolean).join('+')
}

/** The first chord bound on this platform, for a hint; null when none is. */
export function firstChord(chords: readonly Chord[] | undefined, mac = IS_MAC): Chord | null {
  return chords?.find((c) => boundOn(c, mac)) ?? null
}

/** Whether the chord is bound on this system at all. */
export function boundOn(chord: Chord, mac = IS_MAC): boolean {
  return mac ? !chord.notMac : !chord.macOnly
}
