/* Figma's keyboard walk of what is selected: ↩ goes into the frame or
   element (its first child), ⇧↩ back out to the parent, Tab and ⇧Tab to
   the next and previous sibling, ⌘A takes every sibling, and ⌘] / ⌘[ with
   their ⌥ forms change the stacking order. Frames walk the page's stack the
   way the Layers panel lists it (front first); elements walk the frame's
   layer tree in document order, the same rows the panel shows. */

import type { Frame } from '../../shared/types'
import { buildLayerTree, ancestorsOf, findLayer, type LayerNode } from './layers'
import { useStore } from './store'
import { currentPageCanvas } from './pages'
import { isStackLocked, restackFrame, shiftLayer, shiftLayerToEnd, standaloneSelector } from './layerEdits'
import type { ReorderMove } from './keys'

/** The rows beside a node: its parent's children, or the tree's roots. */
function siblingsOf(tree: LayerNode[], selector: string): LayerNode[] | null {
  const above = ancestorsOf(tree, selector)
  if (!above) return null
  return above.length ? above[above.length - 1]!.children : tree
}

/** ↩: the first layer inside the element (or, for no element, the frame's
 *  first layer). Null when there is nothing to go into. */
export function enterTarget(tree: LayerNode[], selector: string | null): string | null {
  const children = selector ? findLayer(tree, selector)?.children : tree
  return children?.[0]?.selector ?? null
}

/** ⇧↩: the layer around the element; null for a root layer (the frame is
 *  next), undefined when the selector is not in the tree. */
export function exitTarget(tree: LayerNode[], selector: string): string | null | undefined {
  const above = ancestorsOf(tree, selector)
  if (!above) return undefined
  return above.length ? above[above.length - 1]!.selector : null
}

/** Tab / ⇧Tab: the next (1) or previous (-1) sibling, wrapping at the ends. */
export function siblingTarget(tree: LayerNode[], selector: string, dir: 1 | -1): string | null {
  const siblings = siblingsOf(tree, selector)
  if (!siblings || siblings.length < 2) return null
  const at = siblings.findIndex((n) => n.selector === selector)
  return siblings[(at + dir + siblings.length) % siblings.length]!.selector
}

/** ⌘A beside an element: every unlocked sibling, the element itself last
 *  so it stays the primary. */
export function allSiblings(tree: LayerNode[], selector: string): string[] {
  const siblings = siblingsOf(tree, selector) ?? []
  const picked = siblings.filter((n) => !n.locked || n.selector === selector).map((n) => n.selector)
  return [...picked.filter((s) => s !== selector), selector]
}

/* ---- against the store ---- */

interface Target {
  frame: Frame
  /** the picked element, or null when the frame itself is what is selected */
  selector: string | null
  tree: LayerNode[]
}

/** What the keys act on: the picked element's frame, else the one selected
 *  frame. Several selected frames, or no selection, give nothing. */
function target(): Target | null {
  const s = useStore.getState()
  const picked = s.selectedElement
  const frameId = picked?.frameId ?? (s.selectedIds.length === 1 ? s.selectedId : null)
  const frame = frameId ? s.canvas?.frames.find((f) => f.id === frameId) : undefined
  if (!frame) return null
  return { frame, selector: picked?.selector ?? null, tree: buildLayerTree(frame.html) }
}

function pick(frame: Frame, selector: string) {
  const s = useStore.getState()
  s.select(frame.id)
  s.pickElement({ frameId: frame.id, selector }, true)
}

/** ↩: into the selection. False when there is nothing inside. */
export function enterSelection(): boolean {
  const t = target()
  if (!t) return false
  const next = enterTarget(t.tree, t.selector)
  if (!next) return false
  pick(t.frame, next)
  return true
}

/** ⇧↩: out to the parent layer, or from a root layer to the frame. A
 *  standalone element is its own root and has no frame to go out to. */
export function exitSelection(): boolean {
  const t = target()
  if (!t?.selector || standaloneSelector(t.frame) === t.selector) return false
  const parent = exitTarget(t.tree, t.selector)
  if (parent === undefined) return false
  if (parent) pick(t.frame, parent)
  else useStore.getState().pickElement(null)
  return true
}

/** Tab / ⇧Tab: the next or previous sibling layer, or, with a frame
 *  selected, the next or previous frame down the page's layer list. */
export function selectSibling(dir: 1 | -1): boolean {
  const t = target()
  if (!t) return false
  if (t.selector) {
    const next = siblingTarget(t.tree, t.selector, dir)
    if (!next) return false
    pick(t.frame, next)
    return true
  }
  /* the Layers panel lists the page front first; frames are kept back to
     front, so the next row down is the frame behind */
  const frames = currentPageCanvas()?.frames ?? []
  const at = frames.findIndex((f) => f.id === t.frame.id)
  if (at === -1 || frames.length < 2) return false
  const next = frames[(at - dir + frames.length) % frames.length]!
  useStore.getState().select(next.id)
  return true
}

/** ⌘A: every unlocked frame on the page, or, with an element picked, every
 *  unlocked sibling of it. False when the selection is already that. */
export function selectAll(): boolean {
  const s = useStore.getState()
  const picked = s.selectedElement
  const frame = picked ? s.canvas?.frames.find((f) => f.id === picked.frameId) : undefined
  if (picked && frame) {
    const all = allSiblings(buildLayerTree(frame.html), picked.selector)
    if (all.length === s.selectedElements.length && all.every((sel) => s.selectedElements.includes(sel))) return false
    s.pickElements(frame.id, all)
    return true
  }
  const ids = (currentPageCanvas()?.frames ?? []).filter((f) => !f.locked).map((f) => f.id)
  if (!ids.length || (ids.length === s.selectedIds.length && ids.every((id) => s.selectedIds.includes(id)))) {
    return false
  }
  s.selectMany(ids)
  return true
}

/** ⌘] / ⌘[ / ⌘⌥] / ⌘⌥[: restack the picked element among its siblings,
 *  or the selected frame in its page. False when nothing could move. */
export function reorderSelection(move: ReorderMove): boolean {
  const t = target()
  if (!t) return false
  const toFront = move === 'forward' || move === 'front'
  if (t.selector) {
    const dir = toFront ? 1 : -1
    return move === 'forward' || move === 'backward'
      ? shiftLayer(t.frame, t.selector, dir)
      : shiftLayerToEnd(t.frame, t.selector, dir)
  }
  if (isStackLocked(t.frame)) return false
  const frames = currentPageCanvas()?.frames ?? []
  const at = frames.findIndex((f) => f.id === t.frame.id)
  if (at === -1) return false
  const index = move === 'forward' ? at + 1 : move === 'backward' ? at - 1 : move === 'front' ? frames.length - 1 : 0
  if (index === at || index < 0 || index >= frames.length) return false
  restackFrame(frames, t.frame.id, index)
  return true
}
