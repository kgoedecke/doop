/** ⌘ on Mac, Ctrl elsewhere — for the shortcut hints in menus. */
export const MOD_KEY = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+'

/** The ⌘ / Ctrl chords the canvas page acts on, as `[shift+]key` (key
 *  lowercased; a shifted digit by its `code`, as ⌘⇧7 types & on US keyboards). A frame document with the focus keeps them from its browser
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
export function isHideUiShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>) {
  return e.key === '.' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
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

type Chord = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** ⌘A (Ctrl+A elsewhere): Figma's select all. */
export function isSelectAllShortcut(e: Chord) {
  return e.key.toLowerCase() === 'a' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
}

export type ReorderMove = 'forward' | 'backward' | 'front' | 'back'

/** ⌘] / ⌘[ step the selection forward or backward, ⌘⌥] / ⌘⌥[ take it to
 *  the front or the back, as in Figma. Read by code as well as key: with ⌥
 *  held macOS types another character for the bracket keys. */
export function reorderShortcut(e: Chord): ReorderMove | null {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return null
  const right = e.key === ']' || e.code === 'BracketRight'
  const left = e.key === '[' || e.code === 'BracketLeft'
  if (!right && !left) return null
  if (e.altKey) return right ? 'front' : 'back'
  return right ? 'forward' : 'backward'
}
