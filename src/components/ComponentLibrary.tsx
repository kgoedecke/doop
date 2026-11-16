import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  RegistryDirectoryEntry,
  RegistryItemSummary,
  RegistryPreview,
  RegistrySelection,
} from '../../shared/shadcnRegistry'
import { api, ApiError } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { registryPicture } from '@/lib/registryThumbnails'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { CheckboxCard } from './ui/checkbox'
import { ChoiceList, ChoiceRow } from './ui/choice-list'
import { ArrowLeftIcon, BlocksIcon, ImageIcon } from './ui/icons'
import { Input } from './ui/input'
import { Modal, ModalLede, ModalTitle } from './ui/modal'
import { Skeleton } from './ui/skeleton'
import { SearchField } from './ui/search-field'
import { Switch } from './ui/switch'

const MAX_SELECTION = 20
/* the directory runs to hundreds of registries; search reaches the rest */
const DIRECTORY_ROWS = 40

const keyOf = (item: Pick<RegistryItemSummary, 'source' | 'name'>) => `${item.source}#${item.name}`
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function RegistryTile() {
  return (
    <span className="flex size-8 items-center justify-center rounded-row bg-paper-deep text-ink-soft">
      <BlocksIcon size="rail" aria-hidden />
    </span>
  )
}

/** The item as it will look, rendered on the server once the card scrolls into view. */
function ItemPicture({
  canvasId,
  item,
  matchTokens,
}: {
  canvasId: string
  item: RegistryItemSummary
  matchTokens: boolean
}) {
  const t = useT()
  const box = useRef<HTMLSpanElement>(null)
  const [seen, setSeen] = useState(false)
  const [picture, setPicture] = useState<{ key: string; url: string | null } | null>(null)
  const key = `${keyOf(item)}:${matchTokens}`
  useEffect(() => {
    const node = box.current
    if (!node || seen) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
      },
      { rootMargin: '120px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [seen])
  useEffect(() => {
    if (!seen) return
    let live = true
    registryPicture(canvasId, { source: item.source, name: item.name }, matchTokens).then(
      (url) => live && setPicture({ key, url }),
      () => live && setPicture({ key, url: null }),
    )
    return () => {
      live = false
    }
  }, [seen, canvasId, item.source, item.name, matchTokens, key])
  const current = picture?.key === key ? picture : null
  /* pictures are taken at 2x: shown at their own size, so a button reads as a
     button, and only scaled down when they would not fit */
  const [width, setWidth] = useState<number | undefined>(undefined)
  return (
    <span
      ref={box}
      /* white like the render's own page, so the picture's edges disappear */
      className="flex h-28 items-center justify-center overflow-hidden rounded-row bg-white shadow-ring"
    >
      {!current ? (
        <Skeleton className="size-full" />
      ) : current.url ? (
        <img
          src={current.url}
          alt=""
          style={{ width }}
          className="max-h-full max-w-full object-contain"
          draggable={false}
          onLoad={(event) => setWidth(event.currentTarget.naturalWidth / 2)}
        />
      ) : (
        <span className="flex flex-col items-center gap-1 text-caption text-ink-faint">
          <ImageIcon size="rail" aria-hidden />
          {t('canvas.libraryNoPreview')}
        </span>
      )}
    </span>
  )
}

/**
 * Bring shadcn components into the design: browse the public registry
 * directory, or paste whatever the person has (a docs link, an install
 * command, `@registry/item`, a registry JSON URL), pick items, and they land
 * in Components rendered as HTML, themed by the canvas's tokens.
 */
export function ComponentLibrary({
  canvasId,
  initialInput,
  onClose,
  onDone,
}: {
  canvasId: string
  /** looked up at once when given: a paste, or a registry picked elsewhere */
  initialInput: string
  onClose: () => void
  onDone: (frameIds: string[], message: string) => void
}) {
  const t = useT()
  const hasTokens = useStore((s) => !!s.canvas?.tokens?.length)
  const [input, setInput] = useState(initialInput)
  const [busy, setBusy] = useState<'finding' | 'adding' | null>(initialInput ? 'finding' : null)
  const [error, setError] = useState<string | null>(null)
  const [directory, setDirectory] = useState<RegistryDirectoryEntry[] | null>(null)
  const [registryQuery, setRegistryQuery] = useState('')
  const [preview, setPreview] = useState<RegistryPreview | null>(null)
  const [itemQuery, setItemQuery] = useState('')
  const [selected, setSelected] = useState<Map<string, RegistrySelection>>(new Map())
  const [matchTokens, setMatchTokens] = useState(true)

  const failure = useCallback(
    (caught: unknown, fallback: string) =>
      caught instanceof ApiError
        ? String(caught.body.error ?? fallback)
        : caught instanceof Error
          ? caught.message
          : fallback,
    [],
  )

  /* sets state only once the answer is in, so the mount effect may call it */
  const lookUp = useCallback(
    async (text: string) => {
      try {
        const found = await api.previewRegistry(canvasId, text)
        setPreview(found)
        setItemQuery('')
        setSelected(
          new Map(
            found.items.length === 1
              ? [[keyOf(found.items[0]!), { source: found.items[0]!.source, name: found.items[0]!.name }]]
              : undefined,
          ),
        )
      } catch (caught) {
        setError(failure(caught, t('canvas.libraryFailed')))
      } finally {
        setBusy(null)
      }
    },
    [canvasId, failure, t],
  )

  useEffect(() => {
    let live = true
    api
      .registryDirectory()
      .then((entries) => {
        if (live) setDirectory(entries)
      })
      .catch(() => {
        if (live) setDirectory([])
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    // A network lookup: lookUp sets state only once the server answers, never synchronously.
    // oxlint-disable-next-line react/set-state-in-effect
    if (initialInput) void lookUp(initialInput)
  }, [initialInput, lookUp])

  function find(text: string) {
    const clean = text.trim()
    if (!clean || busy) return
    setInput(clean)
    setError(null)
    setBusy('finding')
    void lookUp(clean)
  }

  async function add() {
    if (busy || !selected.size) return
    setBusy('adding')
    setError(null)
    try {
      const result = await api.importRegistry(canvasId, [...selected.values()], hasTokens && matchTokens)
      const store = useStore.getState()
      for (const component of result.components) store.setComponentLocal(component.id, component)
      store.setLayersTab('components')
      const added = t('canvas.libraryAdded', { count: result.components.length })
      const themed = result.themed.length ? ` · ${t('canvas.libraryThemed', { count: result.themed.length })}` : ''
      const failed = result.failures.length
        ? ` · ${t('canvas.libraryFailures', { count: result.failures.length })}`
        : ''
      onDone(
        result.components.flatMap((component) => (component.mainFrameId ? [component.mainFrameId] : [])),
        added + themed + failed,
      )
    } catch (caught) {
      setError(failure(caught, t('canvas.libraryFailed')))
      setBusy(null)
    }
  }

  const registries = useMemo(() => {
    const wanted = registryQuery.trim().toLowerCase()
    const all = directory ?? []
    const matching = wanted
      ? all.filter((entry) =>
          `${entry.namespace} ${entry.description} ${entry.homepage}`.toLowerCase().includes(wanted),
        )
      : all
    return matching.slice(0, DIRECTORY_ROWS)
  }, [directory, registryQuery])

  const items = useMemo(() => {
    const wanted = itemQuery.trim().toLowerCase()
    return (preview?.items ?? []).filter(
      (item) => !wanted || `${item.name} ${item.title} ${item.description}`.toLowerCase().includes(wanted),
    )
  }, [preview, itemQuery])

  const toggle = (item: RegistryItemSummary, checked: boolean) =>
    setSelected((current) => {
      const next = new Map(current)
      if (checked) next.set(keyOf(item), { source: item.source, name: item.name })
      else next.delete(keyOf(item))
      return next
    })

  return (
    <Modal onClose={onClose} size="xl" aria-describedby={undefined}>
      <div className="flex flex-col gap-1 pr-8">
        <ModalTitle>{preview ? (preview.namespace ?? preview.name) : t('canvas.libraryTitle')}</ModalTitle>
        <ModalLede>
          {preview
            ? preview.homepage
              ? hostOf(preview.homepage)
              : t('canvas.libraryItemCount', { count: preview.items.length })
            : t('canvas.libraryLede')}
        </ModalLede>
      </div>

      <div className="mt-4 flex gap-2">
        <Input
          aria-label={t('canvas.libraryInput')}
          autoFocus={!initialInput}
          variant="well"
          inputSize="lg"
          className="flex-1 font-mono"
          placeholder="npx shadcn add @magicui/marquee"
          value={input}
          disabled={!!busy}
          onChange={(event) => {
            setInput(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') find(input)
          }}
        />
        <Button size="lg" disabled={!!busy || !input.trim()} onClick={() => find(input)}>
          {busy === 'finding' ? t('canvas.libraryFinding') : t('canvas.libraryFind')}
        </Button>
      </div>

      {error && (
        <p className="mt-3 text-body text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className={cn('mt-4 transition-opacity', busy && 'opacity-60')}>
        {preview ? (
          <>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                disabled={!!busy}
                onClick={() => {
                  setPreview(null)
                  setSelected(new Map())
                  setError(null)
                }}
              >
                <ArrowLeftIcon size="rail" aria-hidden />
                {t('canvas.libraryAllRegistries')}
              </Button>
              {preview.items.length > 6 && (
                <SearchField
                  className="ml-auto w-60"
                  value={itemQuery}
                  onChange={(event) => setItemQuery(event.target.value)}
                  placeholder={t('canvas.librarySearchItems')}
                />
              )}
            </div>
            <div
              className="mt-3 grid max-h-[min(460px,calc(100dvh-340px))] grid-cols-1 items-start gap-2 overflow-y-auto sm:grid-cols-3"
              role="group"
              aria-label={t('canvas.libraryItems')}
            >
              {items.map((item) => (
                <CheckboxCard
                  key={keyOf(item)}
                  className="mt-0"
                  media={<ItemPicture canvasId={canvasId} item={item} matchTokens={hasTokens && matchTokens} />}
                  title={item.title}
                  description={item.description || item.type.replace(/^registry:/, '')}
                  checked={selected.has(keyOf(item))}
                  disabled={!!busy || (!selected.has(keyOf(item)) && selected.size >= MAX_SELECTION)}
                  onChange={(checked) => toggle(item, checked)}
                />
              ))}
              {!items.length && <p className="text-body text-ink-soft">{t('canvas.libraryNoMatch')}</p>}
            </div>
          </>
        ) : (
          <>
            <SearchField
              value={registryQuery}
              onChange={(event) => setRegistryQuery(event.target.value)}
              placeholder={
                directory?.length
                  ? t('canvas.librarySearchRegistries', { count: directory.length })
                  : t('canvas.libraryRegistries')
              }
            />
            <ChoiceList className="mt-3 max-h-[min(380px,calc(100dvh-360px))] overflow-y-auto">
              {directory === null && <p className="px-4 py-3 text-body text-ink-soft">{t('canvas.libraryLoading')}</p>}
              {registries.map((entry) => (
                <ChoiceRow
                  key={entry.namespace}
                  icon={<RegistryTile />}
                  disabled={!!busy}
                  title={
                    <>
                      {entry.namespace}
                      {entry.featured && (
                        <span className="ml-2 text-caption font-normal text-brand">{t('canvas.libraryFeatured')}</span>
                      )}
                    </>
                  }
                  description={entry.description || hostOf(entry.homepage)}
                  onClick={() => find(entry.namespace)}
                />
              ))}
              {directory !== null && !registries.length && (
                <p className="px-4 py-3 text-body text-ink-soft">{t('canvas.libraryNoMatch')}</p>
              )}
            </ChoiceList>
          </>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line-soft pt-4">
        {hasTokens ? (
          <label className="mr-auto flex min-w-0 cursor-pointer items-center gap-2.5">
            <Switch size="sm" checked={matchTokens} onCheckedChange={setMatchTokens} disabled={!!busy} />
            <span className="min-w-0">
              <span className="block text-body text-ink">{t('canvas.libraryMatchTokens')}</span>
              <span className="block text-caption text-ink-faint">{t('canvas.libraryMatchTokensHint')}</span>
            </span>
          </label>
        ) : (
          <span className="mr-auto min-w-0 text-label text-ink-faint">{t('canvas.libraryNote')}</span>
        )}
        {preview && (
          <Button variant="primary" disabled={!!busy || !selected.size} onClick={() => void add()}>
            {busy === 'adding' ? t('canvas.libraryAdding') : t('canvas.libraryAdd', { count: selected.size })}
          </Button>
        )}
      </div>
    </Modal>
  )
}
