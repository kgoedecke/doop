import { useEffect, useMemo, useState } from 'react'
import type { StorybookComponentResult, StorybookSourceView } from '../../../shared/storybookSource'
import { FIDELITY_WARNING, MAX_STORYBOOK_COMPONENTS } from '../../../shared/storybookSource'
import type { ImportSectionProps } from '../index'
import { ApiError } from '../../lib/api'
import { posthog } from '../../lib/posthog'
import { storybookApi, type StorybookDiscovery, type StorybookJobView } from './api'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Checkbox } from '../../components/ui/checkbox'
import { CodeBlock } from '../../components/ui/code-block'
import { Disclosure } from '../../components/ui/collapsible'
import { Field } from '../../components/ui/field'
import { Input } from '../../components/ui/input'
import { ModalActions, ModalEyebrow, ModalLede, ModalTitle } from '../../components/ui/modal'
import { Note } from '../../components/ui/note'
import { Progress } from '../../components/ui/progress'
import { SearchField } from '../../components/ui/search-field'
import { SelectionBar, SelectionBarAction } from '../../components/ui/selection-bar'
import { ImportStepFooter, ImportStepHeader } from '../../components/ImportSources'
import { AppIcon } from '@/components/ui/brand-mark'
import { cn } from '@/lib/utils'

/* Storybook as one of the import modal's sources (spec: .context/specs/storybook-import.md):
   a published Storybook's URL, the components to bring over, then the run and how each came
   across. What the canvas already imports from is listed with Sync now. A Storybook only the
   developer's machine reaches goes through the CLI, shown here too. */

const errorOf = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? String(caught.body.error ?? fallback) : fallback

const ago = (at: number | null) => {
  if (!at) return 'never synced'
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return 'synced just now'
  if (minutes < 60) return `synced ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `synced ${hours} h ago` : `synced ${Math.round(hours / 24)} days ago`
}

function cliCommand(canvasId: string) {
  const origin = typeof location === 'undefined' ? 'https://doop.design' : location.origin
  return [
    `curl -fsSL ${origin}/cli/doop-storybook.mjs -o doop-storybook.mjs`,
    `DOOP_KEY=<agent key> node doop-storybook.mjs push http://localhost:6006 \\`,
    `  --canvas ${canvasId} --server ${origin}`,
  ].join('\n')
}

/** How one component came across: what happened, how alike it draws, and what to know. */
function ResultRow({ result }: { result: StorybookComponentResult }) {
  const tone =
    result.outcome === 'failed'
      ? 'accent'
      : result.outcome === 'skipped'
        ? 'banned'
        : result.outcome === 'unchanged'
          ? 'outline'
          : 'success'
  const lowFidelity = result.fidelity !== undefined && result.fidelity < FIDELITY_WARNING
  return (
    <div className="border-b border-line bg-surface px-3 py-[9px] last:border-b-0">
      <div className="flex items-center gap-2.5">
        <b className="min-w-0 flex-1 truncate text-body font-medium text-ink">{result.name}</b>
        {result.fidelity !== undefined && (
          <span className={cn('font-mono text-micro', lowFidelity ? 'text-warning-ink' : 'text-ink-faint')}>
            {Math.round(result.fidelity * 100)}% match
          </span>
        )}
        <Badge tone={tone}>{result.outcome}</Badge>
      </div>
      {result.notes.length > 0 && (
        <Disclosure
          className="mt-1"
          triggerClassName="text-caption text-ink-faint"
          label={`${result.notes.length} ${result.notes.length === 1 ? 'note' : 'notes'}`}
        >
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
            {result.notes.map((note) => (
              <li key={note} className="text-caption text-ink-soft">
                {note}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  )
}

/** The run, live while it goes and what came of it after; it carries on if the modal closes. */
function StorybookRun({
  canvasId,
  initial,
  onBack,
  onDone,
}: {
  canvasId: string
  initial: StorybookJobView
  onBack: () => void
  onDone: () => void
}) {
  const [job, setJob] = useState(initial)
  const [retryDelay, setRetryDelay] = useState(1200)

  useEffect(() => {
    if (job.state !== 'running') return
    const timer = setTimeout(() => {
      storybookApi
        .job(canvasId, job.id)
        .then(({ job: next }) => {
          setRetryDelay(1200)
          setJob(next)
        })
        .catch((error: unknown) => {
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            ![408, 429].includes(error.status)
          )
            setJob((current) => ({
              ...current,
              state: 'failed',
              error: errorOf(error, 'The import status is unavailable'),
            }))
          else {
            setRetryDelay((delay) => Math.min(delay * 2, 15000))
            setJob((current) => ({ ...current }))
          }
        })
    }, retryDelay)
    return () => clearTimeout(timer)
  }, [canvasId, job, retryDelay])

  const results = job.result?.components ?? []

  return (
    <>
      <ModalTitle>
        {job.state === 'running' ? 'Importing components' : job.state === 'failed' ? 'Import failed' : 'Imported'}
      </ModalTitle>
      {job.state === 'running' && (
        <>
          <ModalLede>{job.progress.status}. You can close this: it carries on as the Storybook Import task.</ModalLede>
          <Progress className="mt-4" value={job.progress.done} max={Math.max(job.progress.total, 1)} />
        </>
      )}
      {job.state === 'failed' && (
        <Note tone="error" size="sm" className="mt-2.5 block">
          {job.error}
        </Note>
      )}
      {job.result && (
        <>
          <ModalLede>
            {job.summary}. The components are on the Components page; tokens and fonts are the canvas’s.
            {job.result.tokens.leftAlone.length > 0 &&
              ` ${job.result.tokens.leftAlone.length} tokens the canvas already had were left as they are.`}
          </ModalLede>
          <div className="mt-4 max-h-[min(360px,calc(100dvh-360px))] overflow-y-auto rounded-card border border-line">
            {results.map((result) => (
              <ResultRow key={result.title} result={result} />
            ))}
          </div>
          {job.result.fonts.notes.map((note) => (
            <Note key={note} className="mt-2 block">
              {note}
            </Note>
          ))}
        </>
      )}
      <ModalActions className="justify-between">
        <Button variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <Button variant="primary" onClick={onDone}>
          {job.state === 'running' ? 'Close' : 'Done'}
        </Button>
      </ModalActions>
    </>
  )
}

/** The components a Storybook offers, under review. */
function StorybookReview({
  canvasId,
  discovery,
  onBack,
  onStarted,
}: {
  canvasId: string
  discovery: StorybookDiscovery
  onBack: () => void
  onStarted: (job: StorybookJobView) => void
}) {
  const already = useMemo(() => new Set(discovery.source?.components.map((c) => c.title) ?? []), [discovery])
  const [selected, setSelected] = useState<Set<string>>(() =>
    already.size
      ? new Set(already)
      : new Set(discovery.components.length <= 24 ? discovery.components.map((c) => c.title) : []),
  )
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const overLimit = selected.size > MAX_STORYBOOK_COMPONENTS
  const shown = discovery.components.filter((c) =>
    `${c.title} ${c.codePath ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  )

  function toggle(title: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  async function start() {
    if (busy || !selected.size || overLimit) return
    setBusy(true)
    setError(null)
    try {
      const picks = discovery.components.filter((c) => selected.has(c.title)).map((c) => ({ title: c.title }))
      const { job } = await storybookApi.importComponents(canvasId, discovery.url, picks)
      posthog.capture('storybook_import_started', { component_count: picks.length, sync: already.size > 0 })
      onStarted(job)
    } catch (caught) {
      setError(errorOf(caught, 'the import could not start'))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row sm:gap-6">
        <ModalTitle>Choose components</ModalTitle>
        <Badge shape="pill">{new URL(discovery.url).host}</Badge>
      </div>
      <ModalLede>
        {discovery.components.length} {discovery.components.length === 1 ? 'component' : 'components'} found. Each lands
        as a Doop component with its controls as variants; up to {MAX_STORYBOOK_COMPONENTS} per import.
      </ModalLede>
      <SearchField
        className="mt-4"
        variant="ring"
        placeholder="Filter components"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <SelectionBar
        className="mt-3"
        count={selected.size}
        total={discovery.components.length}
        tone={overLimit ? 'error' : 'default'}
        note={overLimit && ` — ${MAX_STORYBOOK_COMPONENTS} at most`}
        actions={
          <>
            <SelectionBarAction
              disabled={busy}
              onClick={() => setSelected((current) => new Set([...current, ...shown.map((c) => c.title)]))}
            >
              Select shown
            </SelectionBarAction>
            <SelectionBarAction disabled={busy} onClick={() => setSelected(new Set())}>
              Clear
            </SelectionBarAction>
          </>
        }
      />
      <div
        className={cn(
          'max-h-[calc(100dvh-430px)] overflow-y-auto rounded-card border border-line bg-paper transition-opacity sm:max-h-[min(320px,calc(100vh-430px))]',
          busy && 'opacity-[0.58]',
        )}
        role="group"
        aria-label="Components to import"
      >
        {shown.map((component) => (
          <label
            className="relative grid min-h-[50px] cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line bg-surface px-3 py-[9px] last:border-b-0 hover:bg-paper"
            key={component.title}
          >
            <Checkbox
              checked={selected.has(component.title)}
              disabled={busy}
              onChange={() => toggle(component.title)}
            />
            <span className="min-w-0">
              <b className="block truncate text-body font-medium text-ink">{component.name}</b>
              <span className="block truncate text-caption text-ink-faint">
                {component.title}
                {component.codePath ? ` · ${component.codePath}` : ''}
              </span>
            </span>
            <span className="flex items-center gap-2">
              {already.has(component.title) && <Badge tone="success">imported</Badge>}
              <span className="font-mono text-micro text-ink-faint">
                {component.stories} {component.stories === 1 ? 'story' : 'stories'}
              </span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <Note tone="error" size="sm" className="mt-2.5 block">
          {error}
        </Note>
      )}
      <ModalActions className="justify-between">
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          ← Back
        </Button>
        <Button variant="primary" disabled={busy || !selected.size || overLimit} onClick={start}>
          {busy
            ? 'Starting…'
            : `${already.size ? 'Import and sync' : 'Import'} ${selected.size} ${selected.size === 1 ? 'component' : 'components'}`}
        </Button>
      </ModalActions>
    </>
  )
}

/** A Storybook this canvas imports from: what it brought, when, and Sync now. */
function SourceRow({
  source,
  busy,
  onSync,
}: {
  source: StorybookSourceView
  busy: boolean
  onSync: (source: StorybookSourceView) => void
}) {
  const failed = source.lastResult?.components.filter((c) => c.outcome === 'failed').length ?? 0
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface px-3 py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1">
        <b className="block truncate font-mono text-label font-medium text-ink">{source.url}</b>
        <span className="block text-caption text-ink-faint">
          {source.components.length} {source.components.length === 1 ? 'component' : 'components'} ·{' '}
          {ago(source.syncedAt)}
          {failed ? ` · ${failed} failed last time` : ''}
        </span>
      </span>
      <Button size="sm" disabled={busy} onClick={() => onSync(source)}>
        Sync now
      </Button>
    </div>
  )
}

export function StorybookImportSection({ canvasId, setReview, onClose, onBack }: ImportSectionProps) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sources, setSources] = useState<StorybookSourceView[]>([])

  useEffect(() => {
    let live = true
    storybookApi
      .sources(canvasId)
      .then(({ sources: found }) => live && setSources(found))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [canvasId])

  const showRun = (job: StorybookJobView) =>
    setReview(<StorybookRun canvasId={canvasId} initial={job} onBack={() => setReview(null)} onDone={onClose} />)

  async function discover() {
    if (busy || !url.trim()) return
    setBusy(true)
    setError(null)
    try {
      const discovery = await storybookApi.discover(canvasId, url.trim())
      posthog.capture('storybook_components_found', { component_count: discovery.components.length })
      setReview(
        <StorybookReview
          canvasId={canvasId}
          discovery={discovery}
          onBack={() => setReview(null)}
          onStarted={showRun}
        />,
      )
    } catch (caught) {
      setError(errorOf(caught, 'could not read that Storybook'))
    } finally {
      setBusy(false)
    }
  }

  async function sync(source: StorybookSourceView) {
    setBusy(true)
    setError(null)
    try {
      const { job } = await storybookApi.sync(canvasId, source.id)
      posthog.capture('storybook_sync_started', { component_count: source.components.length })
      showRun(job)
    } catch (caught) {
      setError(errorOf(caught, 'the sync could not start'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ImportStepHeader icon={<AppIcon brand="storybook" size={40} />} title="Import from Storybook" />
      <ModalLede>
        Paste the address your Storybook is published at. Its components land as Doop components with their controls as
        variants, linked to their source files, and its theme becomes the canvas’s tokens. Import again to sync.
      </ModalLede>
      <Field className="mt-[22px]" label="Storybook URL" labelVariant="form" htmlFor="storybook-url">
        <Input
          id="storybook-url"
          variant="well"
          inputSize="lg"
          className="font-mono"
          autoFocus
          placeholder="https://storybook.example.com"
          value={url}
          disabled={busy}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void discover()}
        />
      </Field>
      {error && (
        <Note tone="error" size="sm" className="mt-2.5 block">
          {error}
        </Note>
      )}
      {sources.length > 0 && (
        <div className="mt-5">
          <ModalEyebrow>This canvas imports from</ModalEyebrow>
          <div className="mt-2 overflow-hidden rounded-card border border-line">
            {sources.map((source) => (
              <SourceRow key={source.id} source={source} busy={busy} onSync={sync} />
            ))}
          </div>
        </div>
      )}
      <Disclosure
        className="mt-4"
        triggerClassName="text-label font-medium text-ink-soft"
        label="Storybook on localhost or behind a VPN"
      >
        <Note size="sm" className="mt-2 block">
          Run the CLI where the Storybook runs, with an agent key from Settings → Agent keys. It renders the stories on
          your machine (with Playwright or Puppeteer from your project) and sends them here.
        </Note>
        <CodeBlock className="mt-2" text={cliCommand(canvasId)} />
      </Disclosure>
      <ImportStepFooter
        note="Variants are CSS: a control that changes markup keeps its default’s. Each component shows how closely it matches its story."
        onBack={onBack}
        backDisabled={busy}
      >
        <Button variant="primary" disabled={busy || !url.trim()} onClick={discover}>
          {busy ? 'Reading Storybook…' : 'Find components'}
        </Button>
      </ImportStepFooter>
    </>
  )
}
