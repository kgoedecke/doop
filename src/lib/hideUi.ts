/** ⌘. (Figma's "hide UI") only means something over the canvas: the Board
 *  view has no canvas chrome to hide, and PresentMode covers everything with
 *  its own controls, which stay. Elsewhere the chord is left alone, so coming
 *  back to the canvas never reveals controls that vanished unseen. */
export function canHideUi({ view, presenting }: { view: 'canvas' | 'board'; presenting: boolean }): boolean {
  return view === 'canvas' && !presenting
}

/* The "UI hidden · ⌘. to show" hint goes up the first time ⌘. hides the
   chrome in this browser, and never again — after that the shortcut is known. */
const HIDE_UI_HINTED_KEY = 'doop:hide-ui-hinted'

/** true once the hint has already been shown in this browser; marks it shown otherwise */
export function hideUiHinted(): boolean {
  try {
    if (localStorage.getItem(HIDE_UI_HINTED_KEY)) return true
    localStorage.setItem(HIDE_UI_HINTED_KEY, '1')
  } catch {
    /* private mode: the hint shows on every first hide of a visit */
  }
  return false
}
