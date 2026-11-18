import { useMemo, useRef, useState } from 'react'
import { activeComponents, type WireComponentDef } from '../../shared/components'
import { api, type ComponentLibrary } from '../lib/api'
import { COMPONENT_DRAG_TYPE, goToMain, placeComponent, removeComponent, renameComponent } from '../lib/components'
import { useT } from '../lib/i18n'
import { useCanvasLibrary } from '../lib/library'
import { useLibraryResume } from '../lib/libraryResume'
import { cn } from '@/lib/utils'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { ImportCanvasList, ImportComponentsModal } from './ComponentImport'
import { ComponentThumb, useTokenStamp } from './ComponentThumb'
import { LibraryNotices, LibrarySection, LibraryUpgradeFlow, PublishLibraryDialog } from './LibrarySection'
import { ConfirmDialog } from './ui/alert-dialog'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { BookOpenIcon, ComponentIcon, MoreHorizontalIcon } from './ui/icons'
import { IconButton } from './ui/icon-button'
import { Input } from './ui/input'
import { PanelSearch } from './ui/panel'

/** The card's name as a field: Enter or a blur saves, Escape puts it back. */
function ComponentNameInput({ def, onDone }: { def: WireComponentDef; onDone: () => void }) {
  const t = useT()
  const finished = useRef(false)
  function finish(input: HTMLInputElement, save: boolean) {
    if (finished.current) return
    finished.current = true
    if (save) void renameComponent(def, input.value)
    onDone()
  }
  return (
    <Input
      autoFocus
      aria-label={t('components.nameAria')}
      variant="bare"
      inputSize="auto"
      className="h-5 min-w-0 flex-1 bg-surface px-1 text-ink shadow-elevation-1-focus md:text-body"
      defaultValue={def.name}
      onFocus={(event) => event.target.select()}
      onBlur={(event) => finish(event.currentTarget, true)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return
        event.preventDefault()
        finish(event.currentTarget, event.key === 'Enter')
      }}
    />
  )
}

/** The library rail: what this canvas has, what it could turn into components,
 *  and what other canvases offer. */
export function ComponentsPanel() {
  const t = useT()
  const canvasId = useStore((s) => s.canvas?.id)
  const components = useStore((s) => s.canvas?.components)
  const canvasName = useStore((s) => s.canvas?.name)
  const canEdit = useStore(canEditOpenCanvas)
  const tokenStamp = useTokenStamp()
  const shared = useCanvasLibrary(canvasId ?? '', canEdit)
  /* the publish dialog (`only` = opened from that component's menu) and the way to a library */
  const [publishing, setPublishing] = useState<{ only?: string } | null>(null)
  const [wall, setWall] = useState<{ workspaceId?: string; reason: string; only?: string } | null>(null)
  /* back from checkout: the publish dialog they were on the way to */
  useLibraryResume({
    canvasId,
    canEdit,
    status: shared.status,
    reload: shared.reload,
    onPublish: (only) => setPublishing(only ? { only } : {}),
  })
  const [query, setQuery] = useState('')
  /* importing: the panel lists the other canvases, and one picked opens its components */
  const [browsing, setBrowsing] = useState(false)
  const [libraries, setLibraries] = useState<ComponentLibrary[] | null>(null)
  const [picking, setPicking] = useState<ComponentLibrary | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<WireComponentDef | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  /* Rename picked from the menu opens the field once the menu has closed, in
     place of the focus it would hand back to its trigger, which would blur the
     new field at once */
  const renameFromMenu = useRef(false)

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return activeComponents(components)
      .filter((def) => !wanted || `${def.name} ${def.description}`.toLowerCase().includes(wanted))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [components, query])

  if (!canvasId) return null
  const status = shared.status
  const updates = new Set(status?.updates.map((update) => update.id))
  /* publish this component: the dialog where the canvas may have a library, else the way to one */
  const share = (def?: WireComponentDef) => {
    if (!status) return
    if (status.entitled) return setPublishing(def ? { only: def.id } : {})
    setWall({
      ...(status.blocked === 'plan_required' ? { workspaceId: status.workspaceId } : {}),
      reason: def ? t('components.libraryWallReasonOne', { name: def.name }) : t('components.libraryWallReason'),
      ...(def ? { only: def.id } : {}),
    })
  }
  const browse = () => {
    setBrowsing(true)
    setLibraries(null)
    api
      .componentLibraries(canvasId)
      .then((all) => setLibraries(all.filter((library) => !library.library)))
      .catch((error: unknown) => {
        console.error(error)
        setLibraries([])
      })
  }

  if (browsing)
    return (
      <>
        <ImportCanvasList sources={libraries} onBack={() => setBrowsing(false)} onPick={setPicking} />
        {picking && (
          <ImportComponentsModal
            canvasId={canvasId}
            source={picking}
            onBack={() => setPicking(null)}
            onDone={() => {
              setPicking(null)
              setBrowsing(false)
            }}
          />
        )}
      </>
    )

  return (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pt-2 pb-3"
        data-slot="components-panel"
      >
        <LibraryNotices canvasId={canvasId} canEdit={canEdit} status={status} onPublish={() => share()} />
        {canEdit && (
          <div className="flex flex-col border-b border-line-soft pb-2.5">
            <Button size="sm" onClick={browse}>
              {t('components.importFromCanvas')}
            </Button>
          </div>
        )}
        {shown.length === 0 && (
          <p className="px-0.5 text-caption text-ink-soft">
            {components?.length ? t('components.noMatch') : t('components.empty')}
          </p>
        )}
        {shown.map((def) => (
          <article key={def.id} className="flex flex-col gap-1.5" data-component-card={def.name}>
            {/* the card is picked up and dropped onto the canvas; the menu holds the rest */}
            <div
              draggable={canEdit && renaming !== def.id}
              aria-label={canEdit ? t('components.dragHint', { name: def.name }) : def.name}
              className={cn('flex w-full flex-col gap-1.5 text-left', canEdit && 'cursor-grab active:cursor-grabbing')}
              onDragStart={(event) => {
                event.dataTransfer.setData(COMPONENT_DRAG_TYPE, def.id)
                event.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <ComponentThumb
                title={t('components.previewTitle', { name: def.name })}
                sheetKey={`${def.id}:${def.rev}:${tokenStamp}`}
                load={() => api.componentPreview(canvasId, def.id)}
              />
              <span className="flex min-w-0 items-center gap-1.5 text-body text-ink">
                {def.source?.library ? (
                  <BookOpenIcon
                    size="rail"
                    className="flex-none text-brand"
                    aria-label={t('components.libraryLinked')}
                  />
                ) : (
                  <ComponentIcon size="rail" className="flex-none text-brand" />
                )}
                {renaming === def.id ? (
                  <ComponentNameInput def={def} onDone={() => setRenaming(null)} />
                ) : (
                  <span
                    className="truncate"
                    onDoubleClick={canEdit && !def.source?.library ? () => setRenaming(def.id) : undefined}
                  >
                    {def.name}
                  </span>
                )}
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
                  <DropdownMenuContent
                    align="end"
                    width="md"
                    onCloseAutoFocus={(event) => {
                      if (!renameFromMenu.current) return
                      renameFromMenu.current = false
                      event.preventDefault()
                      setRenaming(def.id)
                    }}
                  >
                    {canEdit && (
                      <DropdownMenuItem onSelect={() => void placeComponent(def)}>
                        {t('components.insertInstance')}
                      </DropdownMenuItem>
                    )}
                    {canEdit && !def.source?.library && (
                      <DropdownMenuItem
                        onSelect={() => {
                          renameFromMenu.current = true
                        }}
                      >
                        {t('components.rename')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => goToMain(def)}>
                      {def.source?.library ? t('components.libraryOpen') : t('components.goToMain')}
                    </DropdownMenuItem>
                    {canEdit &&
                      !def.source &&
                      def.rev > 0 &&
                      status?.canPublish &&
                      (status.entitled || status.billing) && (
                        <DropdownMenuItem onSelect={() => share(def)}>
                          {t('components.libraryPublishOne')}
                        </DropdownMenuItem>
                      )}
                    {canEdit && def.source && (!def.source.library || updates.has(def.id)) && (
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
        <LibrarySection
          canvasId={canvasId}
          canEdit={canEdit}
          query={query}
          status={status}
          libraries={shared.libraries}
          onPublish={() => share()}
          onWall={(next) => setWall({ ...next, reason: t('components.libraryWallReason') })}
        />
        {publishing && status && (
          <PublishLibraryDialog
            canvasId={canvasId}
            status={status}
            only={publishing.only}
            onClose={() => setPublishing(null)}
            onDone={() => {
              setPublishing(null)
              shared.reload()
            }}
          />
        )}
        {wall && (
          <LibraryUpgradeFlow
            canvas={{ id: canvasId, name: canvasName ?? '' }}
            wall={wall}
            reason={wall.reason}
            only={wall.only}
            onClose={() => setWall(null)}
            onDone={() => {
              setWall(null)
              shared.reload()
            }}
          />
        )}
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
      </div>
      <PanelSearch value={query} placeholder={t('components.search')} onChange={setQuery} />
    </>
  )
}
