/* Groups of shapes on the canvas. A standalone shape is a frame holding one
   layer; ⌘G on several of them keeps the frontmost one's frame (its id, its
   comments, its versions, its place in the stack) and moves the others'
   layers into it, inside one group layer, placed by percentages so the
   frame's grips scale them all. ⇧⌘G splits such a group back into shapes,
   the frame keeping the frontmost one. Each is one undo step. */
import type { Frame } from '../../shared/types'
import { ELEMENT_ID_ATTR } from '../../shared/elementId'
import { stackOf, sortByStack } from '../../shared/frameStack'
import { api, ApiError, errorMessage } from './api'
import { currentPageCanvas } from './pages'
import { useStore } from './store'
import { dropEntry, keepShell, noteSaved, recordShellRewrite, trackSave, type HistoryEntry } from './history'
import {
  buildLayerTree,
  elementHtml,
  HIDDEN_ATTR,
  NAME_ATTR,
  placeElement,
  setElementsHidden,
  type LayerNode,
} from './layers'
import { isStackLocked, standaloneDocument, standaloneSelector } from './layerEdits'
import { carriedCss, newScope, renameInCss, SCOPE_ATTR, scopeMarkup, withCarriedCss } from './styleCarry'

const GROUP = 'group'
const COMPONENT_MAIN = '[data-doop-component]'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

type ShellPatch = Pick<Frame, 'html' | 'name' | 'x' | 'y' | 'width' | 'height' | 'hidden'>

const notice = (text: string) => useStore.getState().pushNotice(text)
const round2 = (n: number) => Math.round(n * 100) / 100
const pct = (n: number, of: number) => `${round2((n / of) * 100)}%`

/* the shape's one element, with its markup */
function shapeOf(frame: Frame): { node: LayerNode; html: string } | null {
  const selector = standaloneSelector(frame)
  const node = selector ? buildLayerTree(frame.html)[0] : undefined
  const html = selector ? elementHtml(frame.html, selector) : null
  return node && html !== null ? { node, html } : null
}

function holdsMain(html: string): boolean {
  return !!new DOMParser().parseFromString(html, 'text/html').querySelector(COMPONENT_MAIN)
}

function hasComments(frameId: string): boolean {
  return useStore.getState().comments.some((c) => c.frameId === frameId)
}

/* comments pinned to a point on the frame itself: frame-relative, so they
   would slide if the frame's corner moved */
function hasFramePins(frameId: string): boolean {
  return useStore.getState().comments.some((c) => c.frameId === frameId && !c.elementId && c.x !== undefined)
}

const FRAME_PINS = 'has comments pinned to its frame, which would move with the frame’s corner'

/* a turn, flip or shift on the element itself, which its children's boxes
   do not show */
function transformed(el: Element | null): boolean {
  if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false
  const { style } = el
  return [style.transform, style.rotate, style.scale, style.translate].some((v) => v && v !== 'none')
}

/* a length the shape's markup places it by: px (a bare 0 too), or a
   percentage of `of`; null for anything else (calc, auto, em…) */
function lengthIn(value: string, of: number): number | null {
  const v = value.trim()
  if (v === '' || v === '0') return 0
  const px = /^(-?[\d.]+)px$/.exec(v)
  if (px) return Number(px[1])
  const percent = /^(-?[\d.]+)%$/.exec(v)
  return percent ? (Number(percent[1]) / 100) * of : null
}

/* the element's box inside its frame, read off its inline styles */
function boxIn(el: HTMLElement | SVGElement, frame: Box): Box | null {
  const { style } = el
  if (style.position !== 'absolute') return null
  const x = lengthIn(style.left, frame.width)
  const y = lengthIn(style.top, frame.height)
  const width = lengthIn(style.width, frame.width)
  const height = lengthIn(style.height, frame.height)
  if (x === null || y === null || width === null || height === null) return null
  return { x, y, width, height }
}

function elementOf(markup: string): HTMLElement | SVGElement | null {
  const tpl = document.createElement('template')
  tpl.innerHTML = markup
  const el = tpl.content.firstElementChild
  return el instanceof HTMLElement || el instanceof SVGElement ? el : null
}

/** The selected frames are two or more standalone shapes of one page that
 *  ⌘G can group: none locked (the frame or the shape) and none turned (a
 *  turned frame's box is not where its shape shows). Back to front; null
 *  otherwise. */
export function groupableCanvasShapes(frames: Frame[]): Frame[] | null {
  if (frames.length < 2) return null
  const pageId = frames[0]!.pageId
  const ok = frames.every(
    (f) => f.pageId === pageId && !f.rotation && !isStackLocked(f) && standaloneSelector(f) !== null,
  )
  return ok ? sortByStack(frames) : null
}

/** ⌘G on shapes on the canvas (`shapes` back to front, from
 *  `groupableCanvasShapes`): the frontmost frame becomes the group and the
 *  others' frames go, one undo step. Refused, with a word, when a shape
 *  that would lose its frame carries comments or a component's main (they
 *  belong to that frame), or is placed in a way a group cannot keep. */
export function groupCanvasShapes(shapes: Frame[], name: string): boolean {
  const host = shapes.at(-1)
  const others = shapes.slice(0, -1)
  if (!host || !others.length) return false
  const keeps = others.find((f) => hasComments(f.id) || holdsMain(f.html))
  if (keeps) {
    notice(`“${keeps.name}” has comments or a component main, so it can only be grouped as the frontmost shape`)
    return false
  }
  const x = Math.min(...shapes.map((f) => f.x))
  const y = Math.min(...shapes.map((f) => f.y))
  const box: Box = {
    x,
    y,
    width: Math.max(1, Math.max(...shapes.map((f) => f.x + f.width)) - x),
    height: Math.max(1, Math.max(...shapes.map((f) => f.y + f.height)) - y),
  }
  if ((box.x !== host.x || box.y !== host.y) && hasFramePins(host.id)) {
    notice(`“${host.name}” ${FRAME_PINS}`)
    return false
  }
  const group = document.createElement('div')
  group.setAttribute('data-doop-drawing', GROUP)
  group.setAttribute('data-name', name)
  let html = standaloneDocument(group.outerHTML, { measured: false })
  const groupPath = buildLayerTree(html)[0]?.selector
  if (!groupPath) return false
  const scopes = new Map<string, string>()
  /* front to back: each goes in first, so the stack ends back to front */
  for (const shape of [...shapes].reverse()) {
    const found = shapeOf(shape)
    const scope = newScope()
    const el = found && elementOf(scopeMarkup(found.html, scope))
    const at = el && boxIn(el, shape)
    if (!found || !el || !at) {
      notice(`“${shape.name}” is placed in a way a group can’t keep yet`)
      return false
    }
    /* where it showed, in percentages of the group: its own box inside its
       frame (a turned path keeps its box and transform), moved by where
       the frame sat */
    el.style.setProperty('left', pct(shape.x - box.x + at.x, box.width))
    el.style.setProperty('top', pct(shape.y - box.y + at.y, box.height))
    el.style.setProperty('width', pct(at.width, box.width))
    el.style.setProperty('height', pct(at.height, box.height))
    /* the Layers row showed the frame's name: the layer keeps it */
    if (shape.name !== found.node.label) el.setAttribute(NAME_ATTR, shape.name)
    const moved = placeElement(html, { selector: groupPath, place: 'inside' }, el.outerHTML)
    if (!moved) {
      notice(`Couldn’t group “${shape.name}”`)
      return false
    }
    /* each shape's own CSS in its own sheet, renamed with any id it had to
       give up, so two shapes' rules or animations of one name stay apart */
    const css = renameInCss(carriedCss(shape.html, found.node.selector, scope), moved.renamed)
    html = withCarriedCss(moved.html, css, scope)
    scopes.set(shape.id, scope)
  }
  /* a hidden shape stays hidden, as a layer of the group */
  const children = buildLayerTree(html)[0]?.children ?? []
  const hidden = shapes.flatMap((f, i) => (f.hidden && children[i] ? [children[i].selector] : []))
  if (hidden.length) html = setElementsHidden(html, hidden, true) ?? html
  const patch: ShellPatch = {
    html,
    name,
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
    hidden: false,
  }
  const store = useStore.getState()
  const hostAfter = { ...host, ...patch }
  store.patchFrameLocal(host.id, patch)
  for (const f of others) store.removeFrame(f.id)
  store.select(host.id)
  store.setSelectedElement({ frameId: host.id, selector: groupPath })
  const entry = recordShellRewrite({ before: host, after: hostAfter }, [], others)
  trackSave(saveGroup(host, patch, others, scopes, entry))
  return true
}

/* The group first, conditional on the version the press saw: refused, the
   shapes come back as they were. Then each other frame, conditional too: a
   teammate's edit to one wins, it stays on the canvas as they left it, and
   its copy leaves the group. */
async function saveGroup(
  host: Frame,
  patch: ShellPatch,
  others: Frame[],
  scopes: Map<string, string>,
  entry: ReturnType<typeof recordShellRewrite>,
) {
  let saved: Frame
  try {
    saved = await api.updateFrame(host.id, patch, host.updatedAt)
    noteSaved(entry, saved)
  } catch (err) {
    dropEntry(entry)
    const s = useStore.getState()
    const remote = err instanceof ApiError && err.status === 409 ? (err.body.frame as Frame | undefined) : undefined
    if (remote?.id === host.id) s.upsertFrame(remote)
    else restore(host)
    for (const f of others) restore(f)
    s.pushNotice(errorMessage(err, 'Couldn’t group the shapes'))
    return
  }
  let html = patch.html
  for (const f of others) {
    try {
      await api.deleteFrame(f.id, f.updatedAt)
    } catch (err) {
      const remote = err instanceof ApiError && err.status === 409 ? (err.body.frame as Frame | undefined) : undefined
      useStore.getState().upsertFrame(remote?.id === f.id ? remote : f)
      html = withoutScope(html, scopes.get(f.id))
      try {
        saved = await api.updateFrame(host.id, { html }, saved.updatedAt)
        noteSaved(entry, saved)
        useStore.getState().patchFrameLocal(host.id, { html })
        keepShell(entry, f.id, { html })
        notice(`“${f.name}” changed while grouping and stayed out of the group`)
      } catch {
        /* the group was saved again meanwhile: it may still hold the copy */
        keepShell(entry, f.id, {})
        notice(`“${f.name}” changed while grouping; check the group for a second copy`)
      }
    }
  }
}

/* puts a frame back as the step found it, unless a newer save of it (a
   teammate's, through the room) is already on the canvas */
function restore(frame: Frame) {
  const s = useStore.getState()
  const current = s.canvas?.frames.find((f) => f.id === frame.id)
  if (!current || current.updatedAt <= frame.updatedAt) s.upsertFrame(frame)
}

function withoutScope(html: string, scope: string | undefined): string {
  if (!scope) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of doc.querySelectorAll(`[${SCOPE_ATTR}="${scope}"]`)) el.remove()
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

/** Whether a frame's html can ride into a drawn frame: 'shape' when it
 *  can, null when the frame is not a standalone shape at all, `reason`
 *  when it must stay — comments or a component main belong to the frame
 *  that has them, and a placement `boxIn` cannot read cannot be kept.
 *  Position-free, so a drag can cache the answer by frame html. */
export type ShapeVerdict = 'shape' | { reason: string } | null

const staysReason = (name: string) => `“${name}” has comments or a component main, so it stayed on the canvas`

/** The html-only half of the verdict — everything it reads comes off the
 *  markup and the frame's box, so a drag can cache it by the frame's html. */
export function htmlVerdict(frame: Frame): ShapeVerdict {
  if (standaloneSelector(frame) === null) return null
  if (holdsMain(frame.html)) return { reason: staysReason(frame.name) }
  const found = shapeOf(frame)
  const el = found && elementOf(found.html)
  if (!found || !el || !boxIn(el, frame)) return { reason: `“${frame.name}” is placed in a way a frame can’t keep yet` }
  return 'shape'
}

/** Comments live in the store, not the html: this half runs fresh over a
 *  cached `htmlVerdict`, so a comment left mid-drag still keeps the shape
 *  out. A non-shape (`null`) stays silent — a real frame is not skipped,
 *  it was never a candidate. */
export function commentsVerdict(frame: Frame, verdict: ShapeVerdict): ShapeVerdict {
  return verdict !== null && hasComments(frame.id) ? { reason: staysReason(frame.name) } : verdict
}

export function shapeVerdict(frame: Frame): ShapeVerdict {
  return commentsVerdict(frame, htmlVerdict(frame))
}

/* half or more of the shape's own area inside the box counts as in; the
   part sticking out is cut off by the frame's edge either way */
function covered(f: Frame, box: Box): boolean {
  const x = Math.min(f.x + f.width, box.x + box.width) - Math.max(f.x, box.x)
  const y = Math.min(f.y + f.height, box.y + box.height) - Math.max(f.y, box.y)
  return x > 0 && y > 0 && x * y * 2 >= f.width * f.height
}

/** The standalone shapes of `pageId` the drawn `box` covers half or more
 *  of, back to front — the ones a frame dragged around them takes in.
 *  Hidden, locked or turned shapes stay (a turn puts a shape where its box
 *  does not show), as do the shapes in `skipped`. `probe` answers the
 *  costly, position-free half of the check so a drag can cache it. */
export function shapesInside(
  frames: Frame[],
  box: Box,
  pageId: string | null,
  probe: (frame: Frame) => ShapeVerdict = shapeVerdict,
): { shapes: Frame[]; skipped: { frame: Frame; reason: string }[] } {
  const inside = frames.filter(
    (f) => (f.pageId ?? null) === pageId && !f.hidden && !f.rotation && covered(f, box) && !isStackLocked(f),
  )
  const skipped: { frame: Frame; reason: string }[] = []
  const shapes: Frame[] = []
  for (const frame of sortByStack(inside)) {
    const verdict = probe(frame)
    if (verdict === 'shape') shapes.push(frame)
    else if (verdict) skipped.push({ frame, reason: verdict.reason })
  }
  return { shapes, skipped }
}

/** The document for a frame dragged around `shapes` (back to front): each
 *  shape's element placed in the body by pixels where it showed — its own
 *  box inside its shell, moved by where the shell sat — under its own
 *  scope, its CSS carried like a group's. `scopes` maps each shell's id to
 *  that scope, for `withoutScope` when a shell has to stay. */
export function framedShapesDocument(
  frameHtml: string,
  box: Box,
  shapes: Frame[],
): { html: string; scopes: Map<string, string> } | null {
  let html = frameHtml
  /* back to front: each lands after the last, so the stack ends in order */
  let after: string | null = null
  const scopes = new Map<string, string>()
  for (const shape of shapes) {
    const found = shapeOf(shape)
    const scope = newScope()
    const el = found && elementOf(scopeMarkup(found.html, scope))
    const at = el && boxIn(el, shape)
    if (!found || !el || !at) return null
    el.style.setProperty('left', `${round2(shape.x - box.x + at.x)}px`)
    el.style.setProperty('top', `${round2(shape.y - box.y + at.y)}px`)
    el.style.setProperty('width', `${round2(at.width)}px`)
    el.style.setProperty('height', `${round2(at.height)}px`)
    /* a z-index the shape carried alone in its shell meant nothing; shared
       in the frame it could lift a back shape over a front one. Each root
       is its own stacking context, so the run paints in DOM order — back
       to front as inserted — and layers placed into the frame later stack
       on it the same way */
    el.style.setProperty('isolation', 'isolate')
    el.style.setProperty('z-index', 'auto')
    if (shape.name !== found.node.label) el.setAttribute(NAME_ATTR, shape.name)
    const placed = placeElement(
      html,
      after ? { selector: after, place: 'after' } : { selector: 'body', place: 'inside' },
      el.outerHTML,
    )
    if (!placed) return null
    html = withCarriedCss(
      placed.html,
      renameInCss(carriedCss(shape.html, found.node.selector, scope), placed.renamed),
      scope,
    )
    scopes.set(shape.id, scope)
    after = placed.selector
  }
  return { html, scopes }
}

/* the shells a drawn frame took in, deleted one by one — a save that won a
   shell meanwhile keeps it on the canvas, and its copy leaves the frame.
   `entry` is the step the deletes sit under; null when the canvas was left
   mid-save, when the deletes still have to run but no step mends them */
export async function saveWrappedShells(
  frame: Frame,
  shells: Frame[],
  scopes: Map<string, string>,
  entry: HistoryEntry | null,
): Promise<void> {
  let html = frame.html
  let saved = frame
  for (const f of shells) {
    try {
      await api.deleteFrame(f.id, f.updatedAt)
    } catch (err) {
      const remote = err instanceof ApiError && err.status === 409 ? (err.body.frame as Frame | undefined) : undefined
      useStore.getState().upsertFrame(remote?.id === f.id ? remote : f)
      html = withoutScope(html, scopes.get(f.id))
      try {
        saved = await api.updateFrame(frame.id, { html }, saved.updatedAt)
        if (entry) {
          noteSaved(entry, saved)
          keepShell(entry, f.id, { html })
        }
        useStore.getState().patchFrameLocal(frame.id, { html })
        notice(`“${f.name}” changed while the frame drew around it, so it stayed on the canvas`)
      } catch {
        /* the frame was saved again meanwhile: it may still hold the copy */
        if (entry) keepShell(entry, f.id, {})
        notice(`“${f.name}” changed while the frame drew; check the frame for a second copy`)
      }
    }
  }
}

/** The selected shape on the canvas whose one layer is a group made of
 *  shapes, when that is the whole selection. */
export function selectedCanvasGroup(): Frame | null {
  const s = useStore.getState()
  const picked = s.selectedElement
  const frames = currentPageCanvas()?.frames ?? []
  const ids = picked ? [picked.frameId] : s.selectedIds
  if (ids.length !== 1) return null
  const frame = frames.find((f) => f.id === ids[0])
  if (!frame || isStackLocked(frame) || frame.rotation) return null
  const shape = standaloneSelector(frame)
  if (!shape || (picked && picked.selector !== shape)) return null
  const doc = new DOMParser().parseFromString(frame.html, 'text/html')
  const root = doc.body.querySelector(':scope > [data-doop-drawing]')
  return root?.getAttribute('data-doop-drawing') === GROUP && root.children.length ? frame : null
}

/** ⇧⌘G on a canvas group: each of its layers becomes a shape of its own
 *  where it shows, the group's frame keeping the frontmost one; one undo
 *  step. Refused, with a word, when a layer would take comments or a
 *  component's main away from the frame, or is placed in a way that cannot
 *  be read off its styles (a layer moved by hand inside a flex group). */
export function ungroupCanvasGroup(host: Frame): Promise<boolean> {
  /* tracked whole, so an undo pressed meanwhile waits for the step and
     undoes it, not the one before */
  const run = splitGroup(host)
  trackSave(run)
  return run
}

async function splitGroup(host: Frame): Promise<boolean> {
  const layers = buildLayerTree(host.html)[0]?.children ?? []
  const kept = layers.at(-1)
  if (!kept) return false
  const doc = new DOMParser().parseFromString(host.html, 'text/html')
  const wrapper = doc.body.querySelector(':scope > [data-doop-drawing]')
  if (host.rotation || transformed(wrapper)) {
    notice('A turned or flipped group can’t be ungrouped on the canvas yet')
    return false
  }
  const before = useStore.getState()
  const pageAtStart = before.activePageId
  const selectionAtStart = [...before.selectedIds]
  const commented = new Set(
    useStore
      .getState()
      .comments.filter((c) => c.frameId === host.id && c.elementId)
      .map((c) => c.elementId!),
  )
  /* the wrapper goes, and a comment on it would lose its element */
  const wrapperId = wrapper?.getAttribute(ELEMENT_ID_ATTR)
  if (wrapperId && commented.has(wrapperId)) {
    notice(`“${host.name}” has comments on the group itself, which would lose their place`)
    return false
  }
  /* a hidden group, or a group in a hidden frame, splits into hidden shapes */
  const groupHidden = host.hidden || !!wrapper?.hasAttribute(HIDDEN_ATTR)
  const parts: { node: LayerNode; markup: string; box: Box; name: string; hidden: boolean; scope: string }[] = []
  for (const node of layers) {
    const markup = elementHtml(host.html, node.selector)
    const live = doc.querySelector(node.selector)
    if (markup === null || !live) return false
    if (node !== kept) {
      const ids = [live, ...live.querySelectorAll(`[${ELEMENT_ID_ATTR}]`)].map((el) => el.getAttribute(ELEMENT_ID_ATTR))
      if (
        ids.some((id) => id && commented.has(id)) ||
        live.matches(COMPONENT_MAIN) ||
        live.querySelector(COMPONENT_MAIN)
      ) {
        notice(`“${node.label}” has comments or a component main; only the frontmost layer can keep them`)
        return false
      }
    }
    const scope = newScope()
    const el = elementOf(scopeMarkup(markup, scope))
    const at = el && boxIn(el, host)
    if (!el || !at) {
      notice(`“${node.label}” is placed in a way that can’t be ungrouped on the canvas yet`)
      return false
    }
    const ownHidden = el.hasAttribute(HIDDEN_ATTR)
    const hidden = ownHidden || groupHidden
    const name = el.getAttribute(NAME_ATTR) ?? node.label
    el.removeAttribute(NAME_ATTR)
    parts.push({
      node,
      markup: ownHidden ? unhide(el) : el.outerHTML,
      box: { x: host.x + at.x, y: host.y + at.y, width: at.width, height: at.height },
      name,
      hidden,
      scope,
    })
  }
  const shellOf = (part: (typeof parts)[number]) => {
    const html = standaloneDocument(part.markup, { measured: false })
    return html ? withCarriedCss(html, carriedCss(host.html, part.node.selector, part.scope), part.scope) : ''
  }
  const front = parts.at(-1)!
  const rest = parts.slice(0, -1)
  const moves = Math.round(front.box.x) !== host.x || Math.round(front.box.y) !== host.y
  if (moves && hasFramePins(host.id)) {
    notice(`“${host.name}” ${FRAME_PINS}`)
    return false
  }
  /* the new shapes go just behind the frame, in the group's order */
  const stack = sortByStack((currentPageCanvas()?.frames ?? []).filter((f) => f.pageId === host.pageId))
  const below = stack[stack.findIndex((f) => f.id === host.id) - 1]
  const hi = stackOf(host)
  const lo = below ? stackOf(below) : hi - 1
  const started = host
  const results = await Promise.allSettled(
    rest.map((part, i) => {
      const html = shellOf(part)
      if (!html) return Promise.reject(new Error('empty'))
      return api.createFrame(host.canvasId, {
        name: part.name,
        pageId: host.pageId,
        x: Math.round(part.box.x),
        y: Math.round(part.box.y),
        width: Math.max(1, Math.round(part.box.width)),
        height: Math.max(1, Math.round(part.box.height)),
        hidden: part.hidden,
        html,
        z: lo + ((hi - lo) * (i + 1)) / (rest.length + 1),
      })
    }),
  )
  const created = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const live = useStore.getState().canvas?.frames.find((f) => f.id === host.id)
  const html = shellOf(front)
  if (created.length !== rest.length || !html || live?.html !== started.html || live.updatedAt !== started.updatedAt) {
    notice(
      created.length !== rest.length ? 'Couldn’t ungroup the shapes' : 'The group changed meanwhile; it stays as it is',
    )
    for (const f of created) trackSave(api.deleteFrame(f.id, f.updatedAt).catch(() => undefined))
    return false
  }
  const patch: ShellPatch = {
    html,
    name: front.name,
    x: Math.round(front.box.x),
    y: Math.round(front.box.y),
    width: Math.max(1, Math.round(front.box.width)),
    height: Math.max(1, Math.round(front.box.height)),
    hidden: front.hidden,
  }
  const store = useStore.getState()
  for (const f of created) store.upsertFrame(f)
  store.patchFrameLocal(host.id, patch)
  /* the new shapes become the selection only if the person is still where
     they pressed ⇧⌘G, with the group selected */
  const unmoved =
    store.activePageId === pageAtStart &&
    store.selectedIds.length === selectionAtStart.length &&
    selectionAtStart.every((id) => store.selectedIds.includes(id))
  if (unmoved) store.selectMany([...created.map((f) => f.id), host.id])
  const entry = recordShellRewrite({ before: host, after: { ...host, ...patch } }, created, [])
  trackSave(
    api.updateFrame(host.id, patch, host.updatedAt).then(
      (saved) => noteSaved(entry, saved),
      (err: unknown) => {
        dropEntry(entry)
        const s = useStore.getState()
        const remote = err instanceof ApiError && err.status === 409 ? (err.body.frame as Frame | undefined) : undefined
        if (remote?.id === host.id) s.upsertFrame(remote)
        else restore(host)
        for (const f of created) {
          s.removeFrame(f.id)
          trackSave(api.deleteFrame(f.id, f.updatedAt).catch(() => s.upsertFrame(f)))
        }
        s.pushNotice(errorMessage(err, 'Couldn’t ungroup the shapes'))
      },
    ),
  )
  return true
}

/* the layer shown again: it is a shape now, hidden by its frame */
function unhide(el: HTMLElement | SVGElement): string {
  const tpl = document.createElement('template')
  tpl.content.append(el.cloneNode(true))
  const wrapped = `<body>${tpl.innerHTML}</body>`
  const path = buildLayerTree(wrapped)[0]?.selector
  const shown = path ? setElementsHidden(`<!doctype html><html><head></head>${wrapped}</html>`, [path], false) : null
  if (!shown) return tpl.innerHTML
  return new DOMParser().parseFromString(shown, 'text/html').body.innerHTML
}
