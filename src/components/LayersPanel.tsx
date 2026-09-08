import { useEffect, useMemo, useState } from 'react'
import type { Frame } from '../../shared/types'
import { useStore } from '../lib/store'
import { commitDesignEdit, selectDesignElement, selectDesignFrame, useDesignEditor } from '../lib/designEditor'
import { flattenLayers, parseDesign, readLayers, type DesignLayer } from '../lib/designDocument'
import { cn } from '@/lib/utils'
import { Panel, PanelBody, PanelClose, PanelHeader } from './ui/panel'
import { Button } from './ui/button'
import {
  BoxIcon,
  ChevronRightIcon,
  CollapseAllIcon,
  EyeIcon,
  EyeOffIcon,
  FrameIcon,
  ImageIcon,
  LockIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  TargetIcon,
  TextIcon,
  UnlockIcon,
  VectorIcon,
} from './ui/icons'
import { DesignInput, Kbd } from './design/Controls'

interface FrameTree {
  frame: Frame
  layers: DesignLayer[]
  truncated: boolean
}

/* A tree row: 25px, hairline-free, the selected element fills brand blue and
   the selected frame just turns its text blue — the frame is the container,
   the element is the thing being edited. */
const rowClass =
  'group flex h-[25px] cursor-default items-center gap-1 rounded-md pr-1 text-[12.5px] outline-none focus-visible:ring-1 focus-visible:ring-brand max-md:h-9'
const actionClass =
  'grid size-[18px] shrink-0 place-items-center rounded text-current opacity-80 hover:opacity-100 disabled:opacity-30'
const headerActionClass =
  'grid size-5 shrink-0 place-items-center rounded-[5px] text-ink-faint hover:bg-paper-deep hover:text-ink disabled:opacity-30'

function LayerGlyph({ layer, className }: { layer: DesignLayer; className?: string }) {
  const Icon = layer.image ? ImageIcon : layer.text.trim() ? TextIcon : layer.tag === 'svg' ? VectorIcon : BoxIcon
  return <Icon className={cn('size-[13px]', className)} strokeWidth={1.9} />
}

/** `aside.rail` reads as tag + a quiet class; plain names stay as they are. */
function LayerName({ name }: { name: string }) {
  const match = name.match(/^([a-z][a-z0-9-]*)([.#][\w.-]+)$/i)
  if (!match) return <>{name}</>
  return (
    <>
      {match[1]}
      <span className="opacity-60">{match[2]}</span>
    </>
  )
}

export function LayersPanel({
  onClose,
  onAddFrame,
  surface = 'floating',
}: {
  onClose(): void
  onAddFrame(): void
  surface?: 'floating' | 'inline'
}) {
  const frames = useStore((s) => s.canvas?.frames)
  const selectedId = useStore((s) => s.selectedId)
  const selection = useDesignEditor((s) => s.selection)
  const busy = useDesignEditor((s) => s.busy)
  const inlineFrameId = useDesignEditor((s) => s.inlineFrameId)
  const [tab, setTab] = useState<'layers' | 'assets'>('layers')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [imageUrl, setImageUrl] = useState('')
  const trees = useMemo<FrameTree[]>(
    () => (frames ?? []).map((frame) => ({ frame, ...readLayers(parseDesign(frame.html)) })),
    [frames],
  )
  const needle = search.toLowerCase().trim()

  // Reveal all ancestors when selection originates from the canvas or inspector.
  useEffect(() => {
    if (!selection) return
    const tree = trees.find((item) => item.frame.id === selection.frameId)
    if (!tree) return
    const layers = flattenLayers(tree.layers)
    let selected = layers.find((layer) => layer.selector === selection.selector)
    if (!selected) return
    const ancestors = [`frame:${tree.frame.id}`]
    while (selected?.parent) {
      ancestors.push(`${tree.frame.id}:${selected.parent}`)
      selected = layers.find((layer) => layer.selector === selected?.parent)
    }
    setOpen((previous) => new Set([...previous, ...ancestors]))
  }, [selection, trees])

  function toggle(key: string) {
    setOpen((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  function selectLayer(frameId: string, selector: string) {
    if (selectedId !== frameId) useStore.getState().requestFlyTo(frameId)
    selectDesignElement(frameId, selector)
  }
  function matches(layer: DesignLayer): boolean {
    return (
      !needle ||
      `${layer.name} ${layer.tag} ${layer.text}`.toLowerCase().includes(needle) ||
      layer.children.some(matches)
    )
  }
  function keyNavigation(
    e: React.KeyboardEvent,
    expanded: boolean,
    hasChildren: boolean,
    toggleOpen: () => void,
    activate: () => void,
  ) {
    if (e.target !== e.currentTarget) return
    const items = [
      ...(e.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []),
    ]
    const index = items.indexOf(e.currentTarget as HTMLElement)
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault()
      e.stopPropagation()
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : index + (e.key === 'ArrowDown' ? 1 : -1)
      items[Math.max(0, Math.min(items.length - 1, next))]?.focus()
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (hasChildren && !expanded) toggleOpen()
      else items[index + 1]?.focus()
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (hasChildren && expanded) toggleOpen()
      else {
        const level = Number(e.currentTarget.getAttribute('aria-level'))
        items
          .slice(0, index)
          .reverse()
          .find((item) => Number(item.getAttribute('aria-level')) < level)
          ?.focus()
      }
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      activate()
    }
    if (e.key === 'F2') {
      e.preventDefault()
      activate()
      requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>('[aria-label="Layer name"], [aria-label="Frame name"]')?.focus(),
      )
    }
  }

  function renderLayer(frameId: string, layer: DesignLayer): React.ReactNode {
    if (!matches(layer)) return null
    const key = `${frameId}:${layer.selector}`
    const expanded = !!needle || open.has(key)
    const active = selection?.frameId === frameId && selection.selector === layer.selector
    return (
      <div key={key}>
        <div
          role="treeitem"
          aria-level={layer.depth + 2}
          aria-expanded={layer.children.length ? expanded : undefined}
          aria-selected={active}
          aria-label={layer.name}
          tabIndex={active ? 0 : -1}
          data-layer-selector={layer.selector}
          className={cn(
            rowClass,
            active ? 'bg-brand text-white' : 'text-ink hover:bg-paper-deep',
            layer.hidden && 'opacity-50',
          )}
          style={{ paddingLeft: Math.min(layer.depth + 1, 9) * 16 + 6 }}
          onClick={() => selectLayer(frameId, layer.selector)}
          onDoubleClick={() => useStore.getState().requestFlyTo(frameId)}
          onKeyDown={(e) =>
            keyNavigation(
              e,
              expanded,
              !!layer.children.length,
              () => toggle(key),
              () => selectLayer(frameId, layer.selector),
            )
          }
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${layer.name}`}
            className={cn(
              'grid size-3.5 shrink-0 place-items-center',
              active ? 'text-white/85' : 'text-ink-faint',
              !layer.children.length && 'invisible',
            )}
            onClick={(e) => {
              e.stopPropagation()
              toggle(key)
            }}
          >
            <ChevronRightIcon className={cn('size-[11px] transition-transform', expanded && 'rotate-90')} />
          </button>
          <span className={cn('grid size-4 shrink-0 place-items-center', active ? 'text-white/85' : 'text-ink-faint')}>
            <LayerGlyph layer={layer} />
          </span>
          <span className="min-w-0 flex-1 truncate" title={layer.name}>
            <LayerName name={layer.name} />
          </span>
          <div
            className={cn(
              'flex gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100',
              active ? 'text-white' : 'text-ink-faint',
              (active || layer.locked || layer.hidden) && 'opacity-100',
            )}
          >
            <button
              type="button"
              aria-label={`${layer.hidden ? 'Show' : 'Hide'} ${layer.name}`}
              disabled={busy || inlineFrameId === frameId || layer.locked}
              className={actionClass}
              onClick={(e) => {
                e.stopPropagation()
                void commitDesignEdit(frameId, layer.selector, { type: 'visibility' })
              }}
            >
              {layer.hidden ? <EyeOffIcon className="size-[13px]" /> : <EyeIcon className="size-[13px]" />}
            </button>
            <button
              type="button"
              aria-label={`${layer.ownLocked ? 'Unlock' : 'Lock'} ${layer.name}`}
              disabled={busy || inlineFrameId === frameId || (layer.locked && !layer.ownLocked)}
              className={actionClass}
              onClick={(e) => {
                e.stopPropagation()
                void commitDesignEdit(frameId, layer.selector, { type: 'lock' })
              }}
            >
              {layer.locked ? <LockIcon className="size-3" /> : <UnlockIcon className="size-3" />}
            </button>
          </div>
        </div>
        {expanded && layer.children.length > 0 && (
          <div role="group">{layer.children.map((child) => renderLayer(frameId, child))}</div>
        )}
      </div>
    )
  }

  const visibleTrees = trees.filter(
    (tree) => !needle || tree.frame.name.toLowerCase().includes(needle) || tree.layers.some(matches),
  )
  const assets = trees.flatMap((tree) =>
    flattenLayers(tree.layers)
      .filter((layer) => layer.image && (!needle || `${layer.name} ${layer.image}`.toLowerCase().includes(needle)))
      .map((layer) => ({ frame: tree.frame, layer })),
  )
  return (
    <Panel
      aria-label="Layer navigator"
      surface={surface}
      className={cn(surface === 'floating' && 'left-3 inset-y-3 w-[260px]')}
    >
      <PanelHeader>
        <div className="flex min-w-0 gap-0.5" role="tablist" aria-label="Navigator view">
          {(['layers', 'assets'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={cn(
                'rounded-sm px-2 py-[3px] font-mono text-[11px] font-medium uppercase tracking-[0.09em] transition-colors',
                tab === value ? 'bg-paper-deep text-ink' : 'text-ink-faint hover:text-ink',
              )}
              onClick={() => setTab(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <PanelClose label="Collapse layers" onClick={onClose}>
          <PanelLeftIcon className="size-[13px]" strokeWidth={1.9} />
        </PanelClose>
      </PanelHeader>
      <label className="mx-3 mt-2.5 mb-1 flex h-8 items-center gap-2 rounded-lg border border-line bg-paper px-2.5 text-[12.5px] text-ink-faint focus-within:border-ink">
        <SearchIcon className="size-[13px] shrink-0" strokeWidth={1.9} />
        <input
          aria-label="Search layers and assets"
          placeholder={tab === 'layers' ? 'Search layers' : 'Search images'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-faint"
        />
      </label>
      <PanelBody>
        {tab === 'layers' ? (
          <>
            <div className="flex items-center justify-between py-1.5 pr-3 pl-3.5">
              <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
                Frames · {trees.length}
              </span>
              <div className="flex gap-0.5">
                <button
                  type="button"
                  aria-label="Collapse all layers"
                  title="Collapse all layers"
                  className={headerActionClass}
                  onClick={() => setOpen(new Set())}
                >
                  <CollapseAllIcon className="size-3" strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  aria-label="Add frame"
                  title="Add frame"
                  className={headerActionClass}
                  onClick={onAddFrame}
                >
                  <PlusIcon className="size-3" strokeWidth={1.9} />
                </button>
              </div>
            </div>
            <div role="tree" aria-label="Canvas layers" className="px-2 pb-4">
              {visibleTrees.map(({ frame, layers, truncated }, index) => {
                const key = `frame:${frame.id}`
                const expanded = !!needle || open.has(key)
                const active = selectedId === frame.id && !selection
                const holds = selectedId === frame.id && !!selection
                return (
                  <div key={frame.id} className={index > 0 ? 'mt-1.5' : undefined}>
                    <div
                      role="treeitem"
                      aria-label={frame.name}
                      aria-level={1}
                      aria-expanded={expanded}
                      aria-selected={active}
                      tabIndex={active || (index === 0 && !selection) ? 0 : -1}
                      className={cn(
                        rowClass,
                        'h-[26px] pl-1.5 font-semibold',
                        active
                          ? 'bg-brand/[0.08] text-brand'
                          : holds
                            ? 'text-brand hover:bg-paper-deep'
                            : 'hover:bg-paper-deep',
                      )}
                      onClick={() => {
                        selectDesignFrame(frame.id)
                        if (!open.has(key)) toggle(key)
                      }}
                      onDoubleClick={() => useStore.getState().requestFlyTo(frame.id)}
                      onKeyDown={(e) =>
                        keyNavigation(
                          e,
                          expanded,
                          true,
                          () => toggle(key),
                          () => selectDesignFrame(frame.id),
                        )
                      }
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${frame.name}`}
                        className={cn(
                          'grid size-3.5 shrink-0 place-items-center',
                          active || holds ? 'text-brand' : 'text-ink-faint',
                        )}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggle(key)
                        }}
                      >
                        <ChevronRightIcon className={cn('size-[11px] transition-transform', expanded && 'rotate-90')} />
                      </button>
                      <span
                        className={cn(
                          'grid size-4 shrink-0 place-items-center',
                          active || holds ? 'text-brand' : 'text-ink-faint',
                        )}
                      >
                        <FrameIcon className="size-[13px]" strokeWidth={1.9} />
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={frame.name}>
                        {frame.name}
                      </span>
                      <button
                        type="button"
                        aria-label={`Zoom to ${frame.name}`}
                        title="Zoom to frame"
                        className={cn(
                          actionClass,
                          'text-ink-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100',
                        )}
                        onClick={(e) => {
                          e.stopPropagation()
                          selectDesignFrame(frame.id)
                          useStore.getState().requestFlyTo(frame.id)
                        }}
                      >
                        <TargetIcon className="size-[13px]" strokeWidth={1.9} />
                      </button>
                    </div>
                    {expanded && (
                      <div role="group">
                        {layers.map((layer) => renderLayer(frame.id, layer))}
                        {truncated && (
                          <p className="px-4 py-2 text-[10px] text-ink-faint">
                            Showing the first 3,000 layers, up to 80 levels deep.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              {!visibleTrees.length && (
                <p className="px-4 py-8 text-center text-xs text-ink-faint">
                  {needle ? 'No matching layers.' : 'Add a frame to start designing.'}
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-4 p-3">
            <div>
              <p className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
                Insert into selection
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={!selectedId || busy}
                  onClick={() =>
                    selectedId &&
                    void commitDesignEdit(selectedId, selection?.selector || 'body', { type: 'insert', kind: 'text' })
                  }
                >
                  + Text
                </Button>
                <Button
                  size="sm"
                  disabled={!selectedId || busy}
                  onClick={() =>
                    selectedId &&
                    void commitDesignEdit(selectedId, selection?.selector || 'body', { type: 'insert', kind: 'box' })
                  }
                >
                  + Container
                </Button>
              </div>
              <div className="mt-2">
                <DesignInput label="New image URL" value={imageUrl} placeholder="Image URL…" onCommit={setImageUrl} />
              </div>
              <Button
                size="sm"
                className="mt-2 w-full"
                disabled={!selectedId || busy}
                onClick={() =>
                  selectedId &&
                  void commitDesignEdit(selectedId, selection?.selector || 'body', {
                    type: 'insert',
                    kind: 'image',
                    src: imageUrl,
                  })
                }
              >
                + Image
              </Button>
            </div>
            <div className="border-t border-line-soft pt-3">
              <p className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
                Images in this canvas · {assets.length}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {assets.map(({ frame, layer }) => (
                  <button
                    type="button"
                    key={`${frame.id}:${layer.selector}`}
                    className="min-w-0 overflow-hidden rounded-lg border border-line-soft text-left hover:border-brand"
                    onClick={() => selectLayer(frame.id, layer.selector)}
                  >
                    <img src={layer.image} alt="" loading="lazy" className="h-20 w-full bg-paper object-cover" />
                    <span className="block truncate p-2 text-[10px]" title={layer.name}>
                      {layer.name}
                    </span>
                  </button>
                ))}
              </div>
              {!assets.length && <p className="py-5 text-center text-xs text-ink-faint">No image layers found.</p>}
            </div>
          </div>
        )}
      </PanelBody>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line-soft px-3 py-[9px] font-mono text-[10px] tracking-[0.04em] whitespace-nowrap text-ink-faint">
        <span>
          {trees.length} {trees.length === 1 ? 'frame' : 'frames'}
        </span>
        <span>
          <Kbd>Shift 1</Kbd> fit &nbsp;·&nbsp; <Kbd>Shift 2</Kbd> selection
        </span>
      </footer>
    </Panel>
  )
}
