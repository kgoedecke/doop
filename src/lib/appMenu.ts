/* The desktop shell's macOS menu bar (desktop/src-tauri/src/app_menu.rs),
   built from the action registry the way the canvas's own main menu is: File,
   Edit, View, Object, Text, Arrange and Help, every command with its label in
   the page's language and its chord as the item's key equivalent, as Figma's
   desktop app mirrors its menus. The shell adds what is its own (the app
   menu, Close Tab, the system's Undo / Cut / Copy / Paste that text fields
   need, Full Screen, Window).

   The page owns the state: it sends the menus once (`app_menu_set`, again
   when the language changes) and then only the items whose enabled or
   checked state moved (`app_menu_state`). A picked item comes back as an
   `app-menu` event; `key` says a key equivalent fired it rather than a click,
   and such a key keeps the canvas keyboard's rules (not in a field, not while
   presenting, never a key another handler owns). Shells older than this
   (no `__DOOP_APP_MENU__`) keep their fixed View menu (viewMenu.ts). */

import { firstChord, type Chord } from './actions/chords'
import {
  ACTIONS,
  MENUS,
  isEnabled,
  onActionHostChange,
  runAction,
  takesKey,
  type CanvasAction,
  type MenuId,
} from './actions/registry'
import { onLocaleChange, t } from './i18n'
import { isTypingTarget } from './keys'
import { useStore } from './store'

/** One row of a native menu; `null` in a menu's items is a separator. */
export interface NativeMenuItem {
  id: string
  label: string
  /** a Tauri accelerator ("Alt+Cmd+KeyG"), or null for none */
  accelerator: string | null
  checkable: boolean
}

export interface NativeMenu {
  id: Exclude<MenuId, 'general'>
  label: string
  items: (NativeMenuItem | null)[]
}

/** An item's state: id, enabled, and checked for a checkable one. */
export type NativeItemState = [id: string, enabled: boolean, checked: boolean | null]

/* the shell's predefined Undo and Redo stand for these: they are what makes
   ⌘Z reach a text field, and the canvas takes the key before the menu does */
const SHELL_OWNED = new Set(['undo', 'redo'])
/* the ⌘K palette opens the Help menu, as the canvas menu's search sits above
   its submenus */
const HELP_LEAD = ['palette']

const PUNCTUATION: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  "'": 'Quote',
  '=': 'Equal',
  '-': 'Minus',
  ';': 'Semicolon',
  '`': 'Backquote',
}
const NAMED = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Escape',
  'Tab',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])

/* the physical key, as `KeyboardEvent.code` names it, which the shell's
   accelerator parser reads; null for a key it has no name for */
function keyCode(chord: Chord): string | null {
  if (chord.code) return chord.code
  const key = chord.key ?? ''
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^\d$/.test(key)) return `Digit${key}`
  return PUNCTUATION[key] ?? (NAMED.has(key) ? key : null)
}

/** The chord as a macOS key equivalent: ⌃⌥⇧⌘ in the system's order, then
 *  the physical key. */
export function nativeAccelerator(chord: Chord): string | null {
  const code = keyCode(chord)
  if (!code) return null
  const modifiers = [chord.ctrl && 'Ctrl', chord.alt && 'Alt', chord.shift && 'Shift', chord.mod && 'Cmd']
  return [...modifiers.filter(Boolean), code].join('+')
}

function item(action: CanvasAction): NativeMenuItem {
  const chord = firstChord(action.keys, true)
  return {
    id: action.id,
    label: t(action.label),
    accelerator: chord && nativeAccelerator(chord),
    checkable: !!action.checked,
  }
}

/* the registry's rows of one menu, a separator between sections */
function rows(actions: readonly CanvasAction[]): (NativeMenuItem | null)[] {
  const sections = [...new Set(actions.map((a) => a.section))]
  return sections.flatMap((section, i) => [
    ...(i > 0 ? [null] : []),
    ...actions.filter((a) => a.section === section).map(item),
  ])
}

/** Every menu the page puts in the bar, in the registry's order. */
export function nativeMenus(): NativeMenu[] {
  return MENUS.map((menu) => {
    const own = ACTIONS.filter((a) => a.menu === menu.id && !SHELL_OWNED.has(a.id))
    const lead = menu.id === 'help' ? ACTIONS.filter((a) => HELP_LEAD.includes(a.id)).map(item) : []
    return { id: menu.id, label: t(menu.label), items: lead.length ? [...lead, null, ...rows(own)] : rows(own) }
  })
}

/** What each item in the bar shows now. */
export function nativeStates(): NativeItemState[] {
  const inBar = (a: CanvasAction) => !SHELL_OWNED.has(a.id) && (a.menu !== 'general' || HELP_LEAD.includes(a.id))
  return ACTIONS.filter(inBar).map((a) => {
    const enabled = isEnabled(a)
    return [a.id, enabled, a.checked ? enabled && a.checked() : null]
  })
}

/** Run what the menu bar picked. A key equivalent keeps the canvas
 *  keyboard's rules; a field in a frame counts as typing, since the page
 *  never saw that key. */
export function runNativeItem(id: string, key: boolean) {
  const action = ACTIONS.find((a) => a.id === id)
  if (!action) return
  const focused = document.activeElement
  if (key && !takesKey(action, isTypingTarget(focused) || focused instanceof HTMLIFrameElement)) return
  runAction(action)
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>
type Listen = <T>(event: string, handler: (e: { payload: T }) => void) => Promise<unknown>
type AppMenuBridge = {
  __DOOP_APP_MENU__?: boolean
  __TAURI__?: { core?: { invoke?: Invoke }; event?: { listen?: Listen } }
}

const bridge = globalThis as AppMenuBridge

/** Whether this shell builds its menu bar from the page. */
export function hasAppMenu(): boolean {
  return bridge.__DOOP_APP_MENU__ === true && !!bridge.__TAURI__?.core?.invoke
}

const SYNC_DELAY_MS = 120
/* what the shell shows, by item id, so only a change is sent */
const shown = new Map<string, string>()
let syncTimer: ReturnType<typeof setTimeout> | null = null

function invoke(command: string, args: Record<string, unknown>) {
  bridge.__TAURI__?.core?.invoke?.(command, args).catch(console.error)
}

/** Send the items whose state moved since the last send. */
export function syncAppMenu() {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
  const items = nativeStates().filter(([id, enabled, checked]) => {
    const state = `${enabled}:${checked}`
    if (shown.get(id) === state) return false
    shown.set(id, state)
    return true
  })
  if (items.length) invoke('app_menu_state', { items })
}

/* a store change, a host swap, a copy: the state is read again shortly
   after, once, however many changes came in between (a drag moves the store
   on every pointer move) */
function scheduleSync() {
  syncTimer ??= setTimeout(syncAppMenu, SYNC_DELAY_MS)
}

function buildAppMenu() {
  shown.clear()
  invoke('app_menu_set', { menus: nativeMenus() })
  syncAppMenu()
}

/** Hand the menu bar to the page; once, from the shell's start-up. */
export function initAppMenu() {
  if (!hasAppMenu()) return
  buildAppMenu()
  onLocaleChange(buildAppMenu)
  onActionHostChange(scheduleSync)
  useStore.subscribe(scheduleSync)
  /* what Paste can take changes outside the store */
  for (const event of ['copy', 'cut', 'focus'] as const) window.addEventListener(event, scheduleSync)
  bridge.__TAURI__?.event
    ?.listen?.<{ id?: unknown; key?: unknown }>('app-menu', ({ payload }) => {
      if (typeof payload?.id === 'string') runNativeItem(payload.id, payload.key === true)
    })
    .catch(console.error)
}
