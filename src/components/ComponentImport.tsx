import { useMemo, useState } from 'react'
import { api, type ComponentLibrary } from '../lib/api'
import { useT } from '../lib/i18n'
import { useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { ComponentThumb } from './ComponentThumb'
import { FramePreview, FrameThumb } from './FramePreview'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { ChevronLeftIcon, ComponentIcon } from './ui/icons'
import { Modal, ModalActions, ModalSpacer, ModalTitle } from './ui/modal'
import { Pressable } from './ui/pressable'
import { SearchField } from './ui/search-field'

type Source = ComponentLibrary
type Entry = Source['components'][number]

/** "Edited 5h ago", or "Shared · edited 5h ago" for a canvas someone else owns. */
function useEditedLine() {
  const t = useT()
  return (source: Source) => {
    if (!source.updatedAt) return ''
    const time = timeAgo(source.updatedAt)
    return source.shared ? t('components.importSharedEdited', { time }) : t('components.importEdited', { time })
  }
}

/**
 * The Components panel while importing: every canvas this person can open, one
 * per row with its preview, as Home lists them. "‹ Components" goes back to the
 * overview; a canvas with components opens the picker for it.
 */
export function ImportCanvasList({
  sources,
  onBack,
  onPick,
}: {
  /** null while the list loads */
  sources: Source[] | null
  onBack: () => void
  onPick: (source: Source) => void
}) {
  const t = useT()
  const edited = useEditedLine()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return (sources ?? []).filter((source) => !wanted || source.name.toLowerCase().includes(wanted))
  }, [sources, query])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="import-canvas-list">
      <div className="flex flex-none flex-col gap-2 px-2.5 pt-2.5 pb-2">
        <Button variant="bare" size="sm" className="self-start bg-paper-deep pl-1 text-ink" onClick={onBack}>
          <ChevronLeftIcon size="rail" aria-hidden />
          {t('components.importBack')}
        </Button>
        <SearchField
          autoFocus
          value={query}
          placeholder={t('components.importSearchCanvases')}
          aria-label={t('components.importSearchCanvases')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-2.5 pb-3">
        {sources?.length === 0 && <p className="px-0.5 text-caption text-ink-soft">{t('components.noLibraries')}</p>}
        {sources && sources.length > 0 && shown.length === 0 && (
          <p className="px-0.5 text-caption text-ink-soft">{t('components.importNoCanvasMatch')}</p>
        )}
        {shown.map((source) => {
          const count = source.components.length
          return (
            <Pressable
              key={source.id}
              disabled={count === 0}
              aria-label={t('components.importCanvasAria', { name: source.name, count })}
              className={cn(
                'overflow-hidden rounded-card bg-sub shadow-ring transition-shadow hover:shadow-ring-hover',
                count === 0 && 'cursor-default opacity-45 hover:shadow-ring',
              )}
              data-import-canvas={source.name}
              onClick={() => onPick(source)}
            >
              <span className="relative block h-28 overflow-hidden bg-paper-deep">
                <FramePreview frameId={source.previewFrameId} className="text-caption" />
                {count > 0 && (
                  <span className="absolute right-1.5 bottom-1.5 flex items-center gap-1 rounded-tag bg-black/70 px-1.5 py-0.5 font-mono text-micro text-white">
                    <ComponentIcon size={10} aria-hidden />
                    {count}
                  </span>
                )}
              </span>
              <span className="flex flex-col px-2.5 py-2">
                <span className="truncate text-body font-medium text-ink">{source.name}</span>
                <span className="truncate text-caption text-ink-faint">
                  {count === 0 ? t('components.importNoComponents') : edited(source)}
                </span>
              </span>
            </Pressable>
          )
        })}
      </div>
    </div>
  )
}

/**
 * One canvas's components to bring in: a preview each, ticked to pick, the ones
 * already here greyed. Importing keeps them linked to that canvas. Closing goes
 * back to the canvas list, not out of the import.
 */
export function ImportComponentsModal({
  canvasId,
  source,
  onBack,
  onDone,
}: {
  canvasId: string
  source: Source
  onBack: () => void
  onDone: () => void
}) {
  const t = useT()
  const components = useStore((s) => s.canvas?.components)
  /* an import keeps the component's id, so one with that id here came from there already */
  const here = useMemo(
    () => new Set((components ?? []).filter((def) => def.status !== 'deleted').map((def) => def.id)),
    [components],
  )
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const count = source.components.length
  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return source.components.filter(
      (entry) => !wanted || `${entry.name} ${entry.description ?? ''}`.toLowerCase().includes(wanted),
    )
  }, [source, query])
  const available = shown.filter((entry) => !here.has(entry.id))
  /* what Import brings: the ticked ones not here yet. One that arrived in an earlier,
     partly failed run stays ticked in `picked` but is no longer counted or sent */
  const chosen = source.components.filter((entry) => picked.has(entry.id) && !here.has(entry.id))

  const toggle = (entry: Entry) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(entry.id)) next.delete(entry.id)
      else next.add(entry.id)
      return next
    })

  async function importPicked() {
    if (!chosen.length) return
    setBusy(true)
    const notice = useStore.getState().pushNotice
    let done = 0
    try {
      /* one at a time: an import can bring the components this one is built from */
      for (const entry of chosen) {
        await api.importComponent(canvasId, source.id, entry.id)
        done++
      }
      notice(
        done === 1
          ? t('components.imported', { name: chosen[0]!.name })
          : t('components.importedMany', { count: done }),
      )
      onDone()
    } catch (error) {
      notice(error instanceof Error ? error.message : t('components.importFailed'))
      setBusy(false)
    }
  }

  return (
    /* not dismissable mid-import: the run would carry on and its onDone close a later picker */
    <Modal
      size="xl"
      onClose={() => {
        if (!busy) onBack()
      }}
      showClose={!busy}
      data-slot="import-components"
    >
      <div className="flex items-center gap-3 pr-8">
        <FrameThumb frameId={source.previewFrameId} empty={null} />
        <ModalTitle className="min-w-0 flex-1 truncate pr-0">{source.name}</ModalTitle>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <SearchField
          className="flex-1"
          value={query}
          placeholder={t('components.importSearchComponents', { count })}
          aria-label={t('components.importSearchComponents', { count })}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          variant="bare"
          size="sm"
          disabled={!available.length}
          onClick={() => setPicked(new Set([...picked, ...available.map((entry) => entry.id)]))}
        >
          {t('components.importSelectAll')}
        </Button>
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 md:grid-cols-3">
        {shown.map((entry) => {
          const already = here.has(entry.id)
          const on = picked.has(entry.id) && !already
          return (
            <li key={entry.id} data-import-component={entry.name}>
              <label className={cn('flex flex-col gap-1.5', already ? 'cursor-default' : 'cursor-pointer')}>
                <span
                  className={cn(
                    'relative block rounded-row',
                    on && 'ring-2 ring-brand ring-offset-0',
                    already && 'opacity-45',
                  )}
                >
                  <ComponentThumb
                    title={t('components.previewTitle', { name: entry.name })}
                    sheetKey={`${source.id}:${entry.id}:${entry.signature}`}
                    load={() => api.componentPreview(source.id, entry.id)}
                    height={176}
                  />
                  {!already && (
                    <span className="absolute top-1.5 left-1.5 flex">
                      <Checkbox
                        checked={on}
                        onChange={() => toggle(entry)}
                        aria-label={entry.name}
                        boxClassName="text-white peer-checked:border-brand peer-checked:bg-brand"
                      />
                    </span>
                  )}
                </span>
                <span className={cn('truncate text-body', already ? 'text-ink-faint' : 'text-ink')}>{entry.name}</span>
                {already && (
                  <span className="-mt-1 text-caption text-ink-faint">{t('components.importAlreadyHere')}</span>
                )}
              </label>
            </li>
          )
        })}
      </ul>
      <ModalActions className="items-center border-t border-line-soft pt-4">
        {chosen.length > 0 && (
          <span className="text-body text-ink-soft">{t('components.importSelected', { count: chosen.length })}</span>
        )}
        <ModalSpacer />
        <Button onClick={onBack} disabled={busy}>
          {t('components.importBackToCanvases')}
        </Button>
        <Button variant="primary" disabled={!chosen.length || busy} onClick={() => void importPicked()}>
          {busy
            ? t('components.importing')
            : chosen.length
              ? t('components.importAction', { count: chosen.length })
              : t('components.importNone')}
        </Button>
      </ModalActions>
    </Modal>
  )
}
