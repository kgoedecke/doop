import type { DropTarget } from '../lib/layers'
import { setBleed, viewX } from './bleed'
import {
  adoptRuntimePort,
  apply,
  editorWindow,
  hasOwn,
  isTrusted,
  readMessageData,
  readMessageSource,
  runtimePort,
  sendToEditor,
} from './channel'
import { isLocked, styleTarget } from './dom'
import { layerPlacement, moveTarget, placementOrigin } from './drop'
import { activate, activeEl, candidate, deactivate, editing, editsSent, selectAllIn, setEdit } from './edit'
import { designRect, elementGeometry, ownRotation, renderedBox, sizable } from './geometry'
import {
  contextHit,
  describe,
  drawingHit,
  hitInfo,
  hoverProbe,
  linkHrefAt,
  measure,
  moveHit,
  probe,
  probeTarget,
} from './hit'
import { replaceImage, type ImageFill } from './images'
import { inspect, rootFill } from './inspect'
import { render } from './morph'
import { editGeometry, type GeometryCommand } from './move'
import { pathInfo, setMovingDrawing, setPathEditing } from './paths'
import { protoHtmlChanged } from './proto'
import { exportSnapshot } from './serialize'
import { setCanvasCursor, setOutlines } from './sheets'
import {
  applyStyle,
  beginPanelEdit,
  beginStyleEdit,
  endStyleEdit,
  flushStyleSave,
  panelEditFor,
  styleSavePending,
} from './styles'
import { firstTextRun, formatLayers, formatText, runDecoration } from './text'
import type { Rect, StylePatch } from './types'

/* The editor drives this document with `doop:*` messages; a request
   `doop:<name>` is answered with `doop:<name>-result` and the same reqId.
   The message types are the editor's (src/lib/frameBridge.ts and
   FrameView.tsx); the fields below are read as the editor sends them, each
   checked where the handler always checked it. */
interface Command {
  type: unknown
  reqId?: unknown
  selector?: unknown
  targets?: unknown
  selectors?: unknown
  selected?: unknown
  x: number
  y: number
  dx?: number
  dy?: number
  on?: unknown
  px?: unknown
  properties?: unknown
  fromTextRun?: unknown
  styles?: unknown
  uniformText?: unknown
  image?: Partial<ImageFill> | null
  url?: unknown
  edit?: GeometryCommand | null
  phase?: unknown
  followers?: unknown
  html?: unknown
  /** doop:html: the edit a document built from one of ours was made from */
  basis?: unknown
  command?: unknown
  id?: unknown
  cursor?: unknown
  name?: unknown
  elementId?: unknown
  hidden?: unknown
  locked?: unknown
  grouped?: unknown
  standalone?: unknown
  target?: DropTarget | null
  at?: Rect | null
}

/** the document's look changed outside a render: the editor refreshes what it measured */
function notifyFrameUpdated(): void {
  parent.postMessage({ type: 'doop:frame-updated' }, '*')
}

export function installFrameUpdates(): void {
  document.fonts.addEventListener('loadingdone', notifyFrameUpdated)
  /* A linked sheet can declare unused faces without loading any font files.
     Capture its non-bubbling load event, including links added by later renders. */
  document.addEventListener(
    'load',
    (ev) => {
      const el = ev.target as Element | null
      if (
        el &&
        (el.tagName === 'IMG' || (el.tagName === 'LINK' && (el as HTMLLinkElement).relList.contains('stylesheet')))
      )
        notifyFrameUpdated()
    },
    true,
  )
}

/* a computed style per property, a text run's own where asked: what
   ⌥⌘C copies */
function computedValues(selector: unknown, properties: unknown[], fromTextRun: boolean): Record<string, string> | null {
  const computedEl = styleTarget(selector)
  if (!computedEl) return null
  const run = fromTextRun ? firstTextRun(computedEl) : computedEl
  const cs = getComputedStyle(run)
  const values: Record<string, string> = {}
  properties.forEach((name) => {
    values[name as string] =
      name === 'text-decoration-line' && run !== computedEl
        ? runDecoration(run, computedEl)
        : cs.getPropertyValue(name as string)
  })
  return values
}

/* every picked layer that can move moves by the same delta, a picked
   parent carrying its picked descendants */
function nudge(selectors: unknown[], dx: number | undefined, dy: number | undefined): boolean {
  const movable = selectors
    .map((selector) => {
      try {
        return { selector, el: document.querySelector(selector as string) }
      } catch {
        return { selector, el: null }
      }
    })
    .filter((p): p is { selector: unknown; el: Element } => !!p.el && elementGeometry(p.el).enabled)
  const moved = movable
    .filter((p) => !movable.some((other) => other.el !== p.el && other.el.contains(p.el)))
    .map((p) => editGeometry(p.selector, { kind: 'nudge', dx, dy }))
  return moved.indexOf(true) !== -1
}

/* a ⌘-clicked #link: to the element it names, or the top for a bare # */
function scrollToAnchor(id: string): void {
  let anchorId = id
  try {
    anchorId = decodeURIComponent(id)
  } catch {
    /* keep it as written */
  }
  /* as a browser does: an element named so wins, even one named top */
  const anchorEl = anchorId ? document.getElementById(anchorId) || document.getElementsByName(anchorId)[0] : null
  if (anchorEl) anchorEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
  else if (!anchorId || anchorId === 'top') window.scrollTo({ top: 0, behavior: 'smooth' })
}

/* the Layers panel's rename lands on the live element too */
function rename(selector: unknown, name: unknown, elementId: unknown): boolean {
  const namedEl = styleTarget(selector)
  if (namedEl) {
    if (typeof name === 'string') namedEl.setAttribute('data-doop-name', name)
    else if (name === null) namedEl.removeAttribute('data-doop-name')
    /* the saved document stamps the element's id with its name; the live
       one follows, and a rolled-back stamp (null) comes off again */
    if (typeof elementId === 'string' && !namedEl.hasAttribute('data-doop-id'))
      namedEl.setAttribute('data-doop-id', elementId)
    else if (elementId === null) namedEl.removeAttribute('data-doop-id')
  }
  return !!namedEl
}

// Mirror the Layers eye in the live document, including during text edits.
function setVisibility(selector: unknown, hidden: unknown): boolean {
  const hideEl = styleTarget(selector)
  if (hideEl && hideEl.hasAttribute('data-doop-hidden') !== !!hidden) {
    const hideStyle = hideEl.style
    if (hidden) {
      if (hideStyle.display) {
        const priority = hideStyle.getPropertyPriority('display')
        hideEl.setAttribute('data-doop-display', hideStyle.display + (priority ? ' !' + priority : ''))
      }
      hideEl.setAttribute('data-doop-hidden', 'true')
      hideStyle.setProperty('display', 'none', 'important')
      if (activeEl && hideEl.contains(activeEl)) deactivate()
    } else {
      const prior = hideEl.getAttribute('data-doop-display')
      hideEl.removeAttribute('data-doop-hidden')
      hideEl.removeAttribute('data-doop-display')
      if (prior) {
        const parts = prior.split(' !')
        hideStyle.setProperty('display', parts[0]!, parts[1] || '')
      } else hideStyle.removeProperty('display')
      if (!hideEl.getAttribute('style')) hideEl.removeAttribute('style')
    }
  }
  return !!hideEl
}

/* a lock set from the Layers panel lands on the live element too: while
   editing, the parent withholds html, and the next text save serializes
   this document — the attribute has to be here or the save drops it. A
   lock over the element being typed in ends that edit. */
function setLock(selector: unknown, locked: unknown): boolean {
  const lockEl = styleTarget(selector)
  if (lockEl) {
    if (locked) {
      lockEl.setAttribute('data-doop-locked', 'true')
      if (activeEl && lockEl.contains(activeEl)) deactivate()
    } else lockEl.removeAttribute('data-doop-locked')
  }
  return !!lockEl
}

/* where a stored selector is now, to place comment pins */
function locate(d: Command): void {
  let found: Rect | null = null
  /* undefined, not null, until the selector resolves: the reply's box keeps its old value */
  let target: Element | null | undefined
  try {
    target = d.selector ? document.querySelector(d.selector as string) : null
    if (target) found = designRect(target)
  } catch {
    /* bad selector -> null */
  }
  const canSize = !!target && sizable(target)
  parent.postMessage(
    {
      type: 'doop:located',
      reqId: d.reqId,
      selector: d.selector,
      rect: found,
      sizable: canSize,
      rotation: canSize ? ownRotation(target!) || 0 : 0,
      box: target && found ? renderedBox(target, found) : null,
    },
    '*',
  )
}

function answer(type: string, reqId: unknown, fields: Record<string, unknown>): void {
  parent.postMessage({ type, reqId, ...fields }, '*')
}

function handle(d: Command, ev: MessageEvent): void {
  if (d.type === 'doop:runtime-port' && !runtimePort && ev.ports && ev.ports[0]) adoptRuntimePort(ev.ports[0])
  if (d.type === 'doop:inspect') answer('doop:inspect-result', d.reqId, { info: inspect(d.selector) })
  if (d.type === 'doop:design-selection' && Array.isArray(d.targets)) {
    const targets = d.targets.filter(
      (target): target is { selector: string; styles?: StylePatch; geometry?: GeometryCommand } =>
        target && typeof target.selector === 'string',
    )
    const selectors = targets.map((target) => target.selector)
    if (d.phase === 'begin' || d.phase === 'apply') beginPanelEdit(selectors)
    const edit = panelEditFor(selectors)
    if (edit && (d.phase === 'apply' || d.phase === 'preview')) {
      for (const { selector, styles, geometry } of targets) {
        if (styles && typeof styles === 'object') applyStyle(selector, styles)
        if (geometry) editGeometry(selector, geometry)
      }
    }
    if (edit && (d.phase === 'apply' || d.phase === 'commit' || d.phase === 'cancel'))
      endStyleEdit(edit.selector, d.phase === 'cancel')
    if (d.phase === 'begin' || d.phase === 'preview') return answer('doop:design-selection-result', d.reqId, {})
    const layers = selectors.flatMap((selector) => {
      const info = !isLocked(styleTarget(selector)) && inspect(selector)
      return info ? [{ selector, info }] : []
    })
    answer('doop:design-selection-result', d.reqId, { layers })
  }
  if (d.type === 'doop:root-fill') answer('doop:root-fill-result', d.reqId, { fill: rootFill() })
  if (d.type === 'doop:outlines') setOutlines(d.on === true)
  if (d.type === 'doop:bleed' && typeof d.px === 'number') setBleed(d.px)
  if (d.type === 'doop:computed' && Array.isArray(d.properties)) {
    answer('doop:computed-result', d.reqId, {
      values: computedValues(d.selector, d.properties, d.fromTextRun === true),
    })
  }
  if (d.type === 'doop:settle') {
    flushStyleSave()
    // Undo must receive all pending saves before this acknowledgement.
    if (runtimePort) sendToEditor({ event: 'settled', reqId: d.reqId })
  }
  if (d.type === 'doop:style' && d.styles && typeof d.styles === 'object') {
    const applied = applyStyle(d.selector, d.styles as StylePatch, d.uniformText === true)
    answer('doop:style-result', d.reqId, { ok: applied, info: applied ? inspect(d.selector) : null })
  }
  if (d.type === 'doop:replace-image') {
    const replaced = replaceImage(d.selector, d.image, d.url)
    answer('doop:replace-image-result', d.reqId, { ok: replaced, info: replaced ? inspect(d.selector) : null })
  }
  if (d.type === 'doop:nudge' && Array.isArray(d.selectors)) {
    answer('doop:nudge-result', d.reqId, { ok: nudge(d.selectors, d.dx, d.dy) })
  }
  if (d.type === 'doop:geometry') {
    const changed = editGeometry(d.selector, d.edit)
    answer('doop:geometry-result', d.reqId, { ok: changed, info: changed ? inspect(d.selector) : null })
  }
  if (d.type === 'doop:style-gesture') {
    const changed =
      d.phase === 'begin'
        ? beginStyleEdit(d.selector, d.followers)
        : d.phase === 'commit' || d.phase === 'cancel'
          ? endStyleEdit(d.selector, d.phase === 'cancel')
          : false
    answer('doop:style-gesture-result', d.reqId, { info: changed ? inspect(d.selector) : null })
  }
  /* A document built from one of our own edits (a hosted font's link added
     to it on save) left before any edit made since: one whose save is still
     waiting, or one already sent. Rendering it would put those edits back as
     they were, and the waiting save would then send the older document. It
     is dropped; the newer edit's save comes back the same way, built from
     that one. */
  const outdated = typeof d.basis === 'number' && (d.basis !== editsSent || styleSavePending())
  if (d.type === 'doop:html' && typeof d.html === 'string' && !editing && outdated) {
    if (d.reqId) parent.postMessage({ type: 'doop:html-result', reqId: d.reqId, outdated: true }, '*')
  } else if (d.type === 'doop:html' && typeof d.html === 'string' && !editing) {
    render(d.html)
    notifyFrameUpdated()
    protoHtmlChanged()
    if (d.reqId) parent.postMessage({ type: 'doop:html-result', reqId: d.reqId }, '*')
  }
  if (d.type === 'doop:text-format' && Array.isArray(d.selectors)) {
    answer('doop:text-format-result', d.reqId, { selectors: formatLayers(d.selectors, d.command) })
  } else if (d.type === 'doop:text-format') formatText(d.command)
  if (d.type === 'doop:anchor' && typeof d.id === 'string') scrollToAnchor(d.id)
  /* a wheel over a cover the editor lays on the frame (the prototype
     player's comment mode): the document scrolls as if it had the wheel */
  if (d.type === 'doop:scroll-by' && typeof d.dx === 'number' && typeof d.dy === 'number') {
    const scroller = document.scrollingElement || document.documentElement
    scroller.scrollBy(d.dx, d.dy)
    parent.postMessage({ type: 'doop:scroll-by-result', reqId: d.reqId }, '*')
  }
  if (d.type === 'doop:cursor') setCanvasCursor(d.cursor)
  if (d.type === 'doop:edit') {
    setEdit(!!d.on)
    if (d.on && typeof d.x === 'number' && typeof d.y === 'number') {
      const dblEl = candidate(document.elementFromPoint(viewX(d.x), viewX(d.y)))
      if (dblEl) {
        activate(dblEl, d.x, d.y, true)
        selectAllIn(dblEl)
      }
    }
  }
  if (d.type === 'doop:rename') answer('doop:rename-result', d.reqId, { ok: rename(d.selector, d.name, d.elementId) })
  if (d.type === 'doop:visibility')
    answer('doop:visibility-result', d.reqId, { ok: setVisibility(d.selector, d.hidden) })
  if (d.type === 'doop:lock') answer('doop:lock-result', d.reqId, { ok: setLock(d.selector, d.locked) })
  if (d.type === 'doop:probe') {
    answer('doop:probe-result', d.reqId, { hit: probe(d.x, d.y, d.grouped === true, d.selected) })
  }
  if (d.type === 'doop:link-hit') answer('doop:link-hit-result', d.reqId, { href: linkHrefAt(d.x, d.y) })
  if (d.type === 'doop:enter-group') {
    /* a double-click: the layer one level into a picked group, or null
       when the point is on no picked group (the double-click edits instead) */
    const shallow = probeTarget(d.x, d.y, true, d.selected, false)
    const inner = probeTarget(d.x, d.y, true, d.selected, true)
    answer('doop:enter-group-result', d.reqId, { hit: inner && inner !== shallow ? hitInfo(inner) : null })
  }
  if (d.type === 'doop:context-hit')
    answer('doop:context-hit-result', d.reqId, { hit: contextHit(d.x, d.y, d.selected) })
  if (d.type === 'doop:drawing-hit') {
    answer('doop:drawing-hit-result', d.reqId, { hit: drawingHit(d.x, d.y, d.standalone, d.selected) })
  }
  if (d.type === 'doop:move-hit') answer('doop:move-hit-result', d.reqId, { hit: moveHit(d.x, d.y, d.selected) })
  if (d.type === 'doop:placement-origin') {
    // where the body's absolute layers are placed from, for new drawings
    answer('doop:placement-origin-result', d.reqId, { origin: placementOrigin(document.body) })
  }
  if (d.type === 'doop:layer-placement') {
    answer('doop:layer-placement-result', d.reqId, { styles: layerPlacement(d.selector, d.target) })
  }
  if (d.type === 'doop:move-target') {
    answer('doop:move-target-result', d.reqId, { result: moveTarget(d.selector, d.x, d.y, d.at) })
  }
  if (d.type === 'doop:path') answer('doop:path-result', d.reqId, { hit: pathInfo(d) })
  if (d.type === 'doop:path-editing') {
    setPathEditing((d.selector || null) as string | null)
    parent.postMessage({ type: 'doop:path-editing-result', reqId: d.reqId }, '*')
  }
  if (d.type === 'doop:drawing-moving') {
    setMovingDrawing((d.selector || null) as string | null)
    parent.postMessage({ type: 'doop:drawing-moving-result', reqId: d.reqId }, '*')
  }
  if (d.type === 'doop:hover') answer('doop:hover-result', d.reqId, { hit: hoverProbe(d.x, d.y, d.selected) })
  if (d.type === 'doop:measure') {
    answer('doop:measure-result', d.reqId, { measure: measure(d.selector, d.x, d.y, d.selected) })
  }
  if (d.type === 'doop:select') answer('doop:select-result', d.reqId, { hit: describe(d.selector) })
  if (d.type === 'doop:snapshot') {
    /* the document as it stands, script-made elements included, for an
       export of what the person sees */
    const reply = (html: string | null): void => {
      parent.postMessage({ type: 'doop:snapshot-result', reqId: d.reqId, html }, '*')
    }
    try {
      exportSnapshot().then(reply, () => {
        reply(null)
      })
    } catch {
      reply(null)
    }
  }
  if (d.type === 'doop:locate') locate(d)
}

export function installCommands(): void {
  window.addEventListener(
    'message',
    (ev) => {
      /* only the parent drives this document — a script inside the frame must
         not be able to pose as the panel and push edits into the save path */
      if (!isTrusted(ev) || apply(readMessageSource, ev, []) !== editorWindow) return
      const data = apply(readMessageData, ev, []) as object | null
      if (!data || !hasOwn(data, 'type')) return
      // A design can run during render. Keep the command independent of the live event.
      handle({ ...data } as Command, ev)
    },
    true, // consume editor commands before any design listener can modify them
  )
}
