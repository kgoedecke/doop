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
import { canEditOpenCanvas, pickedSelectors, useStore } from '../lib/store'
import { usePageCanvas } from '../lib/pages'
import { PagesPanel, sectionHeading } from './PagesPanel'
import { getIdentity } from '../lib/identity'
import { deleteFramesTracked } from '../lib/history'
import {
  ancestorsOf,
  buildLayerTree,
  filterLayers,
  holdsChildren,
  type DropPlace,
  type DropTarget,
  type LayerNode,
} from '../lib/layers'
import {
  deleteLayers,
  dropLayer,
  setFrameHidden,
  setFramesLocked,
  setLayerHidden,
  setLayerLocked,
  shiftLayer,
} from '../lib/layerEdits'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { LayerKindIcon } from './LayerKindIcon'
import { FrameContextMenu } from './FrameContextMenu'
import { FrameApprovalBadge } from './FrameApproval'
import { Panel, PanelBody, PanelClose, PanelHeader, type PanelResize } from './ui/panel'
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
  LockIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  PlusIcon,
  SearchIcon,
} from './ui/icons'

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
    }
type NodeVisibleRow = Extract<VisibleRow, { kind: 'node' }>

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

function visibleRows(frames: Frame[], query: string, expanded: Set<string>): VisibleRow[] {
  const rows: VisibleRow[] = []
  for (const frame of frames) {
    const tree = query ? filterLayers(frameTree(frame), query) : null
    if (query && !frame.name.toLowerCase().includes(query) && tree?.length === 0) continue
    const open = !!query || expanded.has(frame.id)
    const nodes = open ? (tree ?? frameTree(frame)) : []
    rows.push({ kind: 'frame', key: frame.id, frame, open, empty: open && nodes.length === 0 })
    const walk = (list: LayerNode[], depth: number, parentKey: string, dim: boolean) => {
      for (const node of list) {
        const key = rowKey(frame.id, node.selector)
        const nodeOpen = node.children.length > 0 && (!!query || expanded.has(key))
        rows.push({ kind: 'node', key, frame, node, depth, open: nodeOpen, parentKey, dim })
        if (nodeOpen) walk(node.children, depth + 1, key, dim || node.hidden)
      }
    }
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
  surface?: 'floating' | 'inline'
  /** inline only: the sheet's close, in the collapse control's place */
  onClose?: () => void
  resize?: PanelResize
}) {
  /* a row's pointerleave never fires if the panel goes away under it */
  useEffect(() => () => useStore.getState().setHoveredLayer(null), [])
  /* view and comment links browse the tree; nothing in it moves or changes */
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const pageCanvas = usePageCanvas()
  const frames = useMemo(() => pageCanvas?.frames ?? [], [pageCanvas])
  const selectedId = useStore((s) => s.selectedId)
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
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  /* the row being dragged and where it would land; the pointer handlers are
     bound to the window for the length of the press, so they read the rows
     through a ref rather than a stale closure */
  const [drag, setDrag] = useState<NodeVisibleRow | null>(null)
  const [drop, setDrop] = useState<{ key: string; place: DropPlace } | null>(null)
  const rowsRef = useRef<VisibleRow[]>([])
  const didDrag = useRef(false)

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
  const currentKey = selectedElement ? rowKey(selectedElement.frameId, selectedElement.selector) : selectedId

  /* a layer row opens the element properties panel; a frame row closes it
     and leaves the frame's own inspector to the frame-name click */
  function activate(row: VisibleRow, toggle = false) {
    const s = useStore.getState()
    /* ⇧/⌘-click adds a layer to the frame's picked set, or drops it */
    if (toggle && row.kind === 'node' && s.selectedElement?.frameId === row.frame.id) {
      s.toggleElement({ frameId: row.frame.id, selector: row.node.selector })
      return
    }
    s.select(row.frame.id)
    /* a plain click narrows a multi-element pick to this row, as on the canvas */
    s.pickElement(row.kind === 'node' ? { frameId: row.frame.id, selector: row.node.selector } : null, true)
  }

  /* the drop under the pointer: a row of the dragged element's frame that is
     neither the element itself nor inside it */
  function dropAt(dragged: NodeVisibleRow, x: number, y: number) {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-row-key]')
    const row = el ? rowsRef.current.find((r) => r.key === el.dataset.rowKey) : undefined
    if (!row || !el || row.frame.id !== dragged.frame.id || row.key === dragged.key) return null
    if (row.kind === 'node' && holds(dragged.node, row.node.selector)) return null
    const rect = el.getBoundingClientRect()
    return { key: row.key, place: dropOver(row, (y - rect.top) / rect.height) }
  }

  /* a press on a layer row turns into a drag once it travels; the row is
     dropped where the pointer lets go, and the click that follows a drag is
     swallowed so the drop does not double as a select. The target is read
     again at release (the list may have scrolled under a still pointer),
     dropLayer checks the frame against the store (a collaborator may have
     edited it during the drag), and a cancelled gesture drops nothing. */
  function onRowPointerDown(e: ReactPointerEvent<HTMLDivElement>, row: NodeVisibleRow) {
    if (e.button !== 0 || readOnly) return
    const start = { x: e.clientX, y: e.clientY }
    const body = e.currentTarget.closest<HTMLElement>('[data-slot="panel-body"]')
    let active = false
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setDrag(null)
      setDrop(null)
    }
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return
        active = true
        didDrag.current = true
        setDrag(row)
      }
      if (body) {
        const rect = body.getBoundingClientRect()
        if (ev.clientY < rect.top + 24) body.scrollBy(0, -8)
        else if (ev.clientY > rect.bottom - 24) body.scrollBy(0, 8)
      }
      setDrop(dropAt(row, ev.clientX, ev.clientY))
    }
    const onUp = (ev: PointerEvent) => {
      const wasActive = active
      finish()
      if (!wasActive) return
      const target = dropAt(row, ev.clientX, ev.clientY)
      const over = target && rowsRef.current.find((r) => r.key === target.key)
      if (over && target) dropLayer(row.frame, row.node.selector, targetOf(over, target.place))
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
      if (row?.kind === 'node' && !readOnly) shiftLayer(row.frame, row.node.selector, dir)
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
        /* a locked frame stays (deleteLayers refuses a locked element itself) */
        if (row?.kind === 'frame') {
          if (!row.frame.locked) deleteFramesTracked([row.frame])
        } else if (row) deleteLayers(row.frame, pickedSelectors(useStore.getState()))
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
      className={cn(surface === 'floating' && 'top-2.5 bottom-3.5 left-3.5 w-[264px]')}
    >
      {/* the panel's name with its icon, the collapse control at the far end */}
      <PanelHeader className="h-10 pl-3.5">
        <span className="flex items-center gap-2">
          <LayersIcon className="size-3.5" />
          Layers
        </span>
        {surface === 'inline' ? (
          <PanelClose label="Close" onClick={onClose} />
        ) : (
          <Tooltip label="Collapse panel" side="bottom" align="end">
            <Button
              variant="bare"
              size="icon-sm"
              className="size-7 shrink-0 rounded-[7px] text-ink-faint hover:bg-paper-deep hover:text-ink"
              aria-label="Collapse panel"
              onClick={() => setLayersOpen(false)}
            >
              <PanelCollapseIcon className="size-3.5" />
            </Button>
          </Tooltip>
        )}
      </PanelHeader>
      {/* Figma's order: the pages at the top, the frames of the active page
          under them, the search at the bottom within thumb's reach */}
      <PagesPanel />
      <div className={cn('mt-1.5 flex h-6 flex-none items-center justify-between pr-2.5 pl-3.5', sectionHeading)}>
        <span data-slot="frame-section-heading" className={sectionHeading}>
          Layers
        </span>
        <span className="flex gap-1">
          <Tooltip label="Collapse all" side="bottom">
            <Button
              variant="bare"
              size="icon-sm"
              className={sectionBtn}
              aria-label="Collapse all"
              onClick={() => setExpanded(new Set())}
            >
              <CollapseAllIcon className="size-3.5" />
            </Button>
          </Tooltip>
          {!readOnly && (
            <Tooltip label="New frame" side="bottom" align="end">
              <Button variant="bare" size="icon-sm" className={sectionBtn} aria-label="New frame" onClick={onAddFrame}>
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
          <div className="px-3 py-6 text-center text-[12px] text-ink-faint">
            No frames yet. Press + to add one, or ask the agent for a design.
          </div>
        )}
        {frames.length > 0 && rows.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-ink-faint">Nothing matches “{query.trim()}”.</div>
        )}
        {rows.map((row) =>
          row.kind === 'frame' ? (
            <FrameRow
              key={row.key}
              row={row}
              selected={row.frame.id === selectedId && !selectedElement}
              current={row.frame.id === selectedId}
              drop={drop?.key === row.key ? drop.place : undefined}
              onToggle={() => setOpen(row.key, !row.open)}
              onActivate={() => activate(row)}
            />
          ) : (
            <NodeRow
              key={row.key}
              row={row}
              selected={pickedRows.has(row.key)}
              dragging={drag?.key === row.key}
              drop={drop?.key === row.key ? drop.place : undefined}
              onToggle={() => setOpen(row.key, !row.open)}
              onActivate={(toggle) => activate(row, toggle)}
              onPointerDown={(e) => onRowPointerDown(e, row)}
            />
          ),
        )}
      </PanelBody>
      <footer className="flex-none px-2.5 pt-1 pb-2.5">
        <label className="flex h-[30px] items-center gap-2 rounded-[8px] px-2.5 text-ink-faint shadow-ring focus-within:shadow-elevation-1-focus">
          <SearchIcon className="size-3.5 flex-none" />
          <Input
            variant="bare"
            inputSize="auto"
            className="h-full text-[12px] placeholder:text-ink-ghost md:text-[12px]"
            placeholder="Search layers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </footer>
    </Panel>
  )
}

/** The collapsed rail: a narrow column at the panel's spot with the expand
 *  control and the Layers mark. The frame count lives in the tooltip only. */
export function LayersRailToggle() {
  const setLayersOpen = useStore((s) => s.setLayersOpen)
  const count = usePageCanvas()?.frames.length ?? 0
  return (
    <Toolbar
      aria-label="Layers panel"
      orientation="vertical"
      className="pointer-events-auto absolute top-2.5 left-3.5 z-[35]"
    >
      <ToolbarControl label="Expand panel" side="right" onClick={() => setLayersOpen(true)}>
        <PanelExpandIcon />
      </ToolbarControl>
      <ToolbarControl
        label={`Layers · ${count} ${count === 1 ? 'frame' : 'frames'}`}
        side="right"
        onClick={() => setLayersOpen(true)}
      >
        <LayersIcon />
      </ToolbarControl>
    </Toolbar>
  )
}

function FrameRow({
  row,
  selected,
  current,
  drop,
  onToggle,
  onActivate,
}: {
  row: Extract<VisibleRow, { kind: 'frame' }>
  selected: boolean
  /** the frame is selected, whether or not an element inside it is */
  current: boolean
  drop?: DropPlace
  onToggle: () => void
  onActivate: () => void
}) {
  const { frame } = row
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const stream = useStore((s) => s.streams[frame.id])
  const presences = useStore((s) => s.presences)
  const me = getIdentity().clientId
  const editors = Object.values(presences).filter(
    (p) => p.activeFrameId === frame.id && p.clientId !== me && p.name !== stream?.name,
  )
  /* Paste from this menu lands mid-stage rather than under the rail */
  const pasteAt = useRef({ x: 0, y: 0 })
  return (
    <>
      <ContextMenu>
        {/* every item in the frame menu is an edit */}
        <ContextMenuTrigger asChild disabled={readOnly}>
          <Row
            data-row-key={row.key}
            depth={0}
            drop={drop}
            caret={<Caret open={row.open} present />}
            onCaret={onToggle}
            icon={<FrameIcon className="size-3.5" />}
            label={frame.name}
            className={cn(current && !selected && 'text-ink')}
            selected={selected}
            hidden={!!frame.hidden}
            dimmed={!!frame.hidden}
            onToggleHidden={readOnly ? undefined : () => setFrameHidden(frame, !frame.hidden)}
            locked={!!frame.locked}
            onToggleLocked={readOnly ? undefined : () => setFramesLocked([frame], !frame.locked)}
            onClick={onActivate}
            onDoubleClick={() => useStore.getState().requestFlyTo(frame.id)}
            onContextMenu={() => {
              pasteAt.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
              if (!useStore.getState().selectedIds.includes(frame.id)) onActivate()
            }}
            trailing={
              <>
                <FrameApprovalBadge frame={frame} compact />
                {stream && (
                  <span className={editorChip} style={{ background: stream.color }}>
                    <AgentIcon name={stream.name} size={8} color="#fff" />
                    designing…
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
      {row.empty && <div className="py-1 pl-[46px] text-[11px] text-ink-faint">empty frame</div>}
    </>
  )
}

function NodeRow({
  row,
  selected,
  dragging,
  drop,
  onToggle,
  onActivate,
  onPointerDown,
}: {
  row: NodeVisibleRow
  selected: boolean
  dragging: boolean
  drop?: DropPlace
  onToggle: () => void
  onActivate: (toggle: boolean) => void
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const { frame, node } = row
  const readOnly = useStore((s) => !canEditOpenCanvas(s))
  const hasChildren = node.children.length > 0
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={readOnly}>
        <Row
          data-row-key={row.key}
          depth={row.depth}
          drop={drop}
          caret={<Caret open={row.open} present={hasChildren} />}
          onCaret={hasChildren ? onToggle : undefined}
          icon={<LayerKindIcon kind={node.kind} />}
          label={node.label}
          detail={node.detail}
          selected={selected}
          hidden={node.hidden}
          dimmed={row.dim || node.hidden}
          onToggleHidden={readOnly ? undefined : () => setLayerHidden(frame, node.selector, !node.hidden)}
          locked={node.locked}
          onToggleLocked={readOnly ? undefined : () => setLayerLocked(frame, node.selector, !node.locked)}
          className={cn(dragging && 'opacity-40')}
          onClick={(e) => onActivate(e.shiftKey || e.metaKey || e.ctrlKey)}
          onContextMenu={() => onActivate(false)}
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
  label: string
  detail?: string
  selected: boolean
  /** where a dragged layer would land on this row */
  drop?: DropPlace
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
  /* a selection made in the frame may sit far down the tree — bring it into view */
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div
      {...rest}
      ref={ref}
      role="treeitem"
      aria-selected={selected}
      className={cn(
        'group relative flex h-7 cursor-default select-none items-center gap-[5px] whitespace-nowrap rounded-[7px] pr-1.5 text-[12px] text-ink-soft hover:bg-sub',
        selected && 'bg-paper-deep font-medium text-ink hover:bg-paper-deep [&_[data-icon]]:text-ink',
        /* room under the floating eye and lock, so the name never runs beneath them */
        (onToggleHidden || onToggleLocked) &&
          (hidden || locked ? 'pr-[50px]' : 'focus-within:pr-[50px] hover:pr-[50px]'),
        drop === 'inside' && 'shadow-[inset_0_0_0_1.5px_var(--brand)]',
        className,
      )}
      style={{ ...rest.style, paddingLeft: 6 + depth * INDENT }}
      onClick={onClick}
    >
      {(drop === 'before' || drop === 'after') && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute right-1 z-[1] h-0.5 rounded-full bg-brand',
            drop === 'before' ? '-top-px' : '-bottom-px',
          )}
          style={{ left: 6 + depth * INDENT }}
        />
      )}
      <span
        data-icon
        className={cn('grid size-3 flex-none place-items-center text-ink-faint', onCaret && 'cursor-pointer')}
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
            'absolute top-0 right-0 flex h-full flex-none items-center gap-0.5 rounded-r-[7px] bg-inherit pr-1.5 pl-1',
            !hidden && !locked && 'invisible group-focus-within:visible group-hover:visible',
          )}
        >
          {onToggleHidden && (
            <RowToggle
              label={hidden ? 'Show' : 'Hide'}
              on={!!hidden}
              selected={selected}
              onToggle={onToggleHidden}
              icon={hidden ? <EyeClosedIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            />
          )}
          {onToggleLocked && (
            <RowToggle
              label={locked ? 'Unlock' : 'Lock'}
              on={!!locked}
              selected={selected}
              onToggle={onToggleLocked}
              icon={<LockIcon className="size-3" />}
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
