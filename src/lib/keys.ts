/** ⌘ on Mac, Ctrl elsewhere — for the shortcut hints in menus. */
export const MOD_KEY = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl+'

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
