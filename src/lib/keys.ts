/** ⌘ on Mac, Ctrl elsewhere — for the shortcut hints in menus. */
export const MOD_KEY = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+'

/** The ⌘ / Ctrl chords the canvas page acts on, as `[shift+]key` using
 *  the Latin labels of the physical keys. A frame document with the focus keeps them from its browser
 *  defaults (Ctrl+D bookmarking, Ctrl+K the search bar, Ctrl+± page zoom)
 *  before relaying them, since the page's own preventDefault arrives too
 *  late to reach that document. ⌘[ / ⌘] would otherwise take the frame's
 *  document back and forward in its history; `+` is listed shifted and bare,
 *  since a number pad types it without ⇧. ⌘C and ⌘X are not relayed at all:
 *  the clipboard is the frame's when text is selected in it. */
export const CANVAS_MOD_CHORDS = [
  'z',
  'shift+z',
  'y',
  'k',
  'd',
  'a',
  '.',
  'shift+h',
  'shift+l',
  '0',
  '=',
  '-',
  '+',
  'shift++',
  'shift+=',
  '[',
  ']',
  'b',
  'i',
  'u',
  'shift+x',
  'shift+7',
  'shift+8',
]

/** Canvas shortcuts must leave native fields and rich-text editors alone. */
export function isTypingTarget(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)
}

/** ⌘. (Ctrl+. elsewhere): Figma's "hide UI" — only the bare chord, so
 *  ⌘⇧. and ⌥-variants stay free for the browser and the OS. */
export function isHideUiShortcut(e: Chord) {
  return shortcutKey(e) === '.' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
}

/** An Enter that only confirms an IME composition (Chinese, Japanese,
 *  Korean input) — the text is not committed yet, so an Enter-to-send field
 *  must let it through instead of posting. Safari ends the composition
 *  before this key event fires, leaving keyCode 229 as the only tell. */
export function isComposingEnter(e: {
  key: string
  keyCode?: number
  nativeEvent?: { isComposing?: boolean }
}): boolean {
  return e.key === 'Enter' && (e.nativeEvent?.isComposing === true || e.keyCode === 229)
}

/** ⌥ on Mac, Alt elsewhere — for the shortcut hints in menus. */
export const ALT_KEY = /mac/i.test(navigator.platform) ? '⌥' : 'Alt+'

/** The hint for ⌘⌥↩ / Ctrl+Alt+Enter, as a tooltip shows it. */
export const PRESENT_SHORTCUT_HINT = `${MOD_KEY}${ALT_KEY}↩`

/** ⌘⌥↩ (Ctrl+Alt+Enter elsewhere): Figma's "present from this frame" — the
 *  player opens on the selected frame, else on the page's flow start. Shift
 *  is left out so the chord stays one thing. */
export function isPresentShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>) {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey
}

/** ⌘⌥↩ (Ctrl+Alt+Enter elsewhere) runs the open automation: the canvas's
 *  Present chord, since both start what is on screen. ⌘R stays the
 *  browser's reload. */
export const RUN_SHORTCUT_HINT = PRESENT_SHORTCUT_HINT
export const isRunShortcut = isPresentShortcut

/** The hint for ⌘S / Ctrl+S, as a tooltip shows it. */
export const SAVE_SHORTCUT_HINT = `${MOD_KEY}S`

/** A key landing on a control — a button, link, menu, tab, tree — belongs to
 *  that control: ↩ presses it, Tab leaves it. The canvas's traversal keys
 *  act only when nothing like that has the keyboard. */
export function isControlTarget(target: EventTarget | null): boolean {
  if (isTypingTarget(target)) return true
  if (!(target instanceof HTMLElement)) return false
  return !!target.closest(
    'button, a[href], summary, [role="button"], [role="link"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="listbox"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="slider"], [role="tree"], [role="treeitem"], [role="dialog"]',
  )
}

/** The event's key, lowercased; '' when it carries none. Chrome's autofill and
 *  password managers dispatch `keydown` / `keyup` events with no `key` at all,
 *  despite the DOM type saying it is always a string. */
export function pressedKey(e: { key?: string }): string {
  return (e.key ?? '').toLowerCase()
}

/** Physical key labels shared by the canvas and its iframe runtime. */
export const SHORTCUT_KEYS_BY_CODE: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => [`Key${letter}`, letter.toLowerCase()])),
  ...Object.fromEntries(Array.from('0123456789', (digit) => [`Digit${digit}`, digit])),
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadEqual: '=',
  Numpad0: '0',
}

/** Named keys and events without a physical code still use the event's key. */
export function shortcutKey(e: { key?: string; code?: string }): string {
  const key = pressedKey(e)
  const code = e.code
  if (!code || code === 'Unidentified') return key
  if (Object.hasOwn(SHORTCUT_KEYS_BY_CODE, code)) return SHORTCUT_KEYS_BY_CODE[code] ?? ''
  return key.length > 1 ? key : ''
}

type Chord = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> &
  Partial<Pick<KeyboardEvent, 'code'>>

/** ⌘A (Ctrl+A elsewhere): Figma's select all. */
export function isSelectAllShortcut(e: Chord) {
  return shortcutKey(e) === 'a' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
}

export type ReorderMove = 'forward' | 'backward' | 'front' | 'back'

/** ⌘] / ⌘[ step the selection forward or backward, ⌘⌥] / ⌘⌥[ take it to
 *  the front or the back, as in Figma. */
export function reorderShortcut(e: Chord): ReorderMove | null {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return null
  const key = shortcutKey(e)
  if (key !== ']' && key !== '[') return null
  if (e.altKey) return key === ']' ? 'front' : 'back'
  return key === ']' ? 'forward' : 'backward'
}
