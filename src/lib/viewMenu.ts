/* The desktop shell's View menu (desktop/src-tauri/src/view_menu.rs). The
   shell relays each item as a `view-command` event; the canvas screens
   subscribe to the commands they own, and report their state back so the
   menu's checkmarks and disabled items follow the page. Outside the shell
   (and in shells older than the menu) nothing is relayed and nothing is sent. */

const VIEW_COMMANDS = [
  'rulers',
  'ui',
  'layers',
  'agents',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'zoom-fit',
  'zoom-selection',
] as const

export type ViewCommand = (typeof VIEW_COMMANDS)[number]

export function isViewCommand(value: unknown): value is ViewCommand {
  return VIEW_COMMANDS.includes(value as ViewCommand)
}

/** What the menu mirrors. `uiToggle` is false where ⌘. has nothing to hide. */
export interface ViewMenuState {
  canvas: boolean
  rulers: boolean
  ui: boolean
  uiToggle: boolean
  layers: boolean
  agents: boolean
  selection: boolean
}

/** No canvas open: every canvas item unchecked and disabled. */
export const NO_CANVAS: ViewMenuState = {
  canvas: false,
  rulers: false,
  ui: false,
  uiToggle: false,
  layers: false,
  agents: false,
  selection: false,
}

type ViewMenuBridge = {
  __DOOP_VIEW_MENU__?: boolean
  __TAURI__?: { core?: { invoke: (command: string, args: ViewMenuState) => Promise<void> } }
}

const bridge = globalThis as ViewMenuBridge
const handlers = new Set<(command: ViewCommand) => void>()

/** Run `handler` for every View menu command; returns the unsubscribe. */
export function onViewCommand(handler: (command: ViewCommand) => void): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

/** Hand a command from the shell to every subscriber. */
export function runViewCommand(command: ViewCommand) {
  for (const handler of handlers) handler(command)
}

/** Mirror the page's view state into the shell's menu. */
export function syncViewMenu(state: ViewMenuState) {
  const invoke = bridge.__DOOP_VIEW_MENU__ === true ? bridge.__TAURI__?.core?.invoke : undefined
  invoke?.('view_menu_state', state).catch(console.error)
}
