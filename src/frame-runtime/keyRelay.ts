import { CANVAS_MOD_CHORDS } from '../lib/keys'
import {
  apply,
  elementMatches,
  isTrusted,
  KEY_FIELDS,
  keyGetters,
  readEditable,
  readNodeType,
  readTarget,
  readType,
  runtimePort,
  sendToEditor,
  type KeyField,
} from './channel'
import { dropPendingTextSave, editing, editTimer, endEditFromFrame } from './edit'
import { protoOn } from './proto'
import { serialize } from './serialize'

/* Focus stays in the frame after text editing ends, and the canvas page
   never sees a key pressed in here: relay every key, so its shortcuts
   (undo, delete, tools, Space to pan) keep working. Not while editing
   text, not in a field of the design, not while a prototype plays, and
   added ahead of the Escape listener below, which ends editing on the
   very key it would otherwise see as a canvas Escape. Keys go down the
   editor's port (channel.ts), read through the pinned getters. */

const MOD_CHORDS: readonly string[] = CANVAS_MOD_CHORDS

type PressedKey = Record<KeyField, unknown> & {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

function relayKey(ev: KeyboardEvent): void {
  if (!runtimePort) return
  if (!isTrusted(ev)) return
  const read = {} as Record<KeyField, unknown>
  /* indexed, not for…of: the array iterator is the design's to patch */
  for (let f = 0; f < KEY_FIELDS.length; f++) read[KEY_FIELDS[f]!] = apply(keyGetters[KEY_FIELDS[f]!], ev, [])
  const k = read as PressedKey
  /* ⌘1…⌘9 switch the desktop shell's tabs and ⌘, opens Settings
     (desktop.ts), so they travel from text being edited and a field too:
     nothing in here types with them. The prototype player hands its
     screens no port, so a playing prototype keeps them (it is modal) */
  const tabChord = (k.metaKey || k.ctrlKey) && !k.altKey && !k.shiftKey && /^(Digit[1-9]|Comma)$/.test(String(k.code))
  /* the shell is about to leave this canvas: text typed in the last
     400ms goes first, down the key's own port so it arrives ahead of it */
  if (tabChord && editing && editTimer && apply(readType, ev, []) === 'keydown') {
    dropPendingTextSave()
    sendToEditor({ event: 'edited', html: serialize() })
  }
  if (!tabChord) {
    if (editing || protoOn) return
    const t = apply(readTarget, ev, []) as EventTarget | null
    if (t && apply(readNodeType, t, []) === 1) {
      if (apply(elementMatches, t, ['input, textarea, select'])) return
      if (t instanceof HTMLElement && apply(readEditable, t, [])) return
    }
  }
  const type = apply(readType, ev, []) as string
  const mod = (k.metaKey || k.ctrlKey) && !k.altKey
  const letter = String(k.key).toLowerCase()
  /* ⌘C / ⌘X stay this document's: the page cannot see text selected in
     here, and would take the chord for its own selection instead */
  if (mod && !k.shiftKey && (letter === 'c' || letter === 'x')) return
  /* ⌫ and Delete are never relayed: the page removes what is selected on them */
  if (k.key === 'Backspace' || k.key === 'Delete') return
  const digit = k.shiftKey && /^Digit[0-9]$/.test(k.code) ? k.code.slice(5) : ''
  const chord = (k.shiftKey ? 'shift+' : '') + letter
  const byCode = digit ? 'shift+' + digit : chord
  /* Space would scroll this document while the page pans on it */
  if (type === 'keydown' && k.key === ' ' && !mod) ev.preventDefault()
  if (type === 'keydown' && mod && (MOD_CHORDS.indexOf(chord) >= 0 || MOD_CHORDS.indexOf(byCode) >= 0))
    ev.preventDefault()
  sendToEditor({
    event: type,
    key: k.key,
    code: k.code,
    ctrlKey: k.ctrlKey,
    metaKey: k.metaKey,
    shiftKey: k.shiftKey,
    altKey: k.altKey,
    repeat: k.repeat,
  })
}

export function installKeyRelay(): void {
  document.addEventListener('keydown', relayKey)
  document.addEventListener('keyup', relayKey)

  /* Escape pressed with focus inside the frame: the parent never sees the
     key event itself, so relay it (present mode closes on it) */
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return
    if (protoOn && ev.defaultPrevented) return // the design's own script took it
    if (editing) endEditFromFrame()
    else parent.postMessage({ type: 'doop:esc' }, '*')
  })
}
