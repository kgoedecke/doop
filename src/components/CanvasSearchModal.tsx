import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { CanvasMeta } from '../../shared/types'
import { cn } from '@/lib/utils'
import { useT } from '../lib/i18n'
import { timeAgo } from '../lib/time'
import { FrameThumb } from './FramePreview'
import { Modal } from './ui/modal'
import { Pressable } from './ui/pressable'
import { SearchField } from './ui/search-field'

/**
 * The rail's search: a palette over the page with one field and the
 * matching canvases under it, each with its preview. Arrow keys move the
 * highlight, Enter opens, Escape closes — the keyboard path ⌘K people expect.
 */

const MAX_RESULTS = 8

export function CanvasSearchModal({
  canvases,
  onOpen,
  onClose,
}: {
  canvases: CanvasMeta[]
  onOpen: (canvas: CanvasMeta) => void
  onClose: () => void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return canvases.slice(0, MAX_RESULTS)
    return canvases.filter((c) => c.name.toLowerCase().includes(q)).slice(0, MAX_RESULTS)
  }, [canvases, query])

  /* the highlight follows the list: a shorter result set cannot leave it past the end */
  const active = Math.min(cursor, Math.max(results.length - 1, 0))

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const hit = results[active]
      if (hit) onOpen(hit)
    }
  }

  return (
    <Modal size="lg" onClose={onClose} className="p-0 sm:p-0" aria-label={t('rail.searchCanvases')}>
      <SearchField
        ref={inputRef}
        variant="bar"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setCursor(0)
        }}
        onKeyDown={onKeyDown}
        placeholder={t('rail.searchCanvases')}
        aria-label={t('rail.searchCanvases')}
        inputClassName="text-copy md:text-copy"
      />
      <div className="max-h-[60vh] overflow-y-auto p-2" role="listbox" aria-label={t('rail.results')}>
        {results.length === 0 ? (
          <p className="px-3 py-6 text-center text-body text-ink-faint">{t('rail.noMatch', { query: query.trim() })}</p>
        ) : (
          results.map((c, i) => (
            <Pressable
              key={c.id}
              role="option"
              aria-selected={i === active}
              focus="none"
              onMouseEnter={() => setCursor(i)}
              onClick={() => onOpen(c)}
              className={cn(
                'flex items-center gap-3 rounded-pill px-2.5 py-2 transition-colors',
                i === active ? 'bg-paper-deep' : 'hover:bg-paper',
              )}
            >
              <FrameThumb frameId={c.previewFrameId} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-ink">{c.name}</span>
                <span className="mt-px block text-caption text-ink-faint">
                  {t('rail.frameCount', { count: c.frameCount })} · {t('rail.edited', { time: timeAgo(c.updatedAt) })}
                  {c.shared ? ` · ${t('rail.sharedWithYou')}` : ''}
                </span>
              </span>
            </Pressable>
          ))
        )}
      </div>
    </Modal>
  )
}
