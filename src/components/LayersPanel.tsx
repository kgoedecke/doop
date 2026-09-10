import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import { getIdentity } from '../lib/identity'
import { deleteFramesTracked } from '../lib/history'
import { ancestorsOf, buildLayerTree, elementHtml, filterLayers, type LayerNode } from '../lib/layers'
import { deleteLayer, duplicateLayer } from '../lib/layerEdits'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { LayerKindIcon } from './LayerKindIcon'
import { FrameContextMenu } from './FrameContextMenu'
import { Panel, PanelBody, PanelHeader } from './ui/panel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Tooltip } from './ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { MenuHint } from './ui/menu'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CollapseAllIcon,
  FrameIcon,
  LayersIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  PlusIcon,
  SearchIcon,
} from './ui/icons'

/* the tree indents 18px per level; frame rows sit at depth 0 */
const INDENT = 18

const railBtn = 'shrink-0 text-ink-faint hover:bg-paper-deep hover:text-ink'
const sectionBtn = 'size-5 rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink'
const editorChip = 'inline-flex flex-none items-center gap-[3px] rounded-full px-1.5 text-[9.5px] font-bold text-white'

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
 *  it, and every element row knows its parent for ←. */
type VisibleRow =
  | { kind: 'frame'; key: string; frame: Frame; open: boolean; empty: boolean }
  | { kind: 'node'; key: string; frame: Frame; node: LayerNode; depth: number; open: boolean; parentKey: string }

function visibleRows(frames: Frame[], query: string, expanded: Set<string>): VisibleRow[] {
  const rows: VisibleRow[] = []
  for (const frame of frames) {
    const tree = query ? filterLayers(frameTree(frame), query) : null
    if (query && !frame.name.toLowerCase().includes(query) && tree?.length === 0) continue
    const open = !!query || expanded.has(frame.id)
    const nodes = open ? (tree ?? frameTree(frame)) : []
    rows.push({ kind: 'frame', key: frame.id, frame, open, empty: open && nodes.length === 0 })
    const walk = (list: LayerNode[], depth: number, parentKey: string) => {
      for (const node of list) {
        const key = rowKey(frame.id, node.selector)
        const nodeOpen = node.children.length > 0 && (!!query || expanded.has(key))
        rows.push({ kind: 'node', key, frame, node, depth, open: nodeOpen, parentKey })
        if (nodeOpen) walk(node.children, depth + 1, key)
      }
    }
    walk(nodes, 1, frame.id)
  }
  return rows
}

/** The Layers rail: every frame on the canvas, opening into the element tree
 *  of its HTML. Selection runs both ways — a row selects the element in the
 *  frame, a click in the frame highlights its row. */
export function LayersPanel({ onAddFrame }: { onAddFrame: () => void }) {
  const frames = useStore((s) => s.canvas?.frames ?? [])
  const selectedId = useStore((s) => s.selectedId)
  const selectedElement = useStore((s) => s.selectedElement)
  const setLayersOpen = useStore((s) => s.setLayersOpen)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

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
  const currentKey = selectedElement ? rowKey(selectedElement.frameId, selectedElement.selector) : selectedId

  /* a layer row opens the element properties panel; a frame row closes it
     and leaves the frame's own inspector to the frame-name click */
  function activate(row: VisibleRow) {
    const s = useStore.getState()
    s.select(row.frame.id)
    s.setSelectedElement(row.kind === 'node' ? { frameId: row.frame.id, selector: row.node.selector } : null)
    s.setElementPanelOpen(row.kind === 'node')
  }

  /* ↑↓ walk the visible rows, ←→ close and open them, ⌫ deletes what is
     selected, ↵ flies to the frame — the panel is a tree, so it drives like one */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const index = rows.findIndex((r) => r.key === currentKey)
    const row = index >= 0 ? rows[index] : undefined
    const step = (dir: 1 | -1) => {
      const next = rows[index < 0 ? (dir === 1 ? 0 : rows.length - 1) : index + dir]
      if (next) activate(next)
    }
    switch (e.key) {
      case 'ArrowDown':
        step(1)
        break
      case 'ArrowUp':
        step(-1)
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
        if (row?.kind === 'frame') deleteFramesTracked([row.frame])
        else if (row) deleteLayer(row.frame, row.node.selector)
        break
      default:
        return
    }
    e.preventDefault()
  }

  return (
    <Panel className="left-3 inset-y-3 w-[300px]">
      <PanelHeader>
        <span className="rounded-sm bg-paper-deep px-2 py-[3px] font-mono text-[11px] font-medium uppercase tracking-[0.09em] text-ink">
          Layers
        </span>
        <Tooltip label="Collapse panel" side="bottom" align="end">
          <Button
            variant="bare"
            size="icon-sm"
            className={railBtn}
            aria-label="Collapse panel"
            onClick={() => setLayersOpen(false)}
          >
            <PanelCollapseIcon width={13} height={13} />
          </Button>
        </Tooltip>
      </PanelHeader>
      <label className="mx-3 mt-2.5 mb-1 flex h-8 items-center gap-2 rounded-lg border border-line bg-paper px-2.5 text-ink-faint focus-within:border-ink">
        <SearchIcon width={13} height={13} className="flex-none" />
        <Input
          variant="bare"
          inputSize="auto"
          className="h-full text-[12.5px] md:text-[12.5px]"
          placeholder="Search layers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="flex items-center justify-between py-1 pr-2 pl-3.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        <span>Frames · {frames.length}</span>
        <span className="flex gap-0.5">
          <Tooltip label="Collapse all" side="bottom">
            <Button
              variant="bare"
              size="icon-sm"
              className={sectionBtn}
              aria-label="Collapse all"
              onClick={() => setExpanded(new Set())}
            >
              <CollapseAllIcon width={12} height={12} />
            </Button>
          </Tooltip>
          <Tooltip label="New frame" side="bottom" align="end">
            <Button variant="bare" size="icon-sm" className={sectionBtn} aria-label="New frame" onClick={onAddFrame}>
              <PlusIcon width={12} height={12} />
            </Button>
          </Tooltip>
        </span>
      </div>
      <PanelBody className="px-2 pb-2 outline-none" role="tree" tabIndex={0} onKeyDown={onKeyDown}>
        {frames.length === 0 && (
          <div className="px-3 py-6 text-center text-[12.5px] text-ink-faint">
            No frames yet. Press + to add one, or ask the agent for a design.
          </div>
        )}
        {frames.length > 0 && rows.length === 0 && (
          <div className="px-3 py-6 text-center text-[12.5px] text-ink-faint">Nothing matches “{query.trim()}”.</div>
        )}
        {rows.map((row) =>
          row.kind === 'frame' ? (
            <FrameRow
              key={row.key}
              row={row}
              selected={row.frame.id === selectedId && !selectedElement}
              current={row.frame.id === selectedId}
              onToggle={() => setOpen(row.key, !row.open)}
              onActivate={() => activate(row)}
            />
          ) : (
            <NodeRow
              key={row.key}
              row={row}
              selected={row.key === currentKey}
              onToggle={() => setOpen(row.key, !row.open)}
              onActivate={() => activate(row)}
            />
          ),
        )}
      </PanelBody>
      <footer className="flex flex-none items-center justify-between gap-2 whitespace-nowrap border-t border-line-soft px-3 py-[9px] font-mono text-[10px] tracking-[0.04em] text-ink-faint">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move · <Kbd>←</Kbd>
          <Kbd>→</Kbd> fold
        </span>
        <span>
          <Kbd>↵</Kbd> fly to frame
        </span>
      </footer>
    </Panel>
  )
}

/** The collapsed rail: a narrow column at the panel's spot with the expand
 *  control and the Layers mark carrying the frame count, as in the design. */
export function LayersRailToggle() {
  const setLayersOpen = useStore((s) => s.setLayersOpen)
  const count = useStore((s) => s.canvas?.frames.length ?? 0)
  return (
    <nav
      aria-label="Layers panel"
      className="absolute left-3 top-3 z-[35] flex w-12 flex-col items-center gap-1.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-card"
    >
      <Tooltip label="Expand panel" side="right">
        <Button
          variant="bare"
          size="icon-sm"
          className="size-[34px] rounded-lg text-ink-soft hover:bg-paper-deep hover:text-ink"
          aria-label="Expand panel"
          onClick={() => setLayersOpen(true)}
        >
          <PanelExpandIcon width={16} height={16} />
        </Button>
      </Tooltip>
      <span className="my-0.5 h-px w-6 bg-line-soft" />
      <Tooltip label={`Layers · ${count} ${count === 1 ? 'frame' : 'frames'}`} side="right">
        <Button
          variant="bare"
          size="icon-sm"
          className="relative size-[34px] rounded-lg bg-brand/[0.06] text-brand hover:bg-brand/10 hover:text-brand"
          aria-label={`Layers — ${count} frames`}
          onClick={() => setLayersOpen(true)}
        >
          <LayersIcon width={16} height={16} />
          {count > 0 && (
            <span className="absolute -top-0.5 -right-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg border-2 border-surface bg-brand px-[3px] font-mono text-[8px] font-medium text-white">
              {count}
            </span>
          )}
        </Button>
      </Tooltip>
    </nav>
  )
}

function FrameRow({
  row,
  selected,
  current,
  onToggle,
  onActivate,
}: {
  row: Extract<VisibleRow, { kind: 'frame' }>
  selected: boolean
  /** the frame is selected, whether or not an element inside it is */
  current: boolean
  onToggle: () => void
  onActivate: () => void
}) {
  const { frame } = row
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
        <ContextMenuTrigger asChild>
          <Row
            depth={0}
            caret={<Caret open={row.open} present />}
            onCaret={onToggle}
            icon={<FrameIcon width={13} height={13} />}
            label={frame.name}
            className={cn('font-semibold', current && !selected && 'text-brand [&_[data-icon]]:text-brand')}
            selected={selected}
            onClick={onActivate}
            onDoubleClick={() => useStore.getState().requestFlyTo(frame.id)}
            onContextMenu={() => {
              pasteAt.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
              if (!useStore.getState().selectedIds.includes(frame.id)) onActivate()
            }}
            trailing={
              <>
                {stream && (
                  <span className={editorChip} style={{ background: stream.color }}>
                    <AgentIcon name={stream.name} size={8} color="#fff" />
                    designing…
                  </span>
                )}
                {editors.map((p) => (
                  <span key={p.clientId} className={editorChip} style={{ background: p.color }}>
                    {p.kind === 'agent' ? <AgentIcon name={p.name} size={8} color="#fff" /> : '✎'}
                    {p.name}
                  </span>
                ))}
              </>
            }
          />
        </ContextMenuTrigger>
        <FrameContextMenu frame={frame} at={pasteAt} />
      </ContextMenu>
      {row.empty && <div className="py-1 pl-[42px] text-[11.5px] text-ink-faint">empty frame</div>}
    </>
  )
}

function NodeRow({
  row,
  selected,
  onToggle,
  onActivate,
}: {
  row: Extract<VisibleRow, { kind: 'node' }>
  selected: boolean
  onToggle: () => void
  onActivate: () => void
}) {
  const { frame, node } = row
  const hasChildren = node.children.length > 0
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Row
          depth={row.depth}
          caret={<Caret open={row.open} present={hasChildren} />}
          onCaret={hasChildren ? onToggle : undefined}
          icon={<LayerKindIcon kind={node.kind} />}
          label={node.label}
          detail={node.detail}
          selected={selected}
          onClick={onActivate}
          onContextMenu={onActivate}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            const html = elementHtml(frame.html, node.selector)
            if (html) navigator.clipboard.writeText(html).catch(console.error)
          }}
        >
          Copy HTML
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => navigator.clipboard.writeText(node.selector).catch(console.error)}>
          Copy selector
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => duplicateLayer(frame, node.selector)}>Duplicate</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem tone="danger" onSelect={() => deleteLayer(frame, node.selector)}>
          Delete element
          <MenuHint>⌫</MenuHint>
        </ContextMenuItem>
      </ContextMenuContent>
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
  trailing?: ReactNode
  onClick: () => void
}

function Row({
  depth,
  caret,
  onCaret,
  icon,
  label,
  detail,
  selected,
  className,
  trailing,
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
        'flex h-[26px] cursor-default select-none items-center gap-1 whitespace-nowrap rounded-md pr-1.5 text-[12.5px] text-ink hover:bg-paper-deep',
        selected && 'bg-brand text-white hover:bg-brand [&_[data-icon]]:text-white/85',
        className,
      )}
      style={{ ...rest.style, paddingLeft: 6 + depth * INDENT }}
      onClick={onClick}
    >
      <span
        data-icon
        className={cn('grid size-3.5 flex-none place-items-center text-ink-faint', onCaret && 'cursor-pointer')}
        onClick={(e) => {
          if (!onCaret) return
          e.stopPropagation()
          onCaret()
        }}
      >
        {caret}
      </span>
      <span data-icon className="grid size-4 flex-none place-items-center text-ink-faint">
        {icon}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">
        {label}
        {detail && <span className={cn('text-ink-faint', selected && 'text-white/85')}>{detail}</span>}
      </span>
      {trailing && <span className="flex flex-none items-center gap-1">{trailing}</span>}
    </div>
  )
}

function Caret({ open, present }: { open: boolean; present: boolean }) {
  if (!present) return null
  return open ? <ChevronDownIcon width={11} height={11} /> : <ChevronRightIcon width={11} height={11} />
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mr-0.5 inline-block rounded-[5px] border border-line bg-paper px-1 font-mono text-[9.5px] leading-[15px] text-ink-soft">
      {children}
    </kbd>
  )
}
