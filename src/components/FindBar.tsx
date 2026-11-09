import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Frame } from '../../shared/types'
import { readingOrder } from '../../shared/frameOrder'
import { useT } from '../lib/i18n'
import { usePageCanvas } from '../lib/pages'
import { canEditOpenCanvas, useStore } from '../lib/store'
import { saveFrameHtml } from '../lib/layerEdits'
import { findInHtml, replaceInHtml, type TextMatch } from '../lib/actions/findText'
import { saveFramesHtml } from '../lib/actions/edits'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, XIcon } from './ui/icons'
import { Input } from './ui/input'
import { Pressable } from './ui/pressable'
import { SearchField } from './ui/search-field'

interface Hit {
  frame: Frame
  /** the match's place among its frame's matches, which a single replace names */
  n: number
  match: TextMatch
}

/**
 * ⌘F: find text across the page's frames, step through the matches (↩ /
 * ⇧↩), each one picked and flown to; ⌥⌘F opens it with a replace line,
 * replacing one match or all of them as one undo step.
 */
export function FindBar({
  mode,
  step,
  onClose,
}: {
  mode: 'find' | 'replace'
  /** a step asked for from outside (the Edit menu's Find next/previous) */
  step: { dir: 1 | -1; at: number } | null
  onClose: () => void
}) {
  const t = useT()
  const page = usePageCanvas()
  const canEdit = useStore((s) => canEditOpenCanvas(s))
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [showReplace, setShowReplace] = useState(mode === 'replace')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  /* ⌘F again (or ⌥⌘F) while open puts the keyboard back in the field */
  const [seenMode, setSeenMode] = useState(mode)
  if (seenMode !== mode) {
    setSeenMode(mode)
    if (mode === 'replace') setShowReplace(true)
  }
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [mode])

  const hits = useMemo<Hit[]>(() => {
    const frames = readingOrder((page?.frames ?? []).filter((f) => !f.hidden))
    return frames.flatMap((frame) =>
      findInHtml(frame.html, query, { matchCase }).map((match, n) => ({ frame, n, match })),
    )
  }, [page?.frames, query, matchCase])
  const active = hits.length ? Math.min(cursor, hits.length - 1) : -1

  function go(index: number) {
    const hit = hits[index]
    if (!hit) return
    setCursor(index)
    const s = useStore.getState()
    s.select(hit.frame.id)
    s.pickElement({ frameId: hit.frame.id, selector: hit.match.selector }, true)
    s.requestFlyTo(hit.frame.id)
  }

  function move(dir: 1 | -1) {
    if (!hits.length) return
    go(active === -1 ? 0 : (active + dir + hits.length) % hits.length)
  }

  /* the menus' Find next / previous */
  const [seenStep, setSeenStep] = useState(step)
  if (seenStep !== step) {
    setSeenStep(step)
    if (step) move(step.dir)
  }

  function replaceOne() {
    const hit = hits[active]
    if (!hit || hit.frame.locked || hit.match.locked) return
    const replaced = replaceInHtml(hit.frame.html, query, replacement, { matchCase, only: hit.n })
    if (replaced) saveFrameHtml(hit.frame, replaced.html)
  }

  function replaceAll() {
    const byFrame = new Map<string, Frame>()
    for (const hit of hits) if (!hit.frame.locked) byFrame.set(hit.frame.id, hit.frame)
    let count = 0
    const changes = [...byFrame.values()].flatMap((frame) => {
      const replaced = replaceInHtml(frame.html, query, replacement, { matchCase })
      if (!replaced) return []
      count += replaced.count
      return [{ frame, html: replaced.html }]
    })
    saveFramesHtml(changes)
    if (count) useStore.getState().pushNotice(t('actions.replaced', { count }))
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      move(e.shiftKey ? -1 : 1)
    }
  }

  const count = !query.trim()
    ? ''
    : hits.length
      ? t('actions.findCount', { current: active + 1, total: hits.length })
      : t('actions.findNone')

  return (
    <div
      role="search"
      aria-label={t('actions.findLabel')}
      className="absolute z-40 flex w-[min(360px,calc(100vw-24px))] flex-col gap-1.5 rounded-panel bg-surface p-2 shadow-float"
      style={{ top: 'calc(var(--chrome-top, 0px) + 10px)', right: 'calc(var(--chrome-right, 0px) + 10px)' }}
    >
      <div className="flex items-center gap-1">
        {canEdit && (
          <IconButton
            size="sm"
            aria-label={t('actions.showReplace')}
            on={showReplace}
            onClick={() => setShowReplace((v) => !v)}
          >
            <ChevronRightIcon
              width={14}
              height={14}
              aria-hidden
              className={cn('transition-transform', showReplace && 'rotate-90')}
            />
          </IconButton>
        )}
        <SearchField
          ref={inputRef}
          className="min-w-0 flex-1"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={onKeyDown}
          placeholder={t('actions.findPlaceholder')}
          aria-label={t('actions.findPlaceholder')}
          trailing={<span className="flex-none font-mono text-caption text-ink-faint">{count}</span>}
        />
        <IconButton
          size="sm"
          aria-label={t('actions.matchCase')}
          on={matchCase}
          onClick={() => setMatchCase((v) => !v)}
        >
          <span className="font-mono text-caption">Aa</span>
        </IconButton>
        <IconButton size="sm" aria-label={t('actions.previousMatch')} disabled={!hits.length} onClick={() => move(-1)}>
          <ArrowUpIcon width={14} height={14} aria-hidden />
        </IconButton>
        <IconButton size="sm" aria-label={t('actions.nextMatch')} disabled={!hits.length} onClick={() => move(1)}>
          <ArrowDownIcon width={14} height={14} aria-hidden />
        </IconButton>
        <IconButton size="sm" aria-label={t('actions.closeFind')} onClick={onClose}>
          <XIcon width={14} height={14} aria-hidden />
        </IconButton>
      </div>
      {canEdit && showReplace && (
        <div className="flex items-center gap-1 pl-7">
          <Input
            inputSize="sm"
            className="min-w-0 flex-1"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                replaceOne()
              }
            }}
            placeholder={t('actions.replacePlaceholder')}
            aria-label={t('actions.replacePlaceholder')}
          />
          <Button size="sm" disabled={active === -1 || !!hits[active]?.match.locked} onClick={replaceOne}>
            {t('actions.replaceOne')}
          </Button>
          <Button size="sm" disabled={!hits.length} onClick={replaceAll}>
            {t('actions.replaceAll')}
          </Button>
        </div>
      )}
      {hits.length > 0 && (
        <ul className="max-h-56 overflow-y-auto" aria-label={t('actions.findLabel')}>
          {hits.slice(0, 200).map((hit, i) => (
            <li key={`${hit.frame.id}:${i}`}>
              <Pressable
                focus="none"
                onClick={() => go(i)}
                className={cn(
                  'flex w-full flex-col items-start rounded-row px-2 py-1 text-left',
                  i === active ? 'bg-paper-deep' : 'hover:bg-sub',
                )}
              >
                <span className="text-caption text-ink-faint">{hit.frame.name}</span>
                <span className="w-full truncate text-body text-ink-soft">
                  {hit.match.before}
                  <mark className="rounded-tag bg-brand/20 text-ink">{hit.match.text}</mark>
                  {hit.match.after}
                </span>
              </Pressable>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
