import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentDef } from '../../shared/components'
import { api, type ComponentCandidate, type ComponentLibrary } from '../lib/api'
import { COMPONENT_DRAG_TYPE, goToMain, makeComponent, placeComponent, removeComponent } from '../lib/components'
import { useT } from '../lib/i18n'
import { cn } from '@/lib/utils'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { ComponentIcon, MoreHorizontalIcon } from './ui/icons'
import { IconButton } from './ui/icon-button'
import { SearchField } from './ui/search-field'

/** A component's sheet in an inert iframe: no scripts, no clicks, scaled to the card. */
function ComponentThumb({ def, canvasId }: { def: ComponentDef; canvasId: string }) {
  const t = useT()
  const [sheet, setSheet] = useState<{ key: string; html: string; width: number; height: number } | null>(null)
  const key = `${def.id}:${def.rev}`
  /* the panel is resizable, so the sheet scales to the card it is in */
  const box = useRef<HTMLDivElement>(null)
  const [boxWidth, setBoxWidth] = useState(0)
  useEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBoxWidth(entry.contentRect.width)
    })
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let live = true
    api
      .componentPreview(canvasId, def.id)
      .then((next) => {
        if (live) setSheet({ key, ...next })
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [canvasId, def.id, key])
  const ready = sheet?.key === key && boxWidth > 0
  const scale = ready ? boxWidth / sheet.width : 1
  return (
    <div ref={box} className="w-full">
      {ready ? (
        <div className="overflow-hidden rounded-row bg-surface shadow-ring" style={{ height: sheet.height * scale }}>
          <iframe
            title={t('components.previewTitle', { name: def.name })}
            sandbox=""
            srcDoc={sheet.html}
            tabIndex={-1}
            className="pointer-events-none origin-top-left border-0"
            style={{ width: sheet.width, height: sheet.height, transform: `scale(${scale})` }}
          />
        </div>
      ) : (
        <div className="h-16 rounded-row bg-paper-deep" />
      )}
    </div>
  )
}

/** The library rail: what this canvas has, what it could turn into components,
 *  and what other canvases offer. */
export function ComponentsPanel() {
  const t = useT()
  const canvasId = useStore((s) => s.canvas?.id)
  const components = useStore((s) => s.canvas?.components)
  const canEdit = useStore(canEditOpenCanvas)
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<ComponentCandidate[] | null>(null)
  const [libraries, setLibraries] = useState<ComponentLibrary[] | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ComponentDef | null>(null)

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return [...(components ?? [])]
      .filter((def) => !wanted || `${def.name} ${def.description}`.toLowerCase().includes(wanted))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [components, query])

  if (!canvasId) return null
  const scan = () => api.componentCandidates(canvasId).then(setCandidates).catch(console.error)
  const browse = () => api.componentLibraries(canvasId).then(setLibraries).catch(console.error)
  const convert = async (candidate: ComponentCandidate) => {
    const frame = useStore.getState().canvas?.frames.find((f) => f.id === candidate.example.frame_id)
    if (!frame) return
    await makeComponent(frame, candidate.example.element, candidate.suggested_name, true)
    await scan()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pt-2 pb-3" data-slot="components-panel">
      <SearchField
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('components.search')}
      />
      {shown.length === 0 && (
        <p className="px-0.5 text-caption text-ink-soft">
          {components?.length ? t('components.noMatch') : t('components.empty')}
        </p>
      )}
      {shown.map((def) => (
        <article key={def.id} className="flex flex-col gap-1.5" data-component-card={def.name}>
          {/* the card is picked up and dropped onto the canvas; the menu holds the rest */}
          <div
            draggable={canEdit}
            aria-label={canEdit ? t('components.dragHint', { name: def.name }) : def.name}
            className={cn('flex w-full flex-col gap-1.5 text-left', canEdit && 'cursor-grab active:cursor-grabbing')}
            onDragStart={(event) => {
              event.dataTransfer.setData(COMPONENT_DRAG_TYPE, def.id)
              event.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <ComponentThumb def={def} canvasId={canvasId} />
            <span className="flex min-w-0 items-center gap-1.5 text-body text-ink">
              <ComponentIcon size="rail" className="flex-none text-brand" />
              <span className="truncate">{def.name}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    size="sm"
                    className="ml-auto flex-none"
                    aria-label={t('components.moreActions', { name: def.name })}
                    data-component-menu
                  >
                    <MoreHorizontalIcon size="rail" aria-hidden />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width="md">
                  {canEdit && (
                    <DropdownMenuItem onSelect={() => void placeComponent(def)}>
                      {t('components.insertInstance')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => goToMain(def)}>{t('components.goToMain')}</DropdownMenuItem>
                  {canEdit && def.source && (
                    <DropdownMenuItem
                      onSelect={() => {
                        api
                          .syncComponent(canvasId, def.id)
                          .then(({ updated }) =>
                            useStore
                              .getState()
                              .pushNotice(
                                updated ? t('components.pulled', { name: def.name }) : t('components.upToDate'),
                              ),
                          )
                          .catch(console.error)
                      }}
                    >
                      {t('components.pullUpdate')}
                    </DropdownMenuItem>
                  )}
                  {canEdit && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-accent-ink data-[highlighted]:text-accent-ink"
                        onSelect={() => setConfirmDelete(def)}
                      >
                        {t('components.deleteComponent')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
          {def.description && <p className="line-clamp-2 text-caption text-ink-soft">{def.description}</p>}
        </article>
      ))}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={t('components.deleteConfirmTitle', { name: confirmDelete?.name ?? '' })}
        description={t('components.deleteConfirmDescription')}
        confirmLabel={t('components.deleteComponent')}
        destructive
        onConfirm={() => {
          const target = confirmDelete
          setConfirmDelete(null)
          if (target) void removeComponent(target)
        }}
      />
      {canEdit && (
        <div className="mt-1 flex flex-col gap-1.5 border-t border-line-soft pt-2.5">
          <Button size="sm" onClick={() => void scan()}>
            {t('components.findRepeated')}
          </Button>
          {candidates?.length === 0 && <p className="text-caption text-ink-soft">{t('components.nothingRepeats')}</p>}
          {candidates?.map((candidate) => (
            <div key={`${candidate.example.frame_id}:${candidate.example.element}`} className="flex flex-col gap-0.5">
              <span className="text-body text-ink">{candidate.suggested_name}</span>
              <span className="text-caption text-ink-soft">
                {t('components.copiesInFrames', { copies: candidate.occurrences, count: candidate.frames })}
                {candidate.sample_text ? `, “${candidate.sample_text}”` : ''}
              </span>
              <Button size="inline" variant="link" onClick={() => void convert(candidate)}>
                {t('components.makeAndLink')}
              </Button>
            </div>
          ))}
          <Button size="sm" onClick={() => void browse()}>
            {t('components.importFromCanvas')}
          </Button>
          {libraries?.length === 0 && <p className="text-caption text-ink-soft">{t('components.noLibraries')}</p>}
          {libraries?.map((library) => (
            <div key={library.id} className="flex flex-col gap-0.5">
              <span className="text-caption text-ink-soft">{library.name}</span>
              {library.components.map((entry) => (
                <Button
                  key={entry.id}
                  size="inline"
                  variant="link"
                  onClick={() => {
                    api
                      .importComponent(canvasId, library.id, entry.id)
                      .then(() => useStore.getState().pushNotice(t('components.imported', { name: entry.name })))
                      .catch((error: unknown) =>
                        useStore
                          .getState()
                          .pushNotice(error instanceof Error ? error.message : t('components.importFailed')),
                      )
                  }}
                >
                  {entry.name}
                </Button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
