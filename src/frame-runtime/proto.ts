import { parseInteractions, PROTO_SELECTOR, type Interaction, type ProtoTrigger } from '../../shared/prototype'
import type { ScannedHotspot } from '../lib/frameBridge'
import { cssPath, designRect } from './geometry'
import { editing } from './edit'
import { clearTimeout, setTimeout } from './timers'

/* Prototype triggers. Inert until the parent turns prototype mode on with
   `doop:proto`: the canvas never does, so a click while editing still only
   selects. Once on, a trigger posts `doop:proto-action` with the parsed
   interaction and the player does the navigation; only scroll-to runs here.
   The parser is shared/prototype.ts's own: one definition of what an
   interaction attribute means, on both sides of the sandbox. */

/** what the editor sends to the prototype runtime */
interface ProtoCommand {
  type: string
  reqId?: unknown
  on?: unknown
  hints?: unknown
  key?: unknown
}

interface ProtoHit {
  el: Element
  interaction: Interaction
}

export let protoOn = false
let protoHints = true
let protoTimers: number[] = []
let protoHoverEl: Element | null = null
/** the pending clear of the hotspot flash; a new flash takes its place */
let protoFlashTimer: number | null = null
/** the hotspot flash's sheet, adopted the first time it is needed */
export let protoSheet: CSSStyleSheet | null = null
/* a press this screen reported and whose release it still owes the player */
let protoPressing = false

function protoList(el: Element): Interaction[] {
  return parseInteractions({
    on: el.getAttribute('data-doop-on'),
    action: el.getAttribute('data-doop-action'),
    transition: el.getAttribute('data-doop-transition'),
    duration: el.getAttribute('data-doop-duration'),
    interactions: el.getAttribute('data-doop-interactions'),
  })
}

/* the nearest element at or above start with an interaction for this trigger */
function protoFind(start: EventTarget | null, trigger: ProtoTrigger): ProtoHit | null {
  const node = start as Node | null
  let el = (node && node.nodeType === 3 ? node.parentElement : node) as Element | null
  while (el && el.nodeType === 1) {
    if (el.matches(PROTO_SELECTOR)) {
      for (const interaction of protoList(el)) if (interaction.trigger === trigger) return { el, interaction }
    }
    el = el.parentElement
  }
  return null
}

/* press: the player reverts what this opened on release; a scroll has
   nothing to revert and runs here either way */
function protoFire(interaction: Interaction, press?: boolean): void {
  if (interaction.action === 'scroll-to') {
    let target: Element | null = null
    try {
      target = document.querySelector(interaction.target!)
    } catch {
      /* bad selector */
    }
    if (target)
      target.scrollIntoView({ behavior: interaction.transition === 'instant' ? 'auto' : 'smooth', block: 'start' })
    return
  }
  if (press) protoPressing = true
  parent.postMessage({ type: 'doop:proto-action', interaction, press: !!press }, '*')
}

function protoActive(): boolean {
  return protoOn && !editing
}

function protoEnsureSheet(): void {
  if (protoSheet) return
  try {
    protoSheet = new CSSStyleSheet()
    /* the colour comes from the animation alone: an !important outline-color
       outranks every animation, which would leave a hard ring that never fades */
    protoSheet.replaceSync(
      '@keyframes doop-proto-flash{0%{outline-color:rgba(1,119,211,.9)}100%{outline-color:rgba(1,119,211,0)}}' +
        '[data-v-proto-flash]{outline-style:solid!important;outline-width:2px!important;outline-offset:1px!important;' +
        'animation:doop-proto-flash .9s ease-out forwards!important}',
    )
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat(protoSheet)
  } catch {
    /* an engine without constructable sheets: no flash */
  }
}

/* flash every element that does something when clicked or pressed */
function protoFlash(): void {
  protoEnsureSheet()
  for (const el of document.querySelectorAll<HTMLElement>(PROTO_SELECTOR)) {
    el.removeAttribute('data-v-proto-flash')
    void el.offsetWidth // restart the animation
    el.setAttribute('data-v-proto-flash', '')
  }
  /* a flash restarted mid-run keeps its full run: the earlier clear would cut it short */
  clearTimeout(protoFlashTimer)
  protoFlashTimer = setTimeout(() => {
    protoFlashTimer = null
    for (const lit of document.querySelectorAll('[data-v-proto-flash]')) lit.removeAttribute('data-v-proto-flash')
  }, 950)
}

function protoKey(key: unknown): boolean {
  for (const el of document.querySelectorAll(PROTO_SELECTOR)) {
    for (const interaction of protoList(el)) {
      if (interaction.trigger === 'key' && interaction.key === key) {
        protoFire(interaction)
        return true
      }
    }
  }
  return false
}

function protoStopDelays(): void {
  for (const timer of protoTimers) clearTimeout(timer)
  protoTimers = []
}

function protoStartDelays(): void {
  for (const el of document.querySelectorAll(PROTO_SELECTOR)) {
    for (const interaction of protoList(el)) {
      if (interaction.trigger !== 'delay') continue
      protoTimers.push(
        setTimeout(() => {
          if (protoActive() && el.isConnected) protoFire(interaction)
        }, interaction.delay!),
      )
    }
  }
}

function setProto(on: boolean, hints: boolean): void {
  protoHints = hints
  if (on === protoOn) return
  protoOn = on
  protoHoverEl = null
  protoStopDelays()
  if (on) protoStartDelays()
}

/* a live edit replaced the document: its delays are the new HTML's, timed
   from now, as on a reload of the screen */
export function protoHtmlChanged(): void {
  protoHoverEl = null
  protoStopDelays()
  if (protoActive()) protoStartDelays()
}

/* links and form controls keep their own behaviour; a click there is
   not a "miss" that should flash the hotspots */
function protoNative(target: EventTarget | null): boolean {
  const el = target as Element | null
  return !!(el && el.closest && el.closest('a[href],button,input,select,textarea,label,summary,[contenteditable]'))
}

/* A press that navigated has switched this screen off by the time the
   pointer comes up (it is the outgoing one now), so the release of a press
   it reported still goes out: dropping it would leave the press open for
   some later, unrelated release to undo. */
function protoRelease(): void {
  if (!protoActive() && !protoPressing) return
  protoPressing = false
  parent.postMessage({ type: 'doop:proto-release' }, '*')
}

function protoScan(): ScannedHotspot[] {
  const out: ScannedHotspot[] = []
  for (const el of document.querySelectorAll(PROTO_SELECTOR)) {
    const list = protoList(el)
    if (list.length) out.push({ selector: cssPath(el), rect: designRect(el), interactions: list })
  }
  return out
}

export function installProto(): void {
  document.addEventListener(
    'click',
    (ev) => {
      if (!protoActive()) return
      const hit = protoFind(ev.target, 'click')
      if (hit) {
        ev.preventDefault()
        protoFire(hit.interaction)
      } else if (protoHints && !protoNative(ev.target)) protoFlash()
    },
    true,
  )

  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (!protoActive()) return
      const hit = protoFind(ev.target, 'press')
      if (!hit) return
      ev.preventDefault()
      protoFire(hit.interaction, true)
    },
    true,
  )

  document.addEventListener('pointerup', protoRelease, true)
  document.addEventListener('pointercancel', protoRelease, true)

  document.addEventListener(
    'mouseover',
    (ev) => {
      if (!protoActive()) return
      const hit = protoFind(ev.target, 'hover')
      if (!hit) {
        protoHoverEl = null
        return
      }
      if (hit.el === protoHoverEl) return
      protoHoverEl = hit.el
      protoFire(hit.interaction)
    },
    true,
  )

  /* registered before the runtime's own Escape relay: a key the design
     handles is not also an "exit the player". Escape is left to that relay:
     the player closes an open overlay first and only then offers the key
     back through doop:proto-key, wherever the focus is. */
  document.addEventListener(
    'keydown',
    (ev) => {
      if (!protoActive() || ev.repeat || ev.key === 'Escape') return
      if (protoKey(ev.key)) ev.preventDefault()
    },
    true,
  )

  window.addEventListener('message', (ev) => {
    if (ev.source !== parent) return
    const d = ev.data as ProtoCommand | null
    if (!d) return
    if (d.type === 'doop:proto') {
      setProto(!!d.on, d.hints !== false)
      /* answered once the switch has taken: a key the player lets through
         after this reply meets a runtime that is listening */
      if (d.reqId) parent.postMessage({ type: 'doop:proto-result', reqId: d.reqId, on: protoOn }, '*')
    }
    if (d.type === 'doop:proto-hotspots') protoFlash()
    if (d.type === 'doop:proto-key') {
      const handled = protoActive() && protoKey(d.key)
      parent.postMessage({ type: 'doop:proto-key-result', reqId: d.reqId, handled }, '*')
    }
    if (d.type === 'doop:proto-scan') {
      parent.postMessage({ type: 'doop:proto-scan-result', reqId: d.reqId, items: protoScan() }, '*')
    }
  })
}
