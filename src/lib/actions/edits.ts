/* What the action registry's entries do to the canvas: the Object,
   Arrange, Text and Edit commands carried over to frames on the page and to
   the HTML layers inside them. Frames move through the frame API (one undo
   step per command); layers change through the frame runtime's live style
   and geometry edits, or as a rewrite of the frame's HTML. */

import type { Frame } from '../../../shared/types'
import { canvasPages } from '../../../shared/pages'
import { readingOrder } from '../../../shared/frameOrder'
import { normalizeRotation } from '../../../shared/frameRotation'
import { api } from '../api'
import { t } from '../i18n'
import { canEditOpenCanvas, pickedSelectors, useStore } from '../store'
import { currentPageCanvas } from '../pages'
import { recordUpdates, trackSave } from '../history'
import { isCanvasElement } from '../drawing'
import {
  computedStyles,
  editElementGeometry,
  inspectElement,
  styleElement,
  type ElementInfo,
  type GeometryEdit,
  type StylePatch,
} from '../frameBridge'
import {
  buildLayerTree,
  elementPath,
  findLayer,
  groupElements,
  isElementHidden,
  setElementLink,
  elementLink,
  ungroupElements,
  type LayerNode,
} from '../layers'
import { isLayerLocked, saveFrameHtml, setFramesHidden, setLayersHidden, standaloneSelector } from '../layerEdits'
import {
  alignBoxes,
  distributeEdges,
  distributeSpacing,
  packBoxes,
  tidyUp,
  type AlignEdge,
  type Axis,
  type Box,
  type DistributeEdge,
  type Spot,
} from './arrange'

/* ---- what is selected ---- */

export interface Picked {
  frame: Frame
  selectors: string[]
  /** the frame's one shape is picked: the pick is a page-level object */
  standalone: boolean
}

/** The picked layers and their frame, or null with no element picked. */
export function pickedLayers(): Picked | null {
  const s = useStore.getState()
  const picked = s.selectedElement
  const frame = picked ? s.canvas?.frames.find((f) => f.id === picked.frameId) : undefined
  if (!picked || !frame) return null
  const selectors = pickedSelectors(s)
  return { frame, selectors, standalone: selectors.length === 1 && standaloneSelector(frame) === selectors[0] }
}

/** Layers inside a frame (not a standalone shape) are picked. */
export function hasInnerPick(): boolean {
  const p = pickedLayers()
  return !!p && !p.standalone
}

/** Frames on the page that are selected, when no layer inside one is. A
 *  standalone shape picked as its own layer counts as its frame. */
export function selectedFrames(): Frame[] {
  const s = useStore.getState()
  const p = pickedLayers()
  if (p && !p.standalone) return []
  const frames = currentPageCanvas()?.frames ?? []
  return frames.filter((f) => s.selectedIds.includes(f.id))
}

export const canEdit = () => canEditOpenCanvas(useStore.getState())
const notice = (text: string) => useStore.getState().pushNotice(text)

/* ---- frames: moved, turned, rounded as one undo step ---- */

type FramePatch = Partial<Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'rotation'>>

/** Patch several frames as one undo step and one save each. */
export function patchFrames(changes: { frame: Frame; patch: FramePatch }[]) {
  const real = changes.filter(({ frame, patch }) =>
    (Object.keys(patch) as (keyof FramePatch)[]).some((k) => frame[k] !== patch[k]),
  )
  if (!real.length) return
  recordUpdates(
    real.map(({ frame, patch }) => {
      const before: FramePatch = {}
      for (const k of Object.keys(patch) as (keyof FramePatch)[]) before[k] = frame[k] as never
      return { frameId: frame.id, before, after: patch }
    }),
  )
  const store = useStore.getState()
  for (const { frame, patch } of real) store.patchFrameLocal(frame.id, patch)
  trackSave(
    Promise.all(
      real.map(({ frame, patch }) =>
        /* a straight frame keeps no rotation, which JSON would drop: send 0 */
        api.updateFrame(frame.id, 'rotation' in patch ? { ...patch, rotation: patch.rotation ?? 0 } : patch),
      ),
    ).catch(console.error),
  )
}

const boxOf = (f: Frame): Box => ({ x: f.x, y: f.y, width: f.width, height: f.height })

function arrangeFrames(frames: Frame[], place: (boxes: Box[]) => Spot[]): boolean {
  const movable = frames.filter((f) => !f.locked)
  if (movable.length < 2) return false
  const spots = place(movable.map(boxOf))
  patchFrames(movable.map((frame, i) => ({ frame, patch: { x: Math.round(spots[i]!.x), y: Math.round(spots[i]!.y) } })))
  return true
}

/* ---- layers: placed through the runtime's geometry edits ---- */

async function infosOf(frame: Frame, selectors: string[]) {
  const infos = await Promise.all(selectors.map((selector) => inspectElement(frame.id, selector)))
  return selectors
    .map((selector, i) => ({ selector, info: infos[i] }))
    .filter((x): x is { selector: string; info: ElementInfo } => !!x.info && x.info.geometry.enabled)
}

/** Move each picked layer to where `place` puts its box, in frame px. */
async function arrangeLayers(p: Picked, place: (boxes: Box[]) => Spot[], min = 2): Promise<boolean> {
  if (p.frame.locked) return false
  const items = await infosOf(p.frame, p.selectors)
  if (items.length < min) return false
  const spots = place(items.map(({ info }) => info.rect))
  await Promise.all(
    items.map(({ selector, info }, i) => {
      const dx = spots[i]!.x - info.rect.x
      const dy = spots[i]!.y - info.rect.y
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return null
      /* `move` places the layer's box in frame px, the space the boxes were read in */
      return editElementGeometry(p.frame.id, selector, { kind: 'move', x: spots[i]!.x, y: spots[i]!.y })
    }),
  )
  return true
}

const ALIGN_GEOMETRY: Record<AlignEdge, { axis: Axis; edge: 'start' | 'center' | 'end' }> = {
  left: { axis: 'x', edge: 'start' },
  hcenter: { axis: 'x', edge: 'center' },
  right: { axis: 'x', edge: 'end' },
  top: { axis: 'y', edge: 'start' },
  vcenter: { axis: 'y', edge: 'center' },
  bottom: { axis: 'y', edge: 'end' },
}

/** ⌥A and friends: frames line up with each other; one layer lines up in
 *  its parent (as the Design panel's align buttons do), several with each
 *  other. */
export function align(edge: AlignEdge): boolean {
  const p = pickedLayers()
  if (p && !p.standalone) {
    if (p.selectors.length === 1) {
      const { axis, edge: to } = ALIGN_GEOMETRY[edge]
      void editElementGeometry(p.frame.id, p.selectors[0]!, { kind: 'align', axis, edge: to })
      return true
    }
    void arrangeLayers(p, (boxes) => alignBoxes(boxes, edge))
    return true
  }
  return arrangeFrames(selectedFrames(), (boxes) => alignBoxes(boxes, edge))
}

/** The selection, frames or layers, laid out by `place`; `min` is how many
 *  it takes for the command to mean anything. */
function arrange(place: (boxes: Box[]) => Spot[], min: number): boolean {
  const p = pickedLayers()
  if (p && !p.standalone) {
    if (p.selectors.length < min) return false
    void arrangeLayers(p, place, min)
    return true
  }
  const frames = selectedFrames()
  return frames.length >= min && arrangeFrames(frames, place)
}

export const distributeSpacingOf = (axis: Axis) => arrange((boxes) => distributeSpacing(boxes, axis), 3)
export const distributeEdgesOf = (axis: Axis, edge: DistributeEdge) =>
  arrange((boxes) => distributeEdges(boxes, axis, edge), 3)
export const tidy = () => arrange((boxes) => tidyUp(boxes), 2)
export const pack = (axis: Axis) => arrange((boxes) => packBoxes(boxes, axis), 2)

/** Arrange commands need two (align, pack, tidy) or three (distribute) things selected. */
export function arrangeCount(): number {
  const p = pickedLayers()
  if (p && !p.standalone) return p.selectors.length
  return selectedFrames().length
}

/** Round to pixel: the selected frames' position and size to whole pixels. */
export function roundFramesToPixel(): boolean {
  const frames = selectedFrames().filter((f) => !f.locked)
  if (!frames.length) return false
  patchFrames(
    frames.map((frame) => ({
      frame,
      patch: {
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        width: Math.max(1, Math.round(frame.width)),
        height: Math.max(1, Math.round(frame.height)),
      },
    })),
  )
  return true
}

/* ---- turning and flipping ---- */

/** Flip the picked layers (frames do not flip). */
export function flip(axis: 'x' | 'y'): boolean {
  const p = pickedLayers()
  if (!p || p.frame.locked) return false
  for (const selector of p.selectors) void editElementGeometry(p.frame.id, selector, { kind: 'flip', axis })
  return true
}

/** Turn the picked layers, else the selected frames, by `by` degrees clockwise. */
export function rotateBy(by: number): boolean {
  const p = pickedLayers()
  if (p && !p.standalone) {
    if (p.frame.locked) return false
    void infosOf(p.frame, p.selectors).then((items) => {
      for (const { selector, info } of items) {
        if (info.geometry.rotation === null) continue
        const edit: GeometryEdit = { kind: 'rotate', value: info.geometry.rotation + by }
        void editElementGeometry(p.frame.id, selector, edit)
      }
    })
    return true
  }
  const frames = selectedFrames().filter((f) => !f.locked)
  if (!frames.length) return false
  patchFrames(frames.map((frame) => ({ frame, patch: { rotation: normalizeRotation((frame.rotation ?? 0) + by) } })))
  return true
}

/* ---- grouping and auto layout ---- */

function pickAfterRewrite(frame: Frame, selectors: string[]) {
  const store = useStore.getState()
  store.select(frame.id)
  store.pickElements(frame.id, selectors)
}

/** ⌘G (and ⌥⌘G, "Frame selection"): the picked layers wrapped in one box. */
export function groupSelection(kind: 'group' | 'frame'): boolean {
  const p = pickedLayers()
  if (!p || p.standalone || p.frame.locked) return false
  if (p.selectors.some((s) => isLayerLocked(p.frame, s))) return false
  void groupKeepingLayout(p, kind === 'group' ? t('actions.groupName') : t('actions.frameName'))
  return true
}

/** The frame as it is now, when it is still the document the pick was made
 *  in; null (with a notice) when an edit landed meanwhile, since positional
 *  layer paths may then name other layers. */
function unchangedFrame(picked: Frame): Frame | null {
  const live = useStore.getState().canvas?.frames.find((f) => f.id === picked.id)
  if (live && live.html === picked.html && !live.locked) return live
  notice(t('actions.frameChanged'))
  return null
}

/* The path of the box around `selector`, or null for a root it has none for. */
function parentPath(selector: string): string | null {
  const at = selector.lastIndexOf(' > ')
  return at === -1 ? null : selector.slice(0, at)
}

/** How a new box must lay out what it takes from `parent` so nothing moves:
 *  a flex parent's flow, carried onto the box (the box itself becomes one
 *  flex item); none for a parent in normal flow. Null for a grid, whose
 *  tracks a wrapper cannot keep. */
async function inheritedLayout(frameId: string, parent: string | null): Promise<string | null | undefined> {
  if (!parent) return undefined
  const cs = await computedStyles(frameId, parent, [
    'display',
    'flex-direction',
    'flex-wrap',
    'align-items',
    'justify-content',
    'row-gap',
    'column-gap',
  ])
  if (!cs) return undefined
  if (/grid/.test(cs.display ?? '')) return null
  if (!/flex/.test(cs.display ?? '')) return undefined
  return [
    'display: flex',
    `flex-direction: ${cs['flex-direction']}`,
    `flex-wrap: ${cs['flex-wrap']}`,
    `align-items: ${cs['align-items']}`,
    `justify-content: ${cs['justify-content']}`,
    `gap: ${cs['row-gap']} ${cs['column-gap']}`,
  ].join('; ')
}

async function groupKeepingLayout(p: Picked, name: string) {
  const style = await inheritedLayout(p.frame.id, parentPath(p.selectors[0]!))
  if (style === null) {
    notice(t('actions.groupGridFailed'))
    return
  }
  /* the picked paths are positions: if the frame changed while its layout
     was read, they may name other layers now */
  const live = unchangedFrame(p.frame)
  if (!live) return
  const grouped = groupElements(live.html, p.selectors, { name, style })
  if (!grouped) {
    notice(t('actions.groupFailed'))
    return
  }
  saveFrameHtml(live, grouped.html)
  pickAfterRewrite(live, [grouped.selector])
}

/** ⇧⌘G / ⌘⌫: each picked box gives way to what it holds. */
export function ungroupSelection(): boolean {
  const p = pickedLayers()
  if (!p || p.standalone || p.frame.locked) return false
  const freed = ungroupElements(p.frame.html, p.selectors)
  if (!freed) {
    notice(t('actions.ungroupFailed'))
    return true
  }
  saveFrameHtml(p.frame, freed.html)
  pickAfterRewrite(p.frame, freed.selectors)
  return true
}

/** Which way a run of boxes goes, and the space between the first two:
 *  in auto layout that space is the gap, as auto layout reads it. */
function flowOf(rects: Box[]): { direction: 'row' | 'column'; gap: number } {
  const [a, b] = [...rects].sort((m, n) => m.y - n.y || m.x - n.x)
  if (!a || !b) return { direction: 'column', gap: 0 }
  const sideBySide = b.x >= a.x + a.width - 1 || a.x >= b.x + b.width - 1
  const space = sideBySide ? b.x - (a.x + a.width) : b.y - (a.y + a.height)
  return { direction: sideBySide ? 'row' : 'column', gap: Math.max(0, Math.round(space)) }
}

/* the margins along the flow, which a gap replaces: flex margins do not
   collapse, so left on, they would add to the gap */
const flowMargins = (direction: 'row' | 'column') =>
  direction === 'row' ? (['margin-left', 'margin-right'] as const) : (['margin-top', 'margin-bottom'] as const)

const childSelectors = (frame: Frame, selector: string): string[] =>
  (findLayer(buildLayerTree(frame.html), selector)?.children ?? []).map((n: LayerNode) => n.selector)

async function rectsOf(frameId: string, selectors: string[]): Promise<Box[]> {
  const infos = await Promise.all(selectors.map((s) => inspectElement(frameId, s)))
  return infos.flatMap((info) => (info ? [info.rect] : []))
}

/** ⇧A: a box holding layers becomes a flex container laid out the way its
 *  children already run; anything else (a leaf, several siblings, a box
 *  already in auto layout) is wrapped in a new auto layout box. The space
 *  between the layers becomes the gap and their margins along the flow go,
 *  so nothing moves. */
export async function addAutoLayout(): Promise<boolean> {
  const p = pickedLayers()
  if (!p || p.standalone || p.frame.locked) return false
  const { frame, selectors } = p
  if (selectors.length === 1) {
    const selector = selectors[0]!
    const children = childSelectors(frame, selector)
    const info = await inspectElement(frame.id, selector)
    if (info && children.length && !/flex|grid/.test(info.display)) {
      const { direction, gap } = flowOf(await rectsOf(frame.id, children.slice(0, 2)))
      const [lead, trail] = flowMargins(direction)
      await styleElement(frame.id, selector, { display: 'flex', 'flex-direction': direction, gap: `${gap}px` })
      /* only the margins between children: the gap takes their place, and the
         first child's leading and the last one's trailing margin stay */
      const last = children.length - 1
      await Promise.all(
        children.map((child, i) => {
          const patch: StylePatch = {}
          if (i > 0) patch[lead] = '0px'
          if (i < last) patch[trail] = '0px'
          return Object.keys(patch).length ? styleElement(frame.id, child, patch) : null
        }),
      )
      return true
    }
  }
  const { direction, gap } = flowOf(await rectsOf(frame.id, selectors))
  const [lead, trail] = flowMargins(direction)
  /* the run's outer margins move onto the new box, which takes its place */
  const first = selectors[0]!
  const last = selectors[selectors.length - 1]!
  const [outerLead, outerTrail] = await Promise.all([
    computedStyles(frame.id, first, [lead]),
    computedStyles(frame.id, last, [trail]),
  ])
  const live = unchangedFrame(frame)
  if (!live) return true
  const grouped = groupElements(live.html, selectors, {
    name: t('actions.frameName'),
    style: [
      `display: flex; flex-direction: ${direction}; gap: ${gap}px`,
      outerLead?.[lead] ? `${lead}: ${outerLead[lead]}` : '',
      outerTrail?.[trail] ? `${trail}: ${outerTrail[trail]}` : '',
    ]
      .filter(Boolean)
      .join('; '),
    childStyle: { [lead]: '0px', [trail]: '0px' },
  })
  if (!grouped) {
    notice(t('actions.groupFailed'))
    return true
  }
  saveFrameHtml(live, grouped.html)
  pickAfterRewrite(live, [grouped.selector])
  return true
}

/** ⌥⇧A: the picked boxes stop being flex containers. */
export function removeAutoLayout(): boolean {
  /* an explicit display, since a class may be what makes the box flex */
  return styleEach((info) =>
    /flex|grid/.test(info.display)
      ? { display: info.display.startsWith('inline') ? 'inline-block' : 'block', 'flex-direction': null, gap: null }
      : null,
  )
}

/* ---- styles on the picked layers ---- */

/** The same inline styles on every picked layer, saved as one edit. */
export function styleEach(styles: StylePatch | ((info: ElementInfo) => StylePatch | null)): boolean {
  const p = pickedLayers()
  if (!p || p.frame.locked) return false
  for (const selector of p.selectors) {
    if (typeof styles !== 'function') {
      void styleElement(p.frame.id, selector, styles)
      continue
    }
    void inspectElement(p.frame.id, selector).then((info) => {
      const patch = info && styles(info)
      if (patch) void styleElement(p.frame.id, selector, patch)
    })
  }
  return true
}

/** ⌥/: no background on the picked layers. */
export const removeFill = () => styleEach({ 'background-color': 'transparent', 'background-image': 'none' })

/** Text alignment, case and size on the picked layers. */
export const textAlign = (value: 'left' | 'center' | 'right' | 'justify') => styleEach({ 'text-align': value })
export const textCase = (value: 'uppercase' | 'lowercase' | 'capitalize' | 'none') =>
  styleEach({ 'text-transform': value === 'none' ? null : value })
export const fontSizeBy = (step: number) =>
  styleEach((info) => (info.fontSize ? { 'font-size': `${Math.max(1, info.fontSize + step)}px` } : null))

/* ---- copy and paste properties: what a layer looks like, never where it is ---- */

const VISUAL_PROPERTIES = [
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'box-shadow',
  'opacity',
  'filter',
  'backdrop-filter',
  'mix-blend-mode',
] as const

const TEXT_PROPERTIES = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-decoration-line',
  'text-align',
] as const

const STYLE_CLIP_KEY = 'doop:style-clip'

interface StyleClip {
  visual: Record<string, string>
  /** only a layer with text of its own lends its type: on a box the same
   *  properties would cascade into every child */
  text: Record<string, string> | null
}

/** ⌥⌘C: the primary picked layer's look onto the style clipboard. */
export async function copyProperties(): Promise<boolean> {
  const s = useStore.getState()
  const picked = s.selectedElement
  if (!picked) return false
  const [visual, info] = await Promise.all([
    computedStyles(picked.frameId, picked.selector, [...VISUAL_PROPERTIES, ...TEXT_PROPERTIES]),
    inspectElement(picked.frameId, picked.selector),
  ])
  if (!visual || !info) return false
  const text = info.hasText ? Object.fromEntries(TEXT_PROPERTIES.map((k) => [k, visual[k] ?? ''])) : null
  const clip: StyleClip = { visual: Object.fromEntries(VISUAL_PROPERTIES.map((k) => [k, visual[k] ?? ''])), text }
  try {
    localStorage.setItem(STYLE_CLIP_KEY, JSON.stringify(clip))
  } catch {
    return false
  }
  notice(t('actions.propertiesCopied'))
  return true
}

function styleClip(): StyleClip | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STYLE_CLIP_KEY) ?? 'null')
    return parsed && typeof parsed === 'object' && 'visual' in parsed ? (parsed as StyleClip) : null
  } catch {
    return null
  }
}

export const hasStyleClip = () => !!styleClip()

/** ⌥⌘V: the copied look onto every picked layer, type only onto text. */
export function pasteProperties(): boolean {
  const clip = styleClip()
  if (!clip) return false
  return styleEach((info) => ({ ...clip.visual, ...(clip.text && info.hasText ? clip.text : {}) }))
}

/* ---- pick a colour from anywhere on screen ---- */

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> }

export const canPickColor = () => typeof (window as { EyeDropper?: EyeDropperCtor }).EyeDropper === 'function'

/** ⌃C: the eyedropper. The colour fills the picked layers (text layers take
 *  it as their ink) and lands on the clipboard either way. */
export async function pickColor(): Promise<void> {
  const Dropper = (window as { EyeDropper?: EyeDropperCtor }).EyeDropper
  if (!Dropper) return
  let hex: string
  try {
    hex = (await new Dropper().open()).sRGBHex
  } catch {
    return // Esc
  }
  void navigator.clipboard?.writeText(hex).catch(() => {})
  if (canEdit() && pickedLayers()) {
    styleEach((info): StylePatch => (info.hasText ? { color: hex } : { 'background-color': hex }))
  } else notice(t('actions.colorCopied', { color: hex }))
}

/* ---- links ---- */

/** The primary picked layer's link target, if it is, holds or sits in one. */
export function pickedLink(): string | null {
  const p = pickedLayers()
  if (!p) return null
  return elementLink(p.frame.html, p.selectors[p.selectors.length - 1]!)
}

/** ⇧⌘U: link the picked layers to `href`, or unlink them with null. */
export function linkSelection(href: string | null): boolean {
  const p = pickedLayers()
  if (!p || p.frame.locked) return false
  let html = p.frame.html
  const picked: string[] = []
  for (const selector of p.selectors) {
    const linked = isLayerLocked(p.frame, selector) ? null : setElementLink(html, selector, href)
    if (linked) html = linked.html
    picked.push(linked?.selector ?? selector)
  }
  if (html === p.frame.html) return false
  saveFrameHtml(p.frame, html)
  pickAfterRewrite(p.frame, picked)
  return true
}

/* ---- selecting ---- */

/** ⇧⌘A: everything beside the selection instead of it — the picked layers'
 *  other siblings, or the page's other frames. */
export function selectInverse(): boolean {
  const s = useStore.getState()
  const p = pickedLayers()
  if (p && !p.standalone) {
    const primary = s.selectedElement!.selector
    const tree = buildLayerTree(p.frame.html)
    const node = findLayer(tree, primary)
    if (!node) return false
    const parentPath = primary.includes(' > ') ? primary.slice(0, primary.lastIndexOf(' > ')) : null
    const siblings = parentPath ? (findLayer(tree, parentPath)?.children ?? tree) : tree
    const others = siblings.filter((n) => !n.locked && !p.selectors.includes(n.selector)).map((n) => n.selector)
    /* everything was picked: its inverse is nothing */
    if (!others.length) s.select(null)
    else s.pickElements(p.frame.id, others)
    return true
  }
  const frames = currentPageCanvas()?.frames ?? []
  const others = frames.filter((f) => !s.selectedIds.includes(f.id) && !f.locked).map((f) => f.id)
  s.pickElement(null)
  if (!others.length) s.select(null)
  else s.selectMany(others)
  return true
}

/** ⌥⌘A: every layer in the frame shaped like the picked one: the same tag
 *  and the same classes. */
export function selectMatching(): boolean {
  const s = useStore.getState()
  const p = pickedLayers()
  if (!p || p.standalone) return false
  const doc = new DOMParser().parseFromString(p.frame.html, 'text/html')
  let el: Element | null = null
  try {
    el = doc.querySelector(s.selectedElement!.selector)
  } catch {
    return false
  }
  if (!el) return false
  const classes = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).sort().join(' ')
  const matches = [...doc.body.getElementsByTagName(el.tagName)].filter(
    (m) => (m.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).sort().join(' ') === classes,
  )
  if (matches.length < 2) return false
  s.pickElements(p.frame.id, [...matches.filter((m) => m !== el).map(elementPath), s.selectedElement!.selector])
  return true
}

/** Hide other layers: the picked layers' siblings, or the page's other frames. */
export function hideOthers(): boolean {
  const s = useStore.getState()
  const p = pickedLayers()
  if (p && !p.standalone) {
    const tree = buildLayerTree(p.frame.html)
    const primary = s.selectedElement!.selector
    const parentPath = primary.includes(' > ') ? primary.slice(0, primary.lastIndexOf(' > ')) : null
    const siblings = parentPath ? (findLayer(tree, parentPath)?.children ?? tree) : tree
    const others = siblings
      .filter((n) => !p.selectors.includes(n.selector) && isElementHidden(p.frame.html, n.selector) === false)
      .map((n) => n.selector)
    return others.length > 0 && setLayersHidden(p.frame, others, true)
  }
  const frames = currentPageCanvas()?.frames ?? []
  const others = frames.filter((f) => !s.selectedIds.includes(f.id) && !f.hidden)
  if (!others.length || !s.selectedIds.length) return false
  setFramesHidden(others, true)
  return true
}

/* ---- moving around the canvas ---- */

/** The page's frames as a person reads them, top-level shapes left out. */
function framesInOrder(): Frame[] {
  const frames = (currentPageCanvas()?.frames ?? []).filter((f) => !f.hidden && !isCanvasElement(f.html))
  return readingOrder(frames)
}

/** N / ⇧N (zoom to it) and End / Home (only bring it into view): the next or
 *  previous frame after the selected one, in reading order. */
export function stepFrame(dir: 1 | -1, zoom: boolean): boolean {
  const s = useStore.getState()
  const frames = framesInOrder()
  if (!frames.length) return false
  const at = frames.findIndex((f) => f.id === s.selectedId)
  const next = frames[at === -1 ? (dir === 1 ? 0 : frames.length - 1) : (at + dir + frames.length) % frames.length]!
  s.select(next.id)
  s.pickElement(null)
  if (zoom) s.requestFlyTo(next.id)
  else s.requestFlyToPoint(next.x + next.width / 2, next.y + next.height / 2)
  return true
}

/** PgUp / PgDn: the previous or next page. */
export function stepPage(dir: 1 | -1): boolean {
  const s = useStore.getState()
  if (!s.canvas) return false
  const pages = canvasPages(s.canvas)
  if (pages.length < 2) return false
  const at = Math.max(
    0,
    pages.findIndex((p) => p.id === s.activePageId),
  )
  const next = pages[at + dir]
  if (!next) return false
  s.setActivePage(next.id)
  return true
}

/** Rewrite several frames' HTML as one undo step (replace all). */
export function saveFramesHtml(changes: { frame: Frame; html: string }[]) {
  const real = changes.filter(({ frame, html }) => !frame.locked && frame.html !== html)
  if (!real.length) return
  recordUpdates(real.map(({ frame, html }) => ({ frameId: frame.id, before: { html: frame.html }, after: { html } })))
  const store = useStore.getState()
  for (const { frame, html } of real) store.patchFrameLocal(frame.id, { html })
  trackSave(Promise.all(real.map(({ frame, html }) => api.updateFrame(frame.id, { html }))).catch(console.error))
}
