import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { Frame } from '../../shared/types'
import type { WireComponentDef } from '../../shared/components'
import { canEditOpenCanvas, pickedSelectors, useStore } from '../lib/store'
import { layerPlacement } from '../lib/frameBridge'
import { currentPageCanvas, usePageCanvas } from '../lib/pages'
import { PagesPanel, sectionHeading } from './PagesPanel'
import { getIdentity } from '../lib/identity'
import { renameComponent, rootPartKey } from '../lib/components'
import {
  ancestorsOf,
  buildLayerTree,
  filterLayers,
  holdsChildren,
  outermostSelectors,
  type DropPlace,
  type DropTarget,
  type LayerNode,
} from '../lib/layers'
import {
  deleteLayers,
  deleteSelection,
  renameFrame,
  renameLayer,
  dropLayer,
  dropLayers,
  setFrameHidden,
  setFramesLocked,
  setLayerHidden,
  setLayerLocked,
  detachLayer,
  isStackLocked,
  isLayerLocked,
  restackFrame,
  restackFrames,
  stackRoom,
  shiftFrame,
  shiftLayer,
  standaloneSelector,
  takesLayers,
  transferLayer,
  transferLayers,
} from '../lib/layerEdits'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { LayerKindIcon } from './LayerKindIcon'
import { ComponentsPanel } from './ComponentsPanel'
import { FrameContextMenu } from './FrameContextMenu'
import { FrameApprovalBadge } from './FrameApproval'
import {
  Panel,
  PanelBody,
  PanelClose,
  PanelHeader,
  PanelIconTab,
  PanelSearch,
  PanelTabs,
  PanelTabsRoot,
  type PanelResize,
  type PanelSurface,
} from './ui/panel'
import { TokensSection } from './TokensPanel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Tooltip } from './ui/tooltip'
import { Toolbar, ToolbarControl } from './ui/toolbar'
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu'
import { ElementContextMenu } from './ElementContextMenu'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CollapseAllIcon,
  EyeClosedIcon,
  EyeIcon,
  FrameIcon,
  LayersIcon,
  ComponentIcon,
  InstanceIcon,
  BracesIcon,
  LockIcon,
  LockOpenIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  PlusIcon,
} from './ui/icons'
import { useT } from '@/lib/i18n'
import { libraryAttention, useLibraryStatus } from '../lib/library'
import { Dot } from './ui/dot'

/* the tree indents 16px per level; frame rows sit at depth 0 */
const INDENT = 16

const sectionBtn = 'size-5 rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink'
const editorChip =
  'inline-flex h-4 flex-none items-center gap-[3px] rounded-full px-1.5 text-[10px] font-medium leading-none text-white'

function rowKey(frameId: string, selector: string) {
  return `${frameId}|${selector}`
}

/* one parse per frame html, shared between the search filter and the rows —
   keyed by id and checked against the html, so a drag (a new frame object,
   same html) never re-parses */
const treeCache = new Map<string, { html: string; tree: LayerNode[] }>()
function frameTree(frame: Frame): LayerNode[] {
  const hit = treeCache.get(frame.id)
  if (hit && hit.html === frame.html) return hit.tree
  const tree = buildLayerTree(frame.html)
  treeCache.set(frame.id, { html: frame.html, tree })
  return tree
}

/** One visible line of the tree. The list is flat so the arrow keys can walk
 *  it, and every element row knows its parent for ← — and whether something
 *  above it is hidden, since a hidden box takes its contents with it. */
type VisibleRow =
  | { kind: 'frame'; key: string; frame: Frame; open: boolean; empty: boolean }
  | {
      kind: 'node'
      key: string
      frame: Frame
      node: LayerNode
      depth: number
      open: boolean
      parentKey: string
      /** the frame or an ancestor element is hidden */
      dim: boolean
      /** the one layer of a standalone element: a shape on the canvas with
       *  no frame around it, listed at the root as Figma lists one */
      standalone?: boolean
    }
type NodeVisibleRow = Extract<VisibleRow, { kind: 'node' }>

/** A row at the top level of the tree: a frame, or a standalone element. */
function isRoot(row: VisibleRow): boolean {
  return row.kind === 'frame' || !!row.standalone
}

/** Where a dragged layer would land: next to or into a row, or at the
 *  root — out of every frame, as a standalone element on the canvas. A
 *  `root` drop on a row is the line above that top-level row: in front of
 *  it on the canvas, since the list runs front to back as Figma's does. */
type Drop = { key: string; place: DropPlace | 'root' }
/* the key of the root drop shown under the last row */
const ROOT_KEY = ''

/* the rows a drag carries when the pressed row is one of several selected —
   fixed at the press, since the selection can change mid-gesture.
   `standalone`: every member is a canvas shape, which a frame can take in.
   `doc`: the picked selectors in document order, for a run into a frame */
type DragGroup =
  | { kind: 'roots'; ids: string[]; keys: Set<string>; standalone: boolean }
  | { kind: 'nodes'; selectors: string[]; doc: string[]; keys: Set<string>; nodes: LayerNode[] }

/* a press has to travel this far before it is a drag rather than a click */
const DRAG_THRESHOLD = 4
/* the band at a row's top and bottom that means "next to", not "into" */
const EDGE_BAND = 0.3

function holds(node: LayerNode, selector: string): boolean {
  return node.children.some((c) => c.selector === selector || holds(c, selector))
}

/** Where a drop over `row` lands — a line above or below it, or into it.
 *  Only boxes that can hold children take an "into" drop (an <input> is a
 *  box with nothing in it, but nothing can go in it); an open box's lower
 *  part reads as "into" so the line under it always means "first child"
 *  rather than the ambiguous "after the subtree". A frame row is the top of
 *  its body. */
function dropOver(row: VisibleRow, fraction: number): DropPlace {
  if (row.kind === 'frame') return 'inside'
  if (row.node.kind !== 'box' || !holdsChildren(row.node.tag)) return fraction < 0.5 ? 'before' : 'after'
  if (fraction < EDGE_BAND) return 'before'
  if (!row.open && fraction > 1 - EDGE_BAND) return 'after'
  return 'inside'
}

function targetOf(row: VisibleRow, place: DropPlace): DropTarget {
  return { selector: row.kind === 'frame' ? 'body' : row.node.selector, place }
}

/** The tree's lines. `frames` is the page's paint order, back to front; the
 *  list runs the other way, so the frame in front is at the top. */
function visibleRows(frames: Frame[], query: string, expanded: Set<string>): VisibleRow[] {
  const rows: VisibleRow[] = []
  for (const frame of [...frames].reverse()) {
    const tree = query ? filterLayers(frameTree(frame), query) : null
    if (query && !frame.name.toLowerCase().includes(query) && tree?.length === 0) continue
    const walk = (list: LayerNode[], depth: number, parentKey: string, dim: boolean) => {
      for (const node of list) {
        const key = rowKey(frame.id, node.selector)
        const nodeOpen = node.children.length > 0 && (!!query || expanded.has(key))
        rows.push({ kind: 'node', key, frame, node, depth, open: nodeOpen, parentKey, dim })
        if (nodeOpen) walk(node.children, depth + 1, key, dim || node.hidden)
      }
    }
    /* a standalone element is its one layer, at the root */
    const standalone = standaloneSelector(frame)
    const shape = standalone ? (tree ?? frameTree(frame)).find((n) => n.selector === standalone) : undefined
    if (standalone && shape) {
      const key = rowKey(frame.id, shape.selector)
      const open = shape.children.length > 0 && (!!query || expanded.has(key))
      rows.push({
        kind: 'node',
        key,
        frame,
        node: shape,
        depth: 0,
        open,
        parentKey: '',
        dim: !!frame.hidden,
        standalone: true,
      })
      if (open) walk(shape.children, 1, key, !!frame.hidden || shape.hidden)
      continue
    }
    const open = !!query || expanded.has(frame.id)
    const nodes = open ? (tree ?? frameTree(frame)) : []
    rows.push({ kind: 'frame', key: frame.id, frame, open, empty: open && nodes.length === 0 })
    walk(nodes, 1, frame.id, !!frame.hidden)
  }
  return rows
}

/** The Layers rail: every frame on the canvas, opening into the element tree
 *  of its HTML. Selection runs both ways — a row selects the element in the
 *  frame, a click in the frame highlights its row. */
export function LayersPanel({
  onAddFrame,
  surface = 'floating',
  onClose,
  resize,
}: {
  onAddFrame: () => void
  /* 'inline' when the panel is filling a mobile Sheet rather than floating */
  surface?: PanelSurface
  /** inline only: the sheet's close, in the collapse control's place */
  onClose?: () => void
  resize?: PanelResize
}) {
  /* a row's pointerleave never fires if the panel goes away under it */
  useEffect(() => () => useStore.getState().setHoveredLayer(null), [])
  /* which of the panel's two faces shows: the layer tree, or the design
     tokens; in the store so the collapsed rail can open straight onto one */
  const tab = useStore((s) => s.layersTab)
  const setTab = useStore((s) => s.setLayersTab)
  /* view and comment links browse the tree; nothing in it moves or changes */
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  /* the Components tab wears a dot while its library waits on someone: changes
     not yet published, or published updates not yet taken */
  const libraryStatus = useLibraryStatus(useStore((s) => s.canvas?.id))
  const attention = libraryAttention(libraryStatus)
  const libraryWaits = !readOnly && attention.unpublished + attention.updates > 0
  const pageCanvas = usePageCanvas()
  const frames = useMemo(() => pageCanvas?.frames ?? [], [pageCanvas])
  const selectedId = useStore((s) => s.selectedId)
  const selectedIds = useStore((s) => s.selectedIds)
  const selectedElement = useStore((s) => s.selectedElement)
  /* every row of a multi-element pick is highlighted; a string key keeps
     the selection identity-stable between store updates */
  const pickedKeys = useStore((s) =>
    s.selectedElement
      ? pickedSelectors(s)
          .map((selector) => rowKey(s.selectedElement!.frameId, selector))
          .join('\n')
      : '',
  )
  const pickedRows = useMemo(() => new Set(pickedKeys.split('\n')), [pickedKeys])
  const setLayersOpen = useStore((s) => s.setLayersOpen)
  const t = useT()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  /* the row being dragged and where it would land; the pointer handlers are
     bound to the window for the length of the press, so they read the rows
     through a ref rather than a stale closure */
  const [drag, setDrag] = useState<VisibleRow | null>(null)
  /* the rows the drag shows as moving: the pressed row's, or a picked set's */
  const [dragKeys, setDragKeys] = useState<ReadonlySet<string> | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const rowsRef = useRef<VisibleRow[]>([])
  const didDrag = useRef(false)
  /* the row a ⇧-click ranges from: the last plainly or ⌘-clicked row (and
     the row an arrow-key walk lands on). A range itself never moves it */
  const anchorKey = useRef<string | null>(null)

  /* the selected frame opens on its own, and a selection made inside a frame
     opens every row above it — derived from the selection during render, not
     in an effect, so the tree is right on the first paint */
  const [seenFrame, setSeenFrame] = useState(selectedId)
  if (seenFrame !== selectedId) {
    setSeenFrame(selectedId)
    if (selectedId) setExpanded((prev) => new Set(prev).add(selectedId))
  }
  const [seenElement, setSeenElement] = useState(selectedElement)
  if (seenElement !== selectedElement) {
    setSeenElement(selectedElement)
    if (selectedElement) {
      const { frameId, selector } = selectedElement
      const frame = frames.find((f) => f.id === frameId)
      const above = frame ? (ancestorsOf(frameTree(frame), selector) ?? []) : []
      setExpanded((prev) => {
        const next = new Set(prev).add(frameId)
        for (const node of above) next.add(rowKey(frameId, node.selector))
        return next
      })
    }
  }

  /* ⌥L (Collapse layers) folds every row */
  const collapseAt = useStore((s) => s.layersCollapseAt)
  const [seenCollapse, setSeenCollapse] = useState(collapseAt)
  if (seenCollapse !== collapseAt) {
    setSeenCollapse(collapseAt)
    setExpanded(new Set())
  }

  function setOpen(key: string, open: boolean) {
    setExpanded((prev) => {
      if (prev.has(key) === open) return prev
      const next = new Set(prev)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const q = query.trim().toLowerCase()
  const rows = useMemo(() => visibleRows(frames, q, expanded), [frames, q, expanded])
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])
  /* a canvas shape selected as a whole is listed as its one layer's row */
  const currentKey = selectedElement
    ? rowKey(selectedElement.frameId, selectedElement.selector)
    : (rows.find((r) => isRoot(r) && r.frame.id === selectedId)?.key ?? selectedId)

  /* a layer row opens the element properties panel; a frame row closes it
     and leaves the frame's own inspector to the frame-name click */
  function pick(row: VisibleRow, toggle = false) {
    const s = useStore.getState()
    /* ⌘/Ctrl-click on a frame or a canvas shape adds it to the selection,
       or drops it, as ⇧-click does on the canvas */
    if (toggle && isRoot(row)) {
      s.toggleSelect(row.frame.id)
      return
    }
    /* ⌘/Ctrl-click adds a layer to the frame's picked set, or drops it */
    if (toggle && row.kind === 'node' && s.selectedElement?.frameId === row.frame.id) {
      s.toggleElement({ frameId: row.frame.id, selector: row.node.selector })
      return
    }
    s.select(row.frame.id)
    /* a plain click narrows a multi-element pick to this row, as on the canvas */
    s.pickElement(row.kind === 'node' ? { frameId: row.frame.id, selector: row.node.selector } : null, true)
  }

  /* ⇧-click takes the range from the anchor row to this one, in list order,
     replacing the selection and making the clicked row the primary — the
     same range a file list's ⇧-click takes. The store only holds one kind
     of multi-selection — top-level rows, or the elements of a single
     frame — so a root and a layer, or layers of two frames, take no range
     and the click does what ⌘-click does (false). */
  function range(row: VisibleRow): boolean {
    const s = useStore.getState()
    /* collapsed, filtered or deleted, the anchor falls back to the current
       row — and stays there, so the next ⇧-click starts from it too */
    const anchor = rows.find((r) => r.key === anchorKey.current) ?? rows.find((r) => r.key === currentKey)
    if (!anchor) return false
    anchorKey.current = anchor.key
    const lo = Math.min(rows.indexOf(anchor), rows.indexOf(row))
    const hi = Math.max(rows.indexOf(anchor), rows.indexOf(row))
    const between = rows.slice(lo, hi + 1)
    if (isRoot(anchor) && isRoot(row)) {
      /* the layers of an expanded frame between two root rows are not part of it */
      const ids = between.filter(isRoot).map((r) => r.frame.id)
      s.selectMany([...ids.filter((id) => id !== row.frame.id), row.frame.id])
      /* an element pick clears, as a plain root click clears it */
      s.pickElement(null, true)
      return true
    }
    if (anchor.kind === 'node' && row.kind === 'node' && anchor.frame.id === row.frame.id) {
      const selectors = between
        .filter((r): r is NodeVisibleRow => r.kind === 'node' && r.frame.id === row.frame.id)
        .map((r) => r.node.selector)
      s.select(row.frame.id)
      s.pickElements(row.frame.id, [...selectors.filter((x) => x !== row.node.selector), row.node.selector])
      return true
    }
    return false
  }

  function activate(row: VisibleRow, mode?: 'toggle' | 'range') {
    /* ⇧-click takes a range and never moves the anchor; a pair no range
       covers does what ⌘-click does, anchor untouched either way */
    if (mode === 'range') {
      if (range(row)) return
      pick(row, true)
      return
    }
    anchorKey.current = row.key
    pick(row, mode === 'toggle')
  }

  /* the root drop just past `root`: the line above the next top-level row,
     or the list's tail */
  function rootDropAfter(root: VisibleRow): Drop {
    const roots = rowsRef.current.filter(isRoot)
    const next = roots[roots.indexOf(root) + 1]
    return { key: next?.key ?? ROOT_KEY, place: 'root' }
  }

  /* where a dragged frame, or a standalone element, would go among the
     top-level rows: above the row under the pointer, or below it (above
     the next one) from its lower half or anywhere inside an open frame.
     A spot that leaves it — or the group it drags — where it is draws no
     line. */
  function restackAt(
    dragged: VisibleRow,
    group: DragGroup | null,
    row: VisibleRow | undefined,
    fraction: number,
  ): Drop | null {
    const roots = rowsRef.current.filter(isRoot)
    const keys = group?.keys ?? new Set([dragged.key])
    const root = row && roots.find((r) => r.frame.id === row.frame.id)
    const drop: Drop = !root
      ? { key: ROOT_KEY, place: 'root' }
      : row === root && fraction < 0.5
        ? { key: root.key, place: 'root' }
        : rootDropAfter(root)
    /* the line just above or just below the dragged run: splicing it back
       in there gives the order the rows already have */
    const rest = roots.filter((r) => !keys.has(r.key))
    const members = roots.filter((r) => keys.has(r.key))
    const at = roots.findIndex((r) => r.key === drop.key)
    const pos = at === -1 ? rest.length : rest.filter((r) => roots.indexOf(r) < at).length
    const spliced = [...rest.slice(0, pos), ...members, ...rest.slice(pos)]
    if (spliced.every((r, i) => r === roots[i])) return null
    return drop
  }

  /* the drop under the pointer: a row that is neither the element itself
     nor inside it. A row of another frame takes the element too, unless that
     frame is locked or a standalone drawing still holding its shape
     (transferLayer refuses those, so the line must not promise them); a
     standalone whose shape was dragged out stays behind empty and takes a
     layer back. A frame row only changes places with the rows around it. */
  function dropAt(dragged: VisibleRow, group: DragGroup | null, x: number, y: number): Drop | null {
    const under = document.elementFromPoint(x, y)
    const el = under?.closest<HTMLElement>('[data-row-key]')
    const row = el ? rowsRef.current.find((r) => r.key === el.dataset.rowKey) : undefined
    const inList = !!under?.closest('[data-slot="panel-body"]')
    const fraction = el ? (y - el.getBoundingClientRect().top) / el.getBoundingClientRect().height : 0
    /* a group of top-level rows only restacks — unless it is all canvas
       shapes, which a frame takes in as one shape goes */
    if (dragged.kind === 'frame' || group?.kind === 'roots') {
      if (group?.kind === 'roots' && group.standalone && row) {
        const member = group.keys.has(row.key) || group.ids.includes(row.frame.id)
        if (member || (row.kind === 'node' && !!row.standalone)) return restackAt(dragged, group, row, fraction)
        /* the band edges mean "beside it, at the root"; the rest is "into it" */
        if (row.kind === 'frame' && fraction < EDGE_BAND) return restackAt(dragged, group, row, 0)
        if (row.kind === 'frame' && !row.open && fraction > 1 - EDGE_BAND) return restackAt(dragged, group, row, 1)
        if (!takesLayers(row.frame, frameTree(row.frame).length > 0)) return null
        return { key: row.key, place: dropOver(row, fraction) }
      }
      return row || inList ? restackAt(dragged, group, row, fraction) : null
    }
    /* the list's empty tail is the root: out of every frame, onto the canvas,
       at the back — for a picked set that stays a single layer's gesture */
    if (!row || !el) {
      if (!inList || group) return null
      return dragged.standalone ? restackAt(dragged, null, undefined, 0) : { key: ROOT_KEY, place: 'root' }
    }
    if (row.key === dragged.key) return null
    if (group) {
      /* a picked set moves inside its own frame or into another that takes
         layers — out of a frame onto the canvas stays a single layer's
         gesture for now, so it draws no line */
      if (row.kind === 'node' && !!row.standalone) return null
      if (row.frame.id !== dragged.frame.id && !takesLayers(row.frame, frameTree(row.frame).length > 0)) return null
      if (
        row.kind === 'node' &&
        row.frame.id === dragged.frame.id &&
        (group.keys.has(row.key) || group.nodes.some((n) => holds(n, row.node.selector)))
      )
        return null
      return { key: row.key, place: dropOver(row, fraction) }
    }
    const standalone = row.kind === 'node' && !!row.standalone
    if (dragged.standalone) {
      /* a standalone element changes places with the top-level rows, or
         goes into a frame from the middle of its row or one of its layers */
      if (standalone || row.frame.id === dragged.frame.id) return restackAt(dragged, null, row, fraction)
      if (row.kind === 'frame' && fraction < EDGE_BAND) return restackAt(dragged, null, row, 0)
      if (row.kind === 'frame' && !row.open && fraction > 1 - EDGE_BAND) return restackAt(dragged, null, row, 1)
    } else if ((row.kind === 'frame' || standalone) && fraction < EDGE_BAND)
      /* the band above a top-level row means "beside it, at the root"; the
         layer's own frame counts, since nothing else lies in front of the
         first frame in the list */
      return { key: row.key, place: 'root' }
    /* a standalone element is one shape, not a box for others */
    if (standalone) return null
    if (row.frame.id !== dragged.frame.id && !takesLayers(row.frame, frameTree(row.frame).length > 0)) return null
    if (row.kind === 'node' && row.frame.id === dragged.frame.id && holds(dragged.node, row.node.selector)) return null
    return { key: row.key, place: dropOver(row, fraction) }
  }

  /* the index in `list` (back to front) a root drop puts a frame at: just
     in front of the row it is drawn above, or behind the last listed row
     for the tail */
  function stackSlot(target: Drop, list: Frame[]): number {
    const roots = rowsRef.current.filter(isRoot)
    const index = (row: VisibleRow | undefined) => (row ? list.findIndex((f) => f.id === row.frame.id) : -1)
    if (target.key === ROOT_KEY) return Math.max(0, index(roots[roots.length - 1]))
    return index(roots.find((r) => r.key === target.key)) + 1
  }

  /* the same slot for a group drop: stackSlot's lookup fails a line drawn
     above one of the group's own rows, so the `rest` rows below the line
     are counted instead — those are the frames the group lands in front of */
  function groupSlot(target: Drop, rest: Frame[]): number {
    const ids = new Set(rest.map((f) => f.id))
    const roots = rowsRef.current.filter(isRoot)
    /* the tail: behind the last listed row that stays (a filter can hide the back) */
    if (target.key === ROOT_KEY) {
      const last = roots.filter((r) => ids.has(r.frame.id)).at(-1)
      return last
        ? Math.max(
            0,
            rest.findIndex((f) => f.id === last.frame.id),
          )
        : 0
    }
    const at = roots.findIndex((r) => r.key === target.key)
    if (at === -1) return rest.length
    return roots.slice(at).filter((r) => ids.has(r.frame.id)).length
  }

  /* a press on a layer row turns into a drag once it travels; the row is
     dropped where the pointer lets go, and the click that follows a drag is
     swallowed so the drop does not double as a select. The target is read
     again at release (the list may have scrolled under a still pointer),
     dropLayer and transferLayer check the frames against the store (a
     collaborator may have edited one during the drag), and a cancelled
     gesture drops nothing. A drop on another frame's row carries the
     element over into that frame. */
  function onRowPointerDown(e: ReactPointerEvent<HTMLDivElement>, row: VisibleRow) {
    if (e.button !== 0 || readOnly) return
    /* a locked frame or shape keeps its place in the stack */
    if (isRoot(row) && isStackLocked(row.frame)) return
    /* a press on one row of a multi-selection drags them all, as Figma does
       — fixed at the press, since the selection may change mid-gesture. A
       picked set holding a locked layer takes no group move (reorderLayers
       refuses the same way), and a row outside the selection drags alone */
    const s = useStore.getState()
    let group: DragGroup | null = null
    if (isRoot(row) && s.selectedIds.includes(row.frame.id)) {
      const members = rows.filter((r) => isRoot(r) && s.selectedIds.includes(r.frame.id))
      if (members.length > 1)
        group = {
          kind: 'roots',
          ids: members.map((r) => r.frame.id),
          keys: new Set(members.map((r) => r.key)),
          standalone: members.every((r) => standaloneSelector(r.frame) !== null),
        }
    } else if (row.kind === 'node' && s.selectedElement?.frameId === row.frame.id) {
      const picked = pickedSelectors(s)
      if (
        picked.length > 1 &&
        picked.includes(row.node.selector) &&
        !picked.some((sel) => isLayerLocked(row.frame, sel))
      )
        group = {
          kind: 'nodes',
          selectors: picked,
          doc: outermostSelectors(row.frame.html, picked) ?? picked,
          keys: new Set(picked.map((sel) => rowKey(row.frame.id, sel))),
          nodes: rows
            .filter(
              (r): r is NodeVisibleRow =>
                r.kind === 'node' && r.frame.id === row.frame.id && picked.includes(r.node.selector),
            )
            .map((r) => r.node),
        }
    }
    const start = { x: e.clientX, y: e.clientY }
    const body = e.currentTarget.closest<HTMLElement>('[data-slot="panel-body"]')
    let active = false
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setDrag(null)
      setDragKeys(null)
      setDrop(null)
    }
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return
        active = true
        didDrag.current = true
        setDrag(row)
        setDragKeys(group?.keys ?? new Set([row.key]))
      }
      if (body) {
        const rect = body.getBoundingClientRect()
        if (ev.clientY < rect.top + 24) body.scrollBy(0, -8)
        else if (ev.clientY > rect.bottom - 24) body.scrollBy(0, 8)
      }
      setDrop(dropAt(row, group, ev.clientX, ev.clientY))
    }
    const onUp = (ev: PointerEvent) => {
      const wasActive = active
      finish()
      if (!wasActive) return
      const target = dropAt(row, group, ev.clientX, ev.clientY)
      const over = target && rowsRef.current.find((r) => r.key === target.key)
      if (!target) return
      if (group?.kind === 'roots') {
        /* the selected top-level rows restack as one run, keeping order;
           a set of canvas shapes can also move into a frame */
        if (target.place === 'root') {
          const stacked = currentPageCanvas()?.frames ?? []
          const ids = new Set(group.ids)
          const others = stacked.filter((f) => !ids.has(f.id))
          restackFrames(stacked, group.ids, groupSlot(target, others))
        } else if (group.standalone && over) {
          /* back to front, so the front-most shape lands last in the
             markup and keeps its place on top, as on the canvas */
          const stacked = currentPageCanvas()?.frames ?? []
          const sources = [...group.ids]
            .reverse()
            .map((id) => stacked.find((f) => f.id === id))
            .filter((f): f is Frame => !!f && !isStackLocked(f))
            .flatMap((f) => {
              const shape = standaloneSelector(f)
              return shape ? [{ pressed: f, selectors: [shape] }] : []
            })
          if (sources.length) transferLayers(sources, over.frame, targetOf(over, target.place))
        }
        return
      }
      if (group?.kind === 'nodes') {
        /* the set moves inside its own frame or into another that takes
           it; out of a frame onto the canvas a single layer goes for now —
           and moving one of a visible group would surprise anyway, so the
           drop does nothing */
        if (target.place !== 'root' && over) {
          if (over.frame.id === row.frame.id) {
            const to = targetOf(over, target.place)
            void Promise.all(group.selectors.map((sel) => layerPlacement(row.frame.id, sel, to))).then((flows) =>
              dropLayers(row.frame, group.selectors, to, new Map(group.selectors.map((sel, i) => [sel, flows[i]]))),
            )
          } else {
            transferLayers([{ pressed: row.frame, selectors: group.doc }], over.frame, targetOf(over, target.place))
          }
        }
        return
      }
      if (target.place === 'root') {
        /* a frame or a standalone element changes places; an element
           comes out of its frame onto the canvas, at that place */
        const stacked = currentPageCanvas()?.frames ?? []
        if (isRoot(row)) {
          const others = stacked.filter((f) => f.id !== row.frame.id)
          restackFrame(stacked, row.frame.id, stackSlot(target, others))
        } else if (row.kind === 'node') {
          const slot = stackSlot(target, stacked)
          void stackRoom(stacked, slot).then((room) => {
            if (room) return detachLayer(row.frame, row.node.selector, room)
          })
        }
        return
      }
      if (!over || row.kind !== 'node') return
      if (over.frame.id === row.frame.id) {
        /* into a flex box it flows, out onto a hand-placed box it goes
           absolute where it shows, as a canvas drag would place it */
        const to = targetOf(over, target.place)
        void layerPlacement(row.frame.id, row.node.selector, to).then((flow) =>
          dropLayer(row.frame, row.node.selector, to, flow),
        )
      } else transferLayer(row.frame, row.node.selector, over.frame, targetOf(over, target.place))
    }
    const onCancel = () => finish()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  /* ↑↓ walk the visible rows, ⌥↑↓ move the selected layer among its
     siblings, ←→ close and open rows, ⌫ deletes what is selected, ↵ flies to
     the frame — the panel is a tree, so it drives like one */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const index = rows.findIndex((r) => r.key === currentKey)
    const row = index >= 0 ? rows[index] : undefined
    const step = (dir: 1 | -1) => {
      const next = rows[index < 0 ? (dir === 1 ? 0 : rows.length - 1) : index + dir]
      if (next) activate(next)
    }
    const shift = (dir: 1 | -1) => {
      if (!row || readOnly) return
      /* a top-level row moves through the stack; the list runs front to back */
      if (isRoot(row)) shiftFrame(frames, row.frame.id, dir)
      else if (row.kind === 'node') shiftLayer(row.frame, row.node.selector, dir)
    }
    switch (e.key) {
      case 'ArrowDown':
        if (e.altKey) shift(1)
        else step(1)
        break
      case 'ArrowUp':
        if (e.altKey) shift(-1)
        else step(-1)
        break
      case 'ArrowRight':
        if (row && !row.open) setOpen(row.key, true)
        else step(1)
        break
      case 'ArrowLeft':
        if (row?.open) setOpen(row.key, false)
        else if (row?.kind === 'node') {
          const parent = rows.find((r) => r.key === row.parentKey)
          if (parent) activate(parent)
        }
        break
      case 'Enter':
        if (row) useStore.getState().requestFlyTo(row.frame.id)
        break
      case 'Backspace':
      case 'Delete':
        /* a held key repeats: once the element is gone the frame row would
           be next, so only the first press deletes */
        if (e.repeat || readOnly) break
        /* a locked frame stays; deleteLayers refuses a locked element itself
           and takes a standalone element's shell frame along with its layer */
        /* with no layer picked, every selected frame and canvas shape goes,
           as ⌫ on the canvas takes them */
        if (row && !useStore.getState().selectedElement) deleteSelection()
        else if (row) deleteLayers(row.frame, pickedSelectors(useStore.getState()))
        break
      default:
        return
    }
    e.preventDefault()
    /* the canvas page listens for ⌫ on window and deletes the selected
       frame — keys the tree handled must not reach it */
    e.stopPropagation()
  }

  return (
    <Panel
      surface={surface}
      resize={resize}
      className={cn(
        surface === 'floating' && 'top-2.5 bottom-3.5 left-3.5 w-[264px]',
        surface === 'docked' && 'left-0 w-[264px] border-r',
      )}
    >
      {/* the panel's two faces as icon tabs, the collapse control at the far end */}
      <PanelTabsRoot value={tab} onValueChange={(next) => setTab(next as typeof tab)} className="flex-none">
        <PanelHeader className="h-10 pl-2">
          <PanelTabs aria-label={t('panels.layersTabsAria')}>
            <PanelIconTab value="layers" icon={<LayersIcon />} title={t('panels.layersTitle')}>
              {t('panels.layersTitle')}
            </PanelIconTab>
            <PanelIconTab
              value="components"
              icon={<ComponentIcon />}
              title={libraryWaits ? t('components.libraryTabWaiting') : t('components.title')}
              badge={
                libraryWaits ? (
                  <Dot size="sm" className="absolute top-0.5 right-0.5 text-brand" data-library-dot />
                ) : undefined
              }
            >
              {t('components.title')}
            </PanelIconTab>
            <PanelIconTab value="tokens" icon={<BracesIcon />} title={t('panels.layersTabTokens')}>
              {t('panels.layersTabTokens')}
            </PanelIconTab>
          </PanelTabs>
          {surface === 'inline' ? (
            <PanelClose label={t('common.close')} onClick={onClose} />
          ) : (
            <Tooltip label={t('panels.layersCollapsePanel')} side="bottom" align="end">
              <Button
                variant="bare"
                size="icon-sm"
                className="size-7 shrink-0 rounded-[7px] text-ink-faint hover:bg-paper-deep hover:text-ink"
                aria-label={t('panels.layersCollapsePanel')}
                onClick={() => setLayersOpen(false)}
              >
                <PanelCollapseIcon className="size-3.5" />
              </Button>
            </Tooltip>
          )}
        </PanelHeader>
      </PanelTabsRoot>
      {tab === 'components' && <ComponentsPanel />}
      {tab === 'tokens' && (
        <PanelBody className="flex flex-col pb-2">
          <TokensSection />
        </PanelBody>
      )}
      {tab === 'layers' && (
        <>
          {/* Figma's order: the pages at the top, the frames of the active page
          under them, the search at the bottom within thumb's reach */}
          {pageCanvas && <PagesPanel key={pageCanvas.id} canvasId={pageCanvas.id} />}
          <div className={cn('mt-1.5 flex h-6 flex-none items-center justify-between pr-2.5 pl-3.5', sectionHeading)}>
            <span data-slot="frame-section-heading" className={sectionHeading}>
              {t('panels.layersTitle')}
            </span>
            <span className="flex gap-1">
              <Tooltip label={t('panels.layersCollapseAll')} side="bottom">
                <Button
                  variant="bare"
                  size="icon-sm"
                  className={sectionBtn}
                  aria-label={t('panels.layersCollapseAll')}
                  onClick={() => setExpanded(new Set())}
                >
                  <CollapseAllIcon className="size-3.5" />
                </Button>
              </Tooltip>
              {!readOnly && (
                <Tooltip label={t('panels.layersNewFrame')} side="bottom" align="end">
                  <Button
                    variant="bare"
                    size="icon-sm"
                    className={sectionBtn}
                    aria-label={t('panels.layersNewFrame')}
                    onClick={onAddFrame}
                  >
                    <PlusIcon className="size-3.5" />
                  </Button>
                </Tooltip>
              )}
            </span>
          </div>
          <PanelBody
            className={cn('px-2 pb-2 outline-none', drag && 'cursor-grabbing')}
            role="tree"
            tabIndex={0}
            onKeyDown={onKeyDown}
            onClickCapture={(e) => {
              if (!didDrag.current) return
              didDrag.current = false
              e.stopPropagation()
            }}
          >
            {frames.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-ink-faint">{t('panels.layersEmpty')}</div>
            )}
            {frames.length > 0 && rows.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-ink-faint">
                {t('panels.layersNoMatch', { query: query.trim() })}
              </div>
            )}
            {rows.map((row) =>
              row.kind === 'frame' ? (
                <FrameRow
                  key={row.key}
                  row={row}
                  selected={selectedIds.includes(row.frame.id) && !selectedElement}
                  current={row.frame.id === selectedId}
                  reveal={row.key === currentKey}
                  dragging={dragKeys?.has(row.key) ?? false}
                  drop={drop?.key === row.key ? drop.place : undefined}
                  onToggle={() => setOpen(row.key, !row.open)}
                  onActivate={(mode) => activate(row, mode)}
                  onPointerDown={(e) => onRowPointerDown(e, row)}
                />
              ) : (
                <NodeRow
                  key={row.key}
                  row={row}
                  selected={
                    pickedRows.has(row.key) ||
                    (!!row.standalone && !selectedElement && selectedIds.includes(row.frame.id))
                  }
                  reveal={row.key === currentKey}
                  dragging={dragKeys?.has(row.key) ?? false}
                  drop={drop?.key === row.key ? drop.place : undefined}
                  onToggle={() => setOpen(row.key, !row.open)}
                  onActivate={(mode) => activate(row, mode)}
                  onPointerDown={(e) => onRowPointerDown(e, row)}
                />
              ),
            )}
            {drop?.key === ROOT_KEY && (
              <div aria-hidden className="pointer-events-none mx-1.5 h-0.5 rounded-full bg-brand" />
            )}
          </PanelBody>
          <PanelSearch value={query} placeholder={t('panels.layersSearch')} onChange={setQuery} />
        </>
      )}
    </Panel>
  )
}

/** The collapsed rail: a narrow column at the panel's spot with the expand
 *  control and the Layers mark. The frame count lives in the tooltip only. */
export function LayersRailToggle({ docked = false }: { docked?: boolean }) {
  const setLayersOpen = useStore((s) => s.setLayersOpen)
  const count = usePageCanvas()?.frames.length ?? 0
  const t = useT()
  return (
    <Toolbar
      aria-label={t('panels.layersRailAria')}
      orientation="vertical"
      className={cn(
        'pointer-events-auto absolute z-[35]',
        docked
          ? 'inset-y-0 left-0 w-10 items-center rounded-none border-r border-line-soft shadow-none'
          : 'top-2.5 left-3.5',
      )}
    >
      <ToolbarControl label={t('panels.layersExpandPanel')} side="right" onClick={() => setLayersOpen(true)}>
        <PanelExpandIcon />
      </ToolbarControl>
      <ToolbarControl
        label={t('panels.layersRailCount', { count })}
        side="right"
        onClick={() => {
          useStore.getState().setLayersTab('layers')
          setLayersOpen(true)
        }}
      >
        <LayersIcon />
      </ToolbarControl>
      <ToolbarControl
        label={t('components.title')}
        side="right"
        onClick={() => {
          useStore.getState().setLayersTab('components')
          setLayersOpen(true)
        }}
      >
        <ComponentIcon />
      </ToolbarControl>
      <ToolbarControl
        label={t('panels.layersTabTokens')}
        side="right"
        onClick={() => {
          useStore.getState().setLayersTab('tokens')
          setLayersOpen(true)
        }}
      >
        <BracesIcon />
      </ToolbarControl>
    </Toolbar>
  )
}

/** The editor owns its keys and pointer gestures while a name is being typed. */
function ItemNameInput({
  name,
  onCommit,
  onDone,
}: {
  name: string
  onCommit: (value: string) => void
  onDone: () => void
}) {
  const t = useT()
  const finished = useRef(false)
  function finish(input: HTMLInputElement, save: boolean) {
    if (finished.current) return
    finished.current = true
    if (save && input.value.trim() !== name) onCommit(input.value)
    onDone()
  }
  return (
    <Input
      autoFocus
      aria-label={t('panels.layersName')}
      variant="bare"
      inputSize="auto"
      className="h-5 w-full bg-surface px-1 text-ink shadow-elevation-1-focus md:text-body"
      defaultValue={name}
      onFocus={(e) => e.target.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget, true)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) return
        e.preventDefault()
        const tree = e.currentTarget.closest<HTMLElement>('[role="tree"]')
        finish(e.currentTarget, e.key === 'Enter')
        tree?.focus()
      }}
    />
  )
}

/* A standalone main's row shows its frame's name; the server renames that
   frame with the component only while the two names agree, so otherwise the
   frame takes the saved name here, in turn with its other renames and without
   an undo step, since the component rename it follows has none. */
async function renameMain(def: WireComponentDef, frame: Frame, standalone: boolean, value: string) {
  const saved = await renameComponent(def, value)
  if (saved && standalone) renameFrame(frame.id, saved, { record: false })
}

function useItemRename(name: string, allowed: boolean, onCommit: (value: string) => void) {
  const [renaming, setRenaming] = useState(false)
  return {
    label:
      renaming && allowed ? <ItemNameInput name={name} onCommit={onCommit} onDone={() => setRenaming(false)} /> : name,
    startRename: () => {
      if (allowed) setRenaming(true)
    },
  }
}

function FrameRow({
  row,
  selected,
  current,
  reveal,
  dragging,
  drop,
  onToggle,
  onActivate,
  onPointerDown,
}: {
  row: Extract<VisibleRow, { kind: 'frame' }>
  selected: boolean
  /** the frame is selected, whether or not an element inside it is */
  current: boolean
  /** the selection's primary row: the one scrolled into view */
  reveal: boolean
  dragging: boolean
  drop?: Drop['place']
  onToggle: () => void
  onActivate: (mode?: 'toggle' | 'range') => void
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const { frame } = row
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const { label, startRename } = useItemRename(frame.name, !readOnly && !frame.locked, (value) =>
    renameFrame(frame.id, value),
  )
  const stream = useStore((s) => s.streams[frame.id])
  const presences = useStore((s) => s.presences)
  const me = getIdentity().clientId
  const editors = Object.values(presences).filter(
    (p) => p.activeFrameId === frame.id && p.clientId !== me && p.name !== stream?.name,
  )
  /* Paste from this menu lands mid-stage rather than under the rail */
  const pasteAt = useRef({ x: 0, y: 0 })
  const t = useT()
  return (
    <>
      <ContextMenu>
        {/* every item in the frame menu is an edit */}
        <ContextMenuTrigger asChild disabled={readOnly}>
          <Row
            data-row-key={row.key}
            depth={0}
            /* an open, empty frame shows the drop as the line its first
               layer would sit on, under the caption, not as a box */
            drop={row.empty && drop === 'inside' ? undefined : drop}
            caret={<Caret open={row.open} present />}
            onCaret={onToggle}
            icon={<FrameIcon className="size-3.5" />}
            label={label}
            className={cn(current && !selected && 'text-ink', dragging && 'opacity-40')}
            selected={selected}
            reveal={reveal}
            hidden={!!frame.hidden}
            dimmed={!!frame.hidden}
            onToggleHidden={readOnly ? undefined : () => setFrameHidden(frame, !frame.hidden)}
            locked={!!frame.locked}
            onToggleLocked={readOnly ? undefined : () => setFramesLocked([frame], !frame.locked)}
            onClick={(e) => onActivate(e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : undefined)}
            onDoubleClick={startRename}
            onContextMenu={() => {
              pasteAt.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
              if (!useStore.getState().selectedIds.includes(frame.id)) onActivate()
            }}
            onPointerDown={onPointerDown}
            trailing={
              <>
                <FrameApprovalBadge frame={frame} compact />
                {stream && (
                  <span className={editorChip} style={{ background: stream.color }}>
                    <AgentIcon name={stream.name} size={8} color="#fff" />
                    {t('panels.layersDesigning')}
                  </span>
                )}
                {/* who else is in the frame right now: a colour dot each, no
                    names — the presence pill in the bar says who is who */}
                {editors.map((p) => (
                  <span
                    key={p.clientId}
                    title={p.name}
                    className="size-2 flex-none rounded-full"
                    style={{ background: p.color }}
                  />
                ))}
              </>
            }
          />
        </ContextMenuTrigger>
        <FrameContextMenu frame={frame} at={pasteAt} />
      </ContextMenu>
      {/* the caption stands in for the frame's body, so a layer dragged
          onto it lands in the frame as a drop on the frame row would; the
          drop is drawn as one line between the row and the caption, at the
          indent the layer will take */}
      {row.empty && (
        <div data-row-key={row.key} className="relative rounded-[7px] py-1 pl-[46px] text-[11px] text-ink-faint">
          {drop === 'inside' && (
            <span
              aria-hidden
              className="pointer-events-none absolute -top-px right-1 z-[1] h-0.5 rounded-full bg-brand"
              style={{ left: 6 + INDENT }}
            />
          )}
          {t('panels.layersEmptyFrame')}
        </div>
      )}
    </>
  )
}

function NodeRow({
  row,
  selected,
  reveal,
  dragging,
  drop,
  onToggle,
  onActivate,
  onPointerDown,
}: {
  row: NodeVisibleRow
  selected: boolean
  /** the selection's primary row: the one scrolled into view */
  reveal: boolean
  dragging: boolean
  drop?: Drop['place']
  onToggle: () => void
  onActivate: (mode?: 'toggle' | 'range') => void
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const { frame, node } = row
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const hasChildren = node.children.length > 0
  const component = useStore((s) =>
    node.componentId ? s.canvas?.components?.find((def) => def.id === node.componentId) : undefined,
  )
  const componentName = component?.name
  /* a standalone element is its frame: its name, eye, lock and menu all
     belong to the frame */
  const standalone = !!row.standalone
  /* as in Figma, a component's rows are named after it: renaming the main's
     renames the component, renaming an instance's names that layer alone (an
     override the instance keeps, still linked) */
  const main = node.component === 'main' ? component : undefined
  /* a name inherited from the main is not the instance's own */
  const rootKey = useMemo(() => (component ? rootPartKey(component) : undefined), [component])
  const ownName = node.component === 'instance' && !!rootKey && !!node.namedParts?.includes(rootKey)
  const { label, startRename } = useItemRename(
    standalone ? frame.name : ownName ? node.label : (componentName ?? node.label),
    !readOnly && !frame.locked && !node.locked,
    (value) => {
      if (main) void renameMain(main, frame, standalone, value)
      else if (standalone) renameFrame(frame.id, value)
      else renameLayer(frame.id, node.selector, value)
    },
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={readOnly}>
        <Row
          data-row-key={row.key}
          depth={row.depth}
          drop={drop}
          caret={<Caret open={row.open} present={hasChildren} />}
          onCaret={hasChildren ? onToggle : undefined}
          icon={
            node.component === 'main' ? (
              <ComponentIcon width={14} height={14} className="text-brand" data-component-icon="main" />
            ) : node.component === 'instance' ? (
              <InstanceIcon width={14} height={14} className="text-brand" data-component-icon="instance" />
            ) : (
              <LayerKindIcon kind={node.kind} />
            )
          }
          label={label}
          detail={standalone || componentName ? undefined : node.detail}
          selected={selected}
          reveal={reveal}
          /* a standalone element is hidden by its frame or by its own
             attribute (⌘⇧H sets the latter): the row shows either, and its
             eye clears both or hides the frame */
          hidden={standalone ? !!frame.hidden || node.hidden : node.hidden}
          dimmed={row.dim || node.hidden}
          onToggleHidden={
            readOnly
              ? undefined
              : standalone
                ? () => {
                    if (frame.hidden || node.hidden) {
                      if (node.hidden) setLayerHidden(frame, node.selector, false)
                      if (frame.hidden) setFrameHidden(frame, false)
                    } else setFrameHidden(frame, true)
                  }
                : () => setLayerHidden(frame, node.selector, !node.hidden)
          }
          /* a standalone element is locked by its frame or by its own
             attribute (⌘⇧L sets the latter): the row shows either, and its
             lock clears both or locks the frame */
          locked={standalone ? !!frame.locked || node.locked : node.locked}
          onToggleLocked={
            readOnly
              ? undefined
              : standalone
                ? () => {
                    if (frame.locked || node.locked) {
                      if (node.locked) setLayerLocked(frame, node.selector, false)
                      if (frame.locked) setFramesLocked([frame], false)
                    } else setFramesLocked([frame], true)
                  }
                : () => setLayerLocked(frame, node.selector, !node.locked)
          }
          className={cn(dragging && 'opacity-40')}
          onClick={(e) => onActivate(e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : undefined)}
          onDoubleClick={() => {
            if (!isLayerLocked(frame, node.selector)) startRename()
          }}
          onContextMenu={() => {
            /* a right-click inside a multi-selection keeps the selection, so
               the menu's commands act on all of it, with the clicked layer
               its primary, as a right-click on the canvas does */
            const s = useStore.getState()
            const kept = standalone ? s.selectedIds.length > 1 && s.selectedIds.includes(frame.id) : selected
            if (!kept) return onActivate()
            if (standalone) return
            const picked = pickedSelectors(s)
            s.pickElements(frame.id, [...picked.filter((sel) => sel !== node.selector), node.selector])
          }}
          onPointerDown={onPointerDown}
          /* the row under the pointer is outlined on the canvas too, as a
             hover over the frame itself would */
          onPointerEnter={() => useStore.getState().setHoveredLayer({ frameId: frame.id, selector: node.selector })}
          onPointerLeave={() => {
            const s = useStore.getState()
            if (s.hoveredLayer?.frameId === frame.id && s.hoveredLayer.selector === node.selector)
              s.setHoveredLayer(null)
          }}
        />
      </ContextMenuTrigger>
      {/* the menu a right-click on the canvas opens, a shape's included */}
      <ElementContextMenu frame={frame} selector={node.selector} />
    </ContextMenu>
  )
}

/* Radix's context-menu trigger (asChild) hands its own handlers and data
   attributes down through these props, so everything unknown is spread onto
   the div and our handlers compose with, rather than replace, its own. */
type RowProps = Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> & {
  depth: number
  caret: ReactNode
  onCaret?: () => void
  icon: ReactNode
  label: ReactNode
  detail?: string
  selected: boolean
  /** the selection's primary row — a ⇧ range selects many rows at once, and
   *  only the clicked one scrolls itself into view */
  reveal?: boolean
  /** where a dragged layer would land on this row; `root` is a line above
   *  it at the root, out of every frame */
  drop?: Drop['place']
  trailing?: ReactNode
  /** switched off by its own eye: the crossed eye stays, hover or not */
  hidden?: boolean
  /** faded: this row, or something above it, is hidden */
  dimmed?: boolean
  /** the eye at the row's right end; it shows on hover, and stays while hidden */
  onToggleHidden?: () => void
  /** locked by its own lock: the solid lock stays, hover or not */
  locked?: boolean
  /** the lock next to the eye; it shows on hover, and stays while locked */
  onToggleLocked?: () => void
  onClick: (e: ReactMouseEvent<HTMLDivElement>) => void
}

function Row({
  depth,
  caret,
  onCaret,
  icon,
  label,
  detail,
  selected,
  reveal,
  drop,
  className,
  trailing,
  hidden,
  dimmed,
  onToggleHidden,
  locked,
  onToggleLocked,
  onClick,
  ...rest
}: RowProps) {
  const ref = useRef<HTMLDivElement>(null)
  const t = useT()
  /* a selection made in the frame may sit far down the tree — bring its
     primary row into view; the rest of a range leaves the scroll alone */
  useEffect(() => {
    if (selected && reveal) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected, reveal])
  return (
    <div
      {...rest}
      ref={ref}
      role="treeitem"
      aria-selected={selected}
      className={cn(
        'group relative flex h-7 cursor-default select-none items-center gap-[5px] whitespace-nowrap rounded-[7px] pr-1.5 text-[12px] text-ink-soft hover:bg-sub',
        selected && 'bg-paper-deep font-medium text-ink hover:bg-paper-deep [&_[data-icon]]:text-ink',
        /* room under the floating eye and lock, the strip's whole width, so
           neither the name nor a trailing badge runs beneath them: the strip
           paints the row's own background over whatever it covers */
        (onToggleHidden || onToggleLocked) &&
          (hidden || locked ? 'pr-[56px]' : 'focus-within:pr-[56px] hover:pr-[56px]'),
        drop === 'inside' && 'shadow-[inset_0_0_0_1.5px_var(--brand)]',
        className,
      )}
      style={{ ...rest.style, paddingLeft: 6 + depth * INDENT }}
      onClick={onClick}
    >
      {(drop === 'before' || drop === 'after' || drop === 'root') && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute right-1 z-[1] h-0.5 rounded-full bg-brand',
            drop === 'after' ? '-bottom-px' : '-top-px',
          )}
          style={{ left: drop === 'root' ? 6 : 6 + depth * INDENT }}
        />
      )}
      <span
        data-icon
        className={cn('grid size-3 flex-none place-items-center text-ink-faint', onCaret && 'cursor-pointer')}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (!onCaret) return
          e.stopPropagation()
          onCaret()
        }}
      >
        {caret}
      </span>
      <span data-icon className={cn('grid size-4 flex-none place-items-center text-ink-faint', dimmed && 'opacity-50')}>
        {icon}
      </span>
      <span className={cn('min-w-0 flex-1 overflow-hidden text-ellipsis', dimmed && 'opacity-50')}>{label}</span>
      {/* the class or id that names the element, as a quiet right-hand tag */}
      {detail && (
        <span className="min-w-0 max-w-[45%] flex-none truncate text-[11px] font-normal text-ink-faint group-hover:hidden">
          {detail.replace(/^\./, '')}
        </span>
      )}
      {trailing && <span className="flex flex-none items-center gap-1">{trailing}</span>}
      {(onToggleHidden || onToggleLocked) && (
        /* the eye and lock float over the row's right end, outside the flex
           flow, so showing or hiding them never moves anything: the row keeps
           its layout and an open tooltip keeps its anchor while it closes.
           They toggle visibility rather than display, for the same reason;
           a hidden or locked row keeps its mark showing. */
        <span
          className={cn(
            /* 56px: 8 + 20 + 2 + 20 + 6, the row's reserved padding above */
            'absolute top-0 right-0 flex h-full flex-none items-center gap-0.5 rounded-r-[7px] bg-inherit pr-1.5 pl-2',
            !hidden && !locked && 'invisible group-focus-within:visible group-hover:visible',
          )}
        >
          {onToggleHidden && (
            <RowToggle
              label={hidden ? t('panels.layersShow') : t('panels.layersHide')}
              on={!!hidden}
              selected={selected}
              onToggle={onToggleHidden}
              icon={hidden ? <EyeClosedIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            />
          )}
          {onToggleLocked && (
            <RowToggle
              label={locked ? t('panels.layersUnlock') : t('panels.layersLock')}
              on={!!locked}
              selected={selected}
              onToggle={onToggleLocked}
              icon={locked ? <LockIcon className="size-3" /> : <LockOpenIcon className="size-3" />}
            />
          )}
        </span>
      )}
    </div>
  )
}

/** A row-end control (the eye, the lock): faint on hover, solid while on.
 *  It is its own control: no select, no drag, no fly-to — and ↵/space on it
 *  must press the button, not reach the tree, whose ↵ handler would cancel
 *  the press and fly to the frame. */
function RowToggle({
  label,
  on,
  selected,
  icon,
  onToggle,
}: {
  label: string
  on: boolean
  selected: boolean
  icon: ReactNode
  onToggle: () => void
}) {
  /* no tooltip: the icon says it, and a bubble on every row-end hover is noise */
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      className={cn(
        'grid size-5 flex-none place-items-center rounded-[5px] text-ink-faint opacity-0 hover:bg-ink/10 hover:text-ink focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100',
        on && 'opacity-100',
        selected && 'text-ink-soft',
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
      }}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      {icon}
    </button>
  )
}

function Caret({ open, present }: { open: boolean; present: boolean }) {
  if (!present) return null
  return open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />
}
