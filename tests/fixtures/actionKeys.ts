/* What the canvas page does for the keyboard, for fixtures that mount the
   Stage alone: install a host for the action registry and dispatch its
   chords (⇧R, ⇧C, ⇧1 and the rest) from the window. */

import { dispatchActionKey, setActionHost } from '../../src/lib/actions/registry'
import { isTypingTarget } from '../../src/lib/keys'

export function installActionKeys() {
  const noop = () => {}
  setActionHost({
    canvasId: 'c',
    guest: false,
    presenting: false,
    hideUiActive: true,
    agentsOpen: false,
    openPalette: noop,
    openAgent: noop,
    openShortcuts: noop,
    openFind: noop,
    findStep: noop,
    openExport: noop,
    openImport: noop,
    openVersionHistory: noop,
    openLink: noop,
    placeImage: noop,
    newCanvas: noop,
    duplicateCanvas: noop,
    present: noop,
    toggleHideUi: noop,
    toggleAgents: noop,
  })
  window.addEventListener('keydown', (e) => dispatchActionKey(e, isTypingTarget(e.target)))
}
