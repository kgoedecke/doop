import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { connect, disconnect, sendWs } from '../lib/ws'
import {
  api,
  ApiError,
  type DiscoveredSite,
  type GithubConnectionInfo,
  type InstallationRepo,
  type RepoManifest,
  type RepoScreen,
  type SyncKeyInfo,
} from '../lib/api'
import { navigate } from '../App'
import { Logo } from '../components/Logo'
import { ensureTab } from '../lib/desktop'
import { Stage } from '../components/Stage'
import { Board } from '../components/Board'
import { Inspector } from '../components/Inspector'
import { ActivityPanel } from '../components/ActivityPanel'
import { ConnectModal } from '../components/ConnectModal'
import { LimitWall } from '../components/TeamAllowance'
import { PromptBar } from '../components/PromptBar'
import { WorkingNow } from '../components/WorkingNow'
import { Onboarding } from '../components/Onboarding'
import { ShareModal } from '../components/ShareModal'
import { BrainIcon } from '../components/BrainIcon'
import { getIdentity, setName } from '../lib/identity'
import { copyFrame, duplicateFrame, hasFrameClip, pasteFrameCentered, pasteImagesCentered } from '../lib/frameClipboard'
import { clearHistory, deleteFramesTracked, recordCreate, redo, undo } from '../lib/history'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { useIsMobile } from '../hooks/use-mobile'
import { cn } from '@/lib/utils'
import { Button } from '../components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../components/ui/sheet'
import { GithubIcon } from '../components/ui/icons'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Field } from '../components/ui/field'
import { Avatar } from '../components/ui/avatar'
import { Checkbox, CheckboxCard } from '../components/ui/checkbox'
import { Segmented, SegmentedItem } from '../components/ui/segmented'
import { Toast, ToastAction } from '../components/ui/toast'
import { Tooltip } from '../components/ui/tooltip'
import { Note } from '../components/ui/note'
import { Textarea } from '../components/ui/textarea'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from '../components/ui/modal'

const STARTER_HTML = `<!doctype html>
<html>
<head>
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, sans-serif;
    height: 100vh;
    display: grid;
    place-items: center;
    background: #fafafa;
    color: #999;
  }
</style>
</head>
<body>
  <p>Design me — edit the HTML, or ask an agent.</p>
</body>
</html>`

/* Small captions the import flow repeats under its fields. */
const importNoteCls = 'mt-2.5 text-[11.5px] leading-[1.4] text-ink-faint'
const errorNoteCls = 'mt-2.5 text-[13px] text-accent-ink'

export function CanvasPage({ canvasId }: { canvasId: string }) {
  const canvas = useStore((s) => s.canvas)
  const connected = useStore((s) => s.connected)
  const presences = useStore((s) => s.presences)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const isMobile = useIsMobile()
  const [showActivity, setShowActivity] = useState(() => !window.matchMedia('(max-width: 900px)').matches)
  const [view, setView] = useState<'canvas' | 'board'>('canvas')
  const [showConnect, setShowConnect] = useState(false)
  const [showShare, setShowShare] = useState(false)
  /* returning from a GitHub App install: the setup redirect appends a signed
     pass — pull it off the URL and open the import modal on the repo picker */
  const [ghInstallPass, setGhInstallPass] = useState<string | null>(() => {
    const pass = new URLSearchParams(location.search).get('ghInstall')
    if (pass) history.replaceState(null, '', location.pathname)
    return pass
  })
  /* a failed install round-trip also lands here, with the reason to show */
  const [ghInstallError] = useState<string | null>(() => {
    const err = new URLSearchParams(location.search).get('ghError')
    if (err) history.replaceState(null, '', location.pathname)
    return err
  })
  const [showImport, setShowImport] = useState(!!ghInstallPass || !!ghInstallError)
  const [showMobileActions, setShowMobileActions] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const updateReady = useStore((s) => s.updateReady)
  const limitWall = useStore((s) => s.limitWall)

  /* keep the desktop shell's tab label in step with the live canvas name.
     The store's canvas briefly lags a navigation (the previous page's data
     until this one's ws init lands), so only sync when it's really ours —
     otherwise closing a tab re-adds it from its own stale state. */
  useEffect(() => {
    if (canvas?.id === canvasId) ensureTab(canvas.id, canvas.name)
  }, [canvas, canvasId])

  useEffect(() => {
    connect(canvasId)
    return () => {
      disconnect()
      useStore.getState().setCanvas(null)
      useStore.getState().setPresences([])
      select(null)
      clearHistory()
    }
  }, [canvasId])

  /* broadcast which frame I'm focused on */
  useEffect(() => {
    sendWs({ type: 'editing', frameId: selectedId })
  }, [selectedId])

  /* frame keyboard shortcuts: delete, copy/paste/duplicate, undo/redo */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const sel = useStore.getState().selectedId
      const selectedIds = useStore.getState().selectedIds
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) {
        e.preventDefault()
        const frames = useStore.getState().canvas?.frames.filter((f) => selectedIds.includes(f.id)) ?? []
        deleteFramesTracked(frames)
      }
      if (e.key === 'Escape') select(null)
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const frame = useStore.getState().canvas?.frames.find((f) => f.id === sel)
        /* don't hijack ⌘C when the user is copying selected text */
        if (e.key === 'c' && frame && !window.getSelection()?.toString()) copyFrame(frame)
        if (e.key === 'd' && frame) {
          e.preventDefault()
          duplicateFrame(frame)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canvasId]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ⌘V lands here as a real paste event: clipboard images upload and drop in
     as frames; otherwise a copied frame (⌘C) pastes centered. Handled on
     'paste' rather than keydown so the browser hands us the clipboard bytes
     without a permission prompt. */
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (images.length) {
        e.preventDefault()
        pasteImagesCentered(canvasId, images).catch((err: Error) => {
          setToast(`Couldn’t paste image — ${err.message}`)
          window.setTimeout(() => setToast(null), 4000)
        })
      } else if (hasFrameClip()) {
        e.preventDefault()
        pasteFrameCentered(canvasId)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [canvasId])

  function showToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2000)
  }

  /* a pending Memory suggestion gets its own toast beside the side panel;
     clicking it jumps to the Memory tab, ✕ mutes it for this session */
  const pendingProposal = useStore((s) => s.proposals.find((p) => p.status === 'pending'))
  const panelTab = useStore((s) => s.panelTab)
  const [mutedProposal, setMutedProposal] = useState<string | null>(null)

  /* a decision landing in Memory is invisible work — surface it as its own
     memory toast in the same top-right stack. Only decisions captured after
     this page loaded count, so the ws-init batch stays silent. The summarizer
     re-broadcasts the decision with a generalized summary a moment later; the
     upsert re-fires this effect and the toast text swaps in place. */
  const latestDecision = useStore((s) => s.decisions[0])
  const [decisionToast, setDecisionToast] = useState<string | null>(null)
  const loadedAt = useRef(0)
  const decisionToastTimer = useRef<number | null>(null)
  useEffect(() => {
    if (!loadedAt.current) loadedAt.current = Date.now()
    if (latestDecision && latestDecision.at > loadedAt.current) {
      const line = latestDecision.summary ?? latestDecision.text
      setDecisionToast(line.length > 64 ? line.slice(0, 61) + '…' : line)
      if (decisionToastTimer.current) window.clearTimeout(decisionToastTimer.current)
      decisionToastTimer.current = window.setTimeout(() => setDecisionToast(null), 6000)
    }
  }, [latestDecision])

  async function addFrame() {
    const n = (canvas?.frames.length ?? 0) + 1
    const frame = await api.createFrame(canvasId, { name: `Frame ${n}`, html: STARTER_HTML })
    posthog.capture('frame_created')
    recordCreate(frame)
    select(frame.id)
  }

  const me = getIdentity()
  const others = useMemo(
    () => Object.values(presences).filter((p) => p.clientId !== me.clientId),
    [presences, me.clientId],
  )

  const selectedFrame = canvas?.frames.find((f) => f.id === selectedId) ?? null
  /* the panel only shows when a frame-name click (or deep link) opened it —
     selecting a frame by clicking its surface must not slide it in */
  const inspectorOpen = useStore((s) => s.inspectorOpen)
  /* a right-click that selected the frame keeps the Inspector out until the
     context menu closes — it would slide in right under the open menu */
  const deferPanel = useStore((s) => !!s.ctxMenu?.deferPanel)

  return (
    /* --app-inset is 0 normally; the impersonation shell raises it so this
       fixed layer starts below the banner instead of under it */
    <div className="fixed inset-x-0 bottom-0 top-[var(--app-inset,0px)] flex flex-col">
      <div className="z-40 flex h-[52px] flex-none items-center gap-3 border-b border-line bg-surface px-3 max-md:h-[112px] max-md:flex-wrap max-md:content-center max-md:gap-x-2 max-md:gap-y-1.5 max-md:px-2 max-md:py-2">
        <div className="flex min-w-0 items-center gap-1.5 max-md:basis-full">
          <Tooltip label="All canvases" side="bottom" align="start">
            <Button
              variant="bare"
              size="icon-sm"
              className="size-9 hover:bg-paper-deep"
              onClick={() => navigate('/')}
              aria-label="All canvases"
            >
              <Logo className="size-6" />
            </Button>
          </Tooltip>
          <CanvasName />
          <Badge className="max-md:hidden" title="Canvas id — agents use this with the MCP tools">
            {canvasId}
          </Badge>
          {!connected && (
            <Badge tone="accent" className="max-md:ml-auto">
              reconnecting…
            </Badge>
          )}
        </div>
        <Segmented
          className="max-md:order-2 max-md:flex-1"
          aria-label="View"
          value={view}
          onValueChange={(next) => setView(next as 'canvas' | 'board')}
        >
          <SegmentedItem value="canvas">Canvas</SegmentedItem>
          <SegmentedItem value="board">Board</SegmentedItem>
        </Segmented>
        <div className="ml-auto flex items-center gap-3 max-md:hidden">
          <div className="flex items-center" title={others.map((p) => p.name).join(', ') || 'Just you here'}>
            <Button
              variant="bare"
              className="p-0 hover:bg-transparent"
              title={`You are “${me.name}” — click to change your name`}
              onClick={() => setRenaming(true)}
            >
              <Avatar name={me.name} kind="user" stacked />
            </Button>
            {others.map((p) => (
              <Avatar
                key={p.clientId}
                name={p.name}
                color={p.color}
                kind={p.kind}
                status={p.status}
                owner={p.owner}
                stacked
              />
            ))}
          </div>
          <Button variant="ghost" onClick={() => setShowActivity((v) => !v)}>
            Activity
          </Button>
          <Button variant="ghost" onClick={() => setShowImport(true)} title="Import a live web page as a frame">
            ⤓ Import
          </Button>
          <Button onClick={() => setShowShare(true)}>Share</Button>
          <Button
            variant="primary"
            onClick={() => {
              posthog.capture('agent_connection_opened')
              setShowConnect(true)
            }}
          >
            ✦ Connect AI
          </Button>
        </div>
        <div className="order-3 hidden items-center gap-1.5 max-md:flex">
          <Button variant="ghost" className="h-10 bg-surface" onClick={() => setShowActivity(true)}>
            Activity
          </Button>
          <Button
            variant="primary"
            className="h-10"
            onClick={() => {
              posthog.capture('agent_connection_opened')
              setShowConnect(true)
            }}
          >
            ✦ AI
          </Button>
          <Tooltip label="Canvas actions" side="bottom" align="end">
            <Button
              variant="ghost"
              size="icon"
              className="size-10 bg-surface"
              aria-label="Canvas actions"
              onClick={() => setShowMobileActions(true)}
            >
              •••
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {view === 'board' ? (
          <Board canvasId={canvasId} />
        ) : (
          <>
            <Stage onAddFrame={addFrame} />
            <div
              className={cn(
                'pointer-events-none absolute top-3 right-3 z-30 flex flex-col items-end gap-2 transition-[right] duration-150 ease-[ease] [&>*]:pointer-events-auto max-md:top-[56px] max-md:right-2 max-md:left-2',
                /* clear of the 300px side panel at right: 12px */
                showActivity && 'right-[324px]',
              )}
            >
              {pendingProposal && mutedProposal !== pendingProposal.id && !(showActivity && panelTab === 'memory') && (
                <div className="flex items-center rounded-[10px] border border-brand bg-white shadow-card">
                  <Button
                    variant="bare"
                    className="py-[9px] pl-3.5 pr-1 text-[12.5px] font-bold text-accent-ink hover:bg-transparent hover:text-accent-ink"
                    onClick={() => {
                      useStore.getState().setPanelTab('memory')
                      setShowActivity(true)
                    }}
                  >
                    ✦ Memory suggestion — review
                  </Button>
                  <Button
                    variant="bare"
                    className="py-[9px] pl-1.5 pr-2.5 text-[11px] hover:bg-transparent"
                    title="Hide for now"
                    onClick={() => setMutedProposal(pendingProposal.id)}
                  >
                    ✕
                  </Button>
                </div>
              )}
              {decisionToast && (
                <Button
                  variant="ghost"
                  className="max-w-full items-center gap-2.5 whitespace-normal rounded-[12px] border-line bg-surface px-3.5 py-2.5 text-left shadow-pop transition-shadow hover:bg-surface hover:shadow-card sm:max-w-[320px] [&_svg]:text-accent-ink"
                  title="Open Memory"
                  onClick={() => {
                    useStore.getState().setPanelTab('memory')
                    setShowActivity(true)
                    setDecisionToast(null)
                  }}
                >
                  <BrainIcon size={17} />
                  <span>
                    <b className="block font-display text-[13px] font-semibold tracking-[-0.01em]">Saved to Memory</b>
                    <span className="mt-[1px] block text-[12px] leading-[1.4] text-ink-soft">{decisionToast}</span>
                  </span>
                </Button>
              )}
            </div>
            <WorkingNow />
            <PromptBar canvasId={canvasId} />
            <Onboarding />
            {!isMobile && selectedFrame && inspectorOpen && !deferPanel && <Inspector frame={selectedFrame} />}
            {!isMobile && showActivity && <ActivityPanel onClose={() => setShowActivity(false)} />}
          </>
        )}
      </div>

      {isMobile && (
        <>
          <Sheet open={showMobileActions} onOpenChange={setShowMobileActions}>
            <SheetContent
              side="bottom"
              className="gap-0 rounded-t-2xl border-line bg-surface p-0 pb-[env(safe-area-inset-bottom)] shadow-pop"
            >
              <div className="border-b border-line-soft px-5 py-4 pr-14">
                <SheetTitle className="font-display text-lg font-extrabold">Canvas actions</SheetTitle>
                <SheetDescription className="mt-1 text-xs text-ink-soft">
                  Import, share, or change your account settings.
                </SheetDescription>
              </div>
              <div className="grid gap-2 p-4">
                <Button
                  variant="ghost"
                  className="h-11 justify-start border-line bg-surface px-4"
                  onClick={() => {
                    setShowMobileActions(false)
                    setShowImport(true)
                  }}
                >
                  ⤓ Import website
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 justify-start border-line bg-surface px-4"
                  onClick={() => {
                    setShowMobileActions(false)
                    setShowShare(true)
                  }}
                >
                  Share canvas
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 justify-start px-4 text-ink-soft"
                  onClick={() => navigate('/settings')}
                >
                  Settings
                </Button>
              </div>
            </SheetContent>
          </Sheet>
          <Sheet
            open={!!selectedFrame && inspectorOpen && !deferPanel}
            onOpenChange={(open) => {
              if (!open) select(null)
            }}
          >
            <SheetContent
              side="bottom"
              showCloseButton={false}
              className="max-h-[calc(100svh-56px)] gap-0 rounded-t-2xl border-line bg-surface p-0 shadow-pop data-[side=bottom]:h-[min(78svh,680px)]"
            >
              <SheetTitle className="sr-only">Frame inspector</SheetTitle>
              {selectedFrame && <Inspector frame={selectedFrame} surface="inline" />}
            </SheetContent>
          </Sheet>
          <Sheet open={showActivity} onOpenChange={setShowActivity}>
            <SheetContent
              side="bottom"
              showCloseButton={false}
              className="max-h-[calc(100svh-56px)] gap-0 rounded-t-2xl border-line bg-surface p-0 shadow-pop data-[side=bottom]:h-[min(78svh,680px)]"
            >
              <SheetTitle className="sr-only">Canvas activity</SheetTitle>
              <ActivityPanel onClose={() => setShowActivity(false)} surface="inline" />
            </SheetContent>
          </Sheet>
        </>
      )}

      {renaming && <RenameSelfModal current={me.name} onClose={() => setRenaming(false)} />}
      {showConnect && <ConnectModal canvasId={canvasId} onClose={() => setShowConnect(false)} />}
      {showShare && canvas && (
        <ShareModal
          key={canvas.id}
          canvas={canvas}
          onChange={(patch) => {
            const current = useStore.getState().canvas
            if (current?.id === canvasId) useStore.getState().setCanvas({ ...current, ...patch })
          }}
          onClose={() => setShowShare(false)}
          onCopied={() => {
            setShowShare(false)
            showToast('Canvas link copied')
          }}
        />
      )}
      {limitWall && (
        <LimitWall
          canvasId={canvasId}
          onClose={() => useStore.getState().setLimitWall(false)}
          onOpenConnect={() => {
            useStore.getState().setLimitWall(false)
            posthog.capture('agent_connection_opened')
            setShowConnect(true)
          }}
        />
      )}
      {showImport && (
        <ImportModal
          canvasId={canvasId}
          installPass={ghInstallPass}
          installError={ghInstallError}
          onClose={() => {
            setShowImport(false)
            setGhInstallPass(null)
          }}
          onDone={(frameIds, failedCount) => {
            setShowImport(false)
            setView('canvas')
            select(frameIds[0] ?? null)
            const imported =
              frameIds.length === 0
                ? 'Doop is importing the design system — watch the canvas'
                : frameIds.length === 1
                  ? '1 item imported'
                  : `${frameIds.length} items imported`
            showToast(failedCount ? `${imported} · ${failedCount} failed` : imported)
          }}
        />
      )}
      {updateReady ? (
        <Toast>
          doop was updated
          <ToastAction onClick={() => location.reload()}>Reload</ToastAction>
        </Toast>
      ) : (
        toast && <Toast>{toast}</Toast>
      )}
    </div>
  )
}

function ImportModal({
  canvasId,
  installPass,
  installError,
  onClose,
  onDone,
}: {
  canvasId: string
  installPass: string | null
  installError: string | null
  onClose: () => void
  onDone: (frameIds: string[], failedCount: number) => void
}) {
  const [url, setUrl] = useState('')
  const [wholeSite, setWholeSite] = useState(false)
  const [discovery, setDiscovery] = useState<DiscoveredSite | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'discovering' | 'importing' | null>(null)
  const [error, setError] = useState<string | null>(null)
  /* a connected repo's screen manifest under review — the modal's third view */
  const [repoReview, setRepoReview] = useState<{ connection: GithubConnectionInfo; manifest: RepoManifest } | null>(
    null,
  )
  const [repoSelected, setRepoSelected] = useState<Set<string>>(new Set())
  const [extractSystem, setExtractSystem] = useState(true)
  const [showPages, setShowPages] = useState(false)

  function errorMessage(caught: unknown, fallback: string) {
    if (caught instanceof ApiError) return String(caught.body.error ?? fallback)
    return caught instanceof Error ? caught.message.replace(/^\d+\s*/, '') : fallback
  }

  function normalizedUrl() {
    const clean = url.trim()
    return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`
  }

  async function runSinglePage() {
    if (!url.trim() || busy) return
    setBusy('importing')
    setError(null)
    try {
      const frame = await api.importPage(canvasId, normalizedUrl())
      posthog.capture('page_imported')
      onDone([frame.id], 0)
    } catch (e) {
      setError(errorMessage(e, 'import failed'))
      setBusy(null)
    }
  }

  async function discover() {
    if (!url.trim() || busy) return
    setBusy('discovering')
    setError(null)
    try {
      const found = await api.discoverSitePages(canvasId, normalizedUrl())
      setDiscovery(found)
      setSelected(new Set(found.pages.map((page) => page.url)))
      posthog.capture('site_pages_discovered', { page_count: found.pages.length, truncated: found.truncated })
      setBusy(null)
    } catch (e) {
      setError(errorMessage(e, 'page discovery failed'))
      setBusy(null)
    }
  }

  async function importSelected() {
    if (!discovery || !selected.size || busy) return
    setBusy('importing')
    setError(null)
    const urls = discovery.pages.filter((page) => selected.has(page.url)).map((page) => page.url)
    try {
      const result = await api.importSitePages(canvasId, urls)
      if (!result.frames.length) {
        const reason = result.failures[0]?.error
        setError(reason ? `No pages could be imported — ${reason}` : 'No pages could be imported')
        setBusy(null)
        return
      }
      posthog.capture('website_imported', {
        requested_count: urls.length,
        imported_count: result.frames.length,
        failed_count: result.failures.length,
      })
      onDone(
        result.frames.map((frame) => frame.id),
        result.failures.length,
      )
    } catch (e) {
      setError(errorMessage(e, 'website import failed'))
      setBusy(null)
    }
  }

  function togglePage(pageUrl: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(pageUrl)) next.delete(pageUrl)
      else next.add(pageUrl)
      return next
    })
  }

  /* screens can share a route across kinds (a page and its committed dist
     HTML) — key rows by kind + route */
  const screenKey = (s: RepoScreen) => `${s.kind}|${s.route}`

  function openRepoReview(connection: GithubConnectionInfo, manifest: RepoManifest) {
    setRepoReview({ connection, manifest })
    /* the design system is the default import; components and pages are
       one click away, never silently pre-committed */
    setRepoSelected(new Set())
    setShowPages(false)
    setError(null)
  }

  function toggleScreen(key: string) {
    setRepoSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function importRepoScreens() {
    if (!repoReview || busy || (!repoSelected.size && !extractSystem)) return
    setBusy('importing')
    setError(null)
    const screens = repoReview.manifest.screens.filter((s) => repoSelected.has(screenKey(s)))
    try {
      const result = await api.importGithubScreens(canvasId, repoReview.connection.id, screens, extractSystem)
      if (!result.frames.length && screens.length) {
        const reason = result.failures[0]?.error
        setError(reason ? `No screens could be imported — ${reason}` : 'No screens could be imported')
        setBusy(null)
        return
      }
      posthog.capture('github_screens_imported', {
        requested_count: screens.length,
        imported_count: result.frames.length,
        failed_count: result.failures.length,
      })
      onDone(
        result.frames.map((frame) => frame.id),
        result.failures.length,
      )
    } catch (e) {
      setError(errorMessage(e, 'repository import failed'))
      setBusy(null)
    }
  }

  const selectedCount = selected.size
  const laneLabel: Record<RepoScreen['source'], string> = {
    static: 'from repo',
    placeholder: 'agent sketch',
  }
  const kindLabel = (s: RepoScreen) =>
    s.kind === 'component' ? 'component' : s.kind === 'story' ? 'story' : laneLabel[s.source]
  const KIND_ORDER: Record<RepoScreen['kind'], number> = { component: 0, story: 1, static: 2, page: 3 }
  const allScreens = repoReview?.manifest.screens ?? []
  const pageCount = allScreens.filter((s) => s.kind === 'page').length
  const visibleScreens = allScreens
    .filter((s) => showPages || s.kind !== 'page')
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])

  return (
    <Modal size="lg" onClose={() => !busy && onClose()}>
      <>
        {repoReview ? (
          <>
            <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row sm:gap-6">
              <div className="flex flex-col gap-[5px]">
                <ModalEyebrow>Review before import</ModalEyebrow>
                <ModalTitle>Import the design system</ModalTitle>
              </div>
              <Badge className="max-w-full overflow-hidden text-ellipsis rounded-full bg-paper px-[9px] py-[5px] text-[10.5px] sm:max-w-[240px]">
                {repoReview.connection.repo}@{repoReview.connection.branch}
              </Badge>
            </div>
            <ModalLede>
              {repoReview.manifest.framework ? `A ${repoReview.manifest.framework} app. ` : ''}Doop distills the repo's
              design system into a style guide pinned to this canvas — every agent follows it from then on. Components
              come along as sketched library cards; whole pages are optional.
            </ModalLede>
            <CheckboxCard
              checked={extractSystem}
              disabled={!!busy}
              onChange={setExtractSystem}
              title="Extract the design system into a style guide"
              description="Palette, type and spacing from the repo's theme — pinned to the canvas, followed by every agent."
            />
            <div className="mt-4 flex items-center justify-between px-[2px] pb-[9px]">
              <b className="text-[12px] text-ink-soft">
                {repoSelected.size} of {visibleScreens.length} selected
                {repoSelected.size > 12 && (
                  <span className="ml-2 font-normal text-ink-faint">
                    — Doop sketches 12 per import; the rest stay outlines
                  </span>
                )}
              </b>
              <span className="flex gap-3">
                <Button
                  variant="bare"
                  size="sm"
                  className="p-0 font-mono text-[10.5px] hover:bg-transparent hover:text-accent-ink"
                  disabled={!!busy}
                  onClick={() => setRepoSelected(new Set(visibleScreens.map(screenKey)))}
                >
                  Select all
                </Button>
                <Button
                  variant="bare"
                  size="sm"
                  className="p-0 font-mono text-[10.5px] hover:bg-transparent hover:text-accent-ink"
                  disabled={!!busy}
                  onClick={() => setRepoSelected(new Set())}
                >
                  Clear
                </Button>
              </span>
            </div>
            <div
              className={cn(
                'max-h-[calc(100dvh-390px)] overflow-y-auto rounded-[11px] border border-line bg-paper transition-opacity sm:max-h-[min(350px,calc(100vh-390px))]',
                busy && 'opacity-[0.58]',
              )}
              role="group"
              aria-label="Screens to import"
            >
              {visibleScreens.map((screen, index) => (
                <label
                  className="relative grid min-h-[58px] cursor-pointer grid-cols-[20px_24px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line bg-surface px-3 py-[9px] first:rounded-t-[10px] last:rounded-t-none last:rounded-b-[10px] last:border-b-0 hover:bg-[#fbfbfc]"
                  key={screenKey(screen)}
                >
                  <Checkbox
                    checked={repoSelected.has(screenKey(screen))}
                    disabled={!!busy}
                    onChange={() => toggleScreen(screenKey(screen))}
                  />
                  <span className="font-mono text-[9.5px] text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                  <span className="min-w-0">
                    <b className="block overflow-hidden whitespace-nowrap text-ellipsis text-[12.5px] text-ink">
                      {screen.title}
                    </b>
                    <span className="mt-[3px] block overflow-hidden whitespace-nowrap text-ellipsis font-mono text-[10px] text-ink-faint">
                      {screen.route}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-[3px] font-mono text-[8.5px] font-semibold uppercase tracking-[0.08em]',
                      screen.source === 'placeholder'
                        ? 'bg-paper-deep text-ink-faint'
                        : 'bg-accent-ink/10 text-accent-ink',
                    )}
                  >
                    {kindLabel(screen)}
                  </span>
                </label>
              ))}
            </div>
            {pageCount > 0 && (
              <Button
                variant="bare"
                size="sm"
                className="mt-2 self-start p-0 font-mono text-[10.5px] text-ink-faint hover:bg-transparent hover:text-accent-ink"
                disabled={!!busy}
                onClick={() => setShowPages((v) => !v)}
              >
                {showPages ? 'hide pages' : `show ${pageCount} page${pageCount === 1 ? '' : 's'} (optional)`}
              </Button>
            )}
            {repoReview.manifest.truncated && (
              <p className={importNoteCls}>The repository listing was cut short — very large repos show a subset.</p>
            )}
            {busy === 'importing' && (
              <p className={cn(importNoteCls, 'text-accent-ink')}>
                Doop is importing — the style guide and sketches fill in on the canvas…
              </p>
            )}
            {error && <p className={errorNoteCls}>{error}</p>}
            <ModalActions className="justify-between">
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  setRepoReview(null)
                  setError(null)
                }}
              >
                ← Back
              </Button>
              <Button
                variant="primary"
                disabled={!!busy || (!repoSelected.size && !extractSystem)}
                onClick={importRepoScreens}
              >
                {busy === 'importing'
                  ? 'Importing…'
                  : [
                      extractSystem ? 'design system' : '',
                      repoSelected.size
                        ? `${repoSelected.size} ${
                            repoSelected.size === 1
                              ? 'component'
                              : visibleScreens
                                    .filter((s) => repoSelected.has(screenKey(s)))
                                    .every((s) => s.kind === 'component' || s.kind === 'story')
                                ? 'components'
                                : 'screens'
                          }`
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' + ')
                      .replace(/^./, (c) => '⤓ Import ' + c)}
              </Button>
            </ModalActions>
          </>
        ) : !discovery ? (
          <>
            <div className="flex flex-col gap-[5px]">
              <ModalEyebrow>Website capture</ModalEyebrow>
              <ModalTitle>Import from the web</ModalTitle>
            </div>
            <ModalLede>
              Bring in one page, or discover a whole site and choose the pages you want before anything is added.
            </ModalLede>
            <Field className="mt-[22px]" label="Website URL" labelVariant="form" htmlFor="import-url">
              <Input
                id="import-url"
                variant="mono"
                inputSize="lg"
                className="bg-paper focus:border-ink focus:bg-white focus:ring-0"
                autoFocus
                placeholder="https://example.com"
                value={url}
                disabled={!!busy}
                onChange={(e) => {
                  setUrl(e.target.value)
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (wholeSite) discover()
                    else runSinglePage()
                  }
                  if (e.key === 'Escape' && !busy) onClose()
                }}
              />
            </Field>
            <CheckboxCard
              checked={wholeSite}
              disabled={!!busy}
              onChange={(next) => {
                setWholeSite(next)
                setError(null)
              }}
              title={
                <>
                  Import the entire website{' '}
                  <em className="ml-[7px] rounded-full bg-paper-deep px-1.5 py-[2px] font-mono text-[8.5px] font-semibold uppercase not-italic tracking-[0.08em] text-ink-faint">
                    Optional
                  </em>
                </>
              }
              description="Find public pages on the same site, then review the list."
            />
            <p className={importNoteCls}>Snapshots stay editable and commentable. Scripts are removed.</p>
            {error && <p className={errorNoteCls}>{error}</p>}
            <ModalActions>
              <Button variant="ghost" disabled={!!busy} onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!!busy || !url.trim()} onClick={wholeSite ? discover : runSinglePage}>
                {busy === 'discovering'
                  ? 'Finding pages…'
                  : busy === 'importing'
                    ? 'Importing…'
                    : wholeSite
                      ? 'Find pages →'
                      : '⤓ Import page'}
              </Button>
            </ModalActions>
            <SyncKeysSection canvasId={canvasId} />
            <GithubSection
              canvasId={canvasId}
              installPass={installPass}
              installError={installError}
              onReview={openRepoReview}
            />
          </>
        ) : (
          <>
            <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row sm:gap-6">
              <div className="flex flex-col gap-[5px]">
                <ModalEyebrow>Review before import</ModalEyebrow>
                <ModalTitle>Choose pages</ModalTitle>
              </div>
              <Badge className="max-w-full overflow-hidden text-ellipsis rounded-full bg-paper px-[9px] py-[5px] text-[10.5px] sm:max-w-[240px]">
                {new URL(discovery.siteUrl).hostname}
              </Badge>
            </div>
            <ModalLede>
              {discovery.pages.length} {discovery.pages.length === 1 ? 'page' : 'pages'} found. Everything is selected
              by default; uncheck anything you don’t need.
            </ModalLede>
            <div className="mt-5 flex items-center justify-between px-[2px] pb-[9px]">
              <b className="text-[12px] text-ink-soft">
                {selectedCount} of {discovery.pages.length} selected
              </b>
              <span className="flex gap-3">
                <Button
                  variant="bare"
                  size="sm"
                  className="p-0 font-mono text-[10.5px] hover:bg-transparent hover:text-accent-ink"
                  disabled={!!busy}
                  onClick={() => setSelected(new Set(discovery.pages.map((p) => p.url)))}
                >
                  Select all
                </Button>
                <Button
                  variant="bare"
                  size="sm"
                  className="p-0 font-mono text-[10.5px] hover:bg-transparent hover:text-accent-ink"
                  disabled={!!busy}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
              </span>
            </div>
            <div
              className={cn(
                'max-h-[calc(100dvh-390px)] overflow-y-auto rounded-[11px] border border-line bg-paper transition-opacity sm:max-h-[min(350px,calc(100vh-390px))]',
                busy && 'opacity-[0.58]',
              )}
              role="group"
              aria-label="Pages to import"
            >
              {discovery.pages.map((page, index) => {
                const pageUrl = new URL(page.url)
                let pathname = pageUrl.pathname
                try {
                  pathname = decodeURIComponent(pathname)
                } catch {
                  /* Keep the encoded path when a site contains a malformed escape. */
                }
                const path = pathname + pageUrl.search
                return (
                  <label
                    className="relative grid min-h-[58px] cursor-pointer grid-cols-[20px_24px_minmax(0,1fr)] items-center gap-2.5 border-b border-line bg-surface px-3 py-[9px] first:rounded-t-[10px] last:rounded-t-none last:rounded-b-[10px] last:border-b-0 hover:bg-[#fbfbfc]"
                    key={page.url}
                  >
                    <Checkbox
                      checked={selected.has(page.url)}
                      disabled={!!busy}
                      onChange={() => togglePage(page.url)}
                    />
                    <span className="font-mono text-[9.5px] text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                    <span className="min-w-0">
                      <b className="block overflow-hidden whitespace-nowrap text-ellipsis text-[12.5px] text-ink">
                        {page.title}
                      </b>
                      <span className="mt-[3px] block overflow-hidden whitespace-nowrap text-ellipsis font-mono text-[10px] text-ink-faint">
                        {path || '/'}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
            {discovery.truncated && (
              <p className={importNoteCls}>Showing the first 100 pages found. Narrow the starting URL if needed.</p>
            )}
            {busy === 'importing' && (
              <p className={cn(importNoteCls, 'text-accent-ink')}>
                Capturing {selectedCount} pages — larger sites can take a few minutes.
              </p>
            )}
            {error && <p className={errorNoteCls}>{error}</p>}
            <ModalActions className="justify-between">
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  setDiscovery(null)
                  setError(null)
                }}
              >
                ← Back
              </Button>
              <Button variant="primary" disabled={!!busy || !selectedCount} onClick={importSelected}>
                {busy === 'importing'
                  ? `Importing ${selectedCount}…`
                  : `⤓ Import ${selectedCount} ${selectedCount === 1 ? 'page' : 'pages'}`}
              </Button>
            </ModalActions>
          </>
        )}
      </>
    </Modal>
  )
}

/** Your display name, the identity on your cursor and in the feed. It lives on
 *  the account, so saving it updates the account and rejoins the canvas. */
function RenameSelfModal({ current, onClose }: { current: string; onClose: () => void }) {
  const [draft, setDraft] = useState(current)
  const [busy, setBusy] = useState(false)
  const clean = draft.trim()

  function save() {
    if (!clean || clean === current || busy) return onClose()
    setBusy(true)
    authClient.updateUser({ name: clean }).then(() => {
      setName(clean)
      location.reload()
    })
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <ModalTitle>Your display name</ModalTitle>
        <ModalLede>Shown on your cursor, in the activity feed, and on everything you leave for an agent.</ModalLede>
        <Field className="mt-5" label="Name" labelVariant="form" htmlFor="display-name">
          <Input
            id="display-name"
            autoFocus
            value={draft}
            maxLength={60}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </Field>
        <ModalActions>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !clean || clean === current} onClick={save}>
            {busy ? 'Saving…' : 'Save name'}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/* Design sync: mint write-only snippet keys so an app pushes its live screens
   onto this canvas — the import path for products behind SSO/VPN where the
   server-side importer can't go. */
function SyncKeysSection({ canvasId }: { canvasId: string }) {
  const [keys, setKeys] = useState<SyncKeyInfo[] | null>(null)
  const [name, setAppName] = useState('')
  const [busy, setBusy] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  /* keys are owner/member-only (durable access) — link-edit visitors get a
     403 and shouldn't see the section at all */
  const [forbidden, setForbidden] = useState(false)

  useEffect(() => {
    api
      .listSyncKeys(canvasId)
      .then(setKeys)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true)
        setKeys([])
      })
  }, [canvasId])

  /* key in the src query string — the one attribute tag managers never strip */
  const snippetFor = (secret: string) =>
    `<script async src="${location.origin}/doop-sync.js?key=${secret}"></` + `script>`

  async function create() {
    if (busy || !name.trim()) return
    setBusy(true)
    try {
      const key = await api.createSyncKey(canvasId, name.trim())
      setKeys((k) => [key, ...(k ?? [])])
      setAppName('')
      posthog.capture('sync_key_created')
    } catch (e) {
      console.error(e)
    }
    setBusy(false)
  }

  function revoke(keyId: string) {
    api.deleteSyncKey(canvasId, keyId).catch(console.error)
    setKeys((k) => k?.filter((x) => x.id !== keyId) ?? null)
  }

  async function copySnippet(key: SyncKeyInfo) {
    await navigator.clipboard.writeText(snippetFor(key.secret))
    setCopiedId(key.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  if (forbidden) return null
  return (
    <div className="mt-3.5 flex flex-col gap-2.5 border-t border-line-soft pt-3.5">
      <h3 className="text-[13px] font-semibold text-ink">Or sync a live app</h3>
      <Note>
        For apps a crawler can't reach — behind a login, a VPN, or on localhost. Paste one script tag and each screen
        people visit lands here as a frame, imported once. Delete a frame to re-import it fresh. The key only writes to
        this canvas.
      </Note>
      {(keys ?? []).map((k) => (
        <div key={k.id} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[13px]">
            <b className="font-semibold">{k.name}</b>
            <Note className="mr-auto">
              {k.frames ? `${k.frames} screen${k.frames === 1 ? '' : 's'}` : k.lastUsedAt ? 'synced' : 'never synced'}
            </Note>
            <Button
              variant="bare"
              size="icon-sm"
              className="-mr-1.5 text-[13px] hover:bg-accent-ink/10 hover:text-accent-ink"
              title="Revoke this key"
              onClick={() => revoke(k.id)}
            >
              ✕
            </Button>
          </div>
          <div className="relative">
            <Textarea
              className="resize-none border-line-soft bg-black/[0.04] py-2 pl-2.5 pr-[84px] font-mono text-[11px] leading-normal text-ink-faint focus:border-line focus:text-ink focus:ring-0 md:text-[11px] [word-break:break-all]"
              readOnly
              rows={4}
              value={snippetFor(k.secret)}
              onFocus={(e) => e.target.select()}
            />
            <Button
              size="sm"
              className="absolute right-3.5 top-3 bg-surface px-2.5 text-xs"
              onClick={() => copySnippet(k)}
            >
              {copiedId === k.id ? 'Copied!' : '⧉ Copy'}
            </Button>
          </div>
        </div>
      ))}
      <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row">
        <Input
          className="flex-1 rounded-[10px] bg-paper focus:ring-0"
          placeholder="App name (e.g. Admin dashboard)"
          value={name}
          disabled={busy}
          onChange={(e) => setAppName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <Button variant="primary" className="justify-center" disabled={busy || !name.trim()} onClick={create}>
          Create key
        </Button>
      </div>
    </div>
  )
}

/* GitHub as an import source: one click installs the doop GitHub App on the
   repos you pick and you land back here on a repo picker — no tokens to
   copy. Pasting a fine-grained PAT stays as the fallback when the app isn't
   configured (self-hosters) or someone prefers it. Credentials stay on the
   server either way — this section only ever sees connection metadata.
   Same durable-access rule as sync keys. */
function GithubSection({
  canvasId,
  installPass,
  installError,
  onReview,
}: {
  canvasId: string
  installPass: string | null
  installError: string | null
  onReview: (connection: GithubConnectionInfo, manifest: RepoManifest) => void
}) {
  const [connections, setConnections] = useState<GithubConnectionInfo[] | null>(null)
  const [appEnabled, setAppEnabled] = useState(false)
  const [showTokenForm, setShowTokenForm] = useState(false)
  const [pickerRepos, setPickerRepos] = useState<InstallationRepo[] | null>(null)
  const [repo, setRepo] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'connecting' | string | null>(null)
  const [error, setError] = useState<string | null>(installError)
  const [forbidden, setForbidden] = useState(false)

  useEffect(() => {
    api
      .listGithubConnections(canvasId)
      .then(setConnections)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setForbidden(true)
        setConnections([])
      })
    api
      .githubAppInfo()
      .then((info) => setAppEnabled(info.enabled))
      .catch(() => setAppEnabled(false))
  }, [canvasId])

  /* back from GitHub's install screen: swap the pass for the repo list */
  useEffect(() => {
    if (!installPass) return
    api
      .listInstallationRepos(canvasId, installPass)
      .then(setPickerRepos)
      .catch((e) => failed(e, 'could not list the installed repositories'))
  }, [canvasId, installPass])

  function failed(caught: unknown, fallback: string) {
    setError(caught instanceof ApiError ? String(caught.body.error ?? fallback) : fallback)
    setBusy(null)
  }

  async function startInstall() {
    if (busy) return
    setBusy('connecting')
    setError(null)
    try {
      const { url } = await api.startGithubInstall(canvasId)
      posthog.capture('github_app_install_started')
      location.href = url
    } catch (e) {
      failed(e, 'could not start the GitHub install')
    }
  }

  async function connectInstalledRepo(fullName: string) {
    if (busy || !installPass) return
    setBusy('connecting')
    setError(null)
    try {
      const conn = await api.connectGithub(canvasId, { repo: fullName, pass: installPass })
      setConnections((c) => [conn, ...(c ?? [])])
      setPickerRepos((r) => r?.filter((x) => x.fullName !== fullName) ?? null)
      setBusy(null)
      posthog.capture('github_repo_connected', { via: 'app' })
    } catch (e) {
      failed(e, 'could not connect the repository')
    }
  }

  async function connectRepo() {
    if (busy || !repo.trim() || !token.trim()) return
    setBusy('connecting')
    setError(null)
    try {
      const conn = await api.connectGithub(canvasId, {
        repo: repo.trim(),
        token: token.trim(),
      })
      setConnections((c) => [conn, ...(c ?? [])])
      setRepo('')
      setToken('')
      setBusy(null)
      posthog.capture('github_repo_connected', { via: 'token' })
    } catch (e) {
      failed(e, 'could not connect the repository')
    }
  }

  async function analyze(conn: GithubConnectionInfo) {
    if (busy) return
    setBusy(conn.id)
    setError(null)
    try {
      const manifest = await api.analyzeGithub(canvasId, conn.id)
      posthog.capture('github_screens_found', {
        screen_count: manifest.screens.length,
        framework: manifest.framework,
      })
      setBusy(null)
      onReview(conn, manifest)
    } catch (e) {
      failed(e, 'repository analysis failed')
    }
  }

  function disconnect(connId: string) {
    api.deleteGithubConnection(canvasId, connId).catch(console.error)
    setConnections((c) => c?.filter((x) => x.id !== connId) ?? null)
  }

  if (forbidden) return null
  return (
    <div className="mt-3.5 flex flex-col gap-2.5 border-t border-line-soft pt-3.5">
      <h3 className="text-[13px] font-semibold text-ink">Or connect a GitHub repo</h3>
      <Note>
        Doop reads the repo's routing conventions and lists its screens for review — nothing lands until you pick.
        {appEnabled
          ? ' Install the doop app on the repos you choose; access is scoped to exactly those and revocable on GitHub.'
          : ' Use a fine-grained token scoped to the one repo, read-only contents. The token never leaves the server.'}
      </Note>
      {(connections ?? []).map((conn) => (
        <div key={conn.id} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[13px]">
            <b className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
              {conn.repo}
              <span className="font-normal text-ink-faint">@{conn.branch}</span>
            </b>
            <Note className="mr-auto shrink-0">
              {conn.frames ? `${conn.frames} screen${conn.frames === 1 ? '' : 's'}` : 'nothing imported yet'}
            </Note>
            <Button size="sm" className="px-2.5 text-xs" disabled={!!busy} onClick={() => analyze(conn)}>
              {busy === conn.id ? 'Analyzing…' : 'Analyze'}
            </Button>
            <Button
              variant="bare"
              size="icon-sm"
              className="-mr-1.5 text-[13px] hover:bg-accent-ink/10 hover:text-accent-ink"
              title="Disconnect this repository"
              onClick={() => disconnect(conn.id)}
            >
              ✕
            </Button>
          </div>
        </div>
      ))}
      {pickerRepos && (
        <div className="flex flex-col gap-1.5 rounded-[11px] border border-line bg-paper p-2.5">
          <b className="text-[12px] text-ink-soft">Pick a repository to connect to this canvas</b>
          {pickerRepos.map((r) => (
            <div key={r.fullName} className="flex items-center gap-2 text-[13px]">
              <GithubIcon width={13} height={13} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px]">
                {r.fullName}
                {r.private && <span className="ml-1.5 text-[10px] text-ink-faint">private</span>}
              </span>
              <Button
                size="sm"
                className="px-2.5 text-xs"
                disabled={!!busy}
                onClick={() => connectInstalledRepo(r.fullName)}
              >
                {busy === 'connecting' ? 'Connecting…' : 'Connect'}
              </Button>
            </div>
          ))}
          {!pickerRepos.length && <Note>All installed repositories are connected.</Note>}
        </div>
      )}
      {appEnabled && !pickerRepos && (
        <Button variant="primary" className="justify-center gap-2 self-start" disabled={!!busy} onClick={startInstall}>
          <GithubIcon width={14} height={14} />
          {busy === 'connecting' ? 'Opening GitHub…' : 'Connect GitHub'}
        </Button>
      )}
      {appEnabled && !showTokenForm && (
        <Button
          variant="bare"
          size="sm"
          className="self-start p-0 font-mono text-[10.5px] text-ink-faint hover:bg-transparent hover:text-accent-ink"
          onClick={() => setShowTokenForm(true)}
        >
          paste a token instead
        </Button>
      )}
      {(!appEnabled || showTokenForm) && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col items-stretch gap-2 sm:flex-row">
            <Input
              className="flex-1 rounded-[10px] bg-paper font-mono text-[12px] focus:ring-0"
              placeholder="owner/repository"
              value={repo}
              disabled={!!busy}
              onChange={(e) => {
                setRepo(e.target.value)
                setError(null)
              }}
            />
            <Input
              className="flex-1 rounded-[10px] bg-paper font-mono text-[12px] focus:ring-0"
              type="password"
              placeholder="Fine-grained token (github_pat_…)"
              value={token}
              disabled={!!busy}
              onChange={(e) => {
                setToken(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && connectRepo()}
            />
          </div>
          <Button
            variant="primary"
            className="justify-center self-start"
            disabled={!!busy || !repo.trim() || !token.trim()}
            onClick={connectRepo}
          >
            {busy === 'connecting' ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      )}
      {error && <p className={errorNoteCls}>{error}</p>}
    </div>
  )
}

/* The canvas title doubles as its rename field. */
const canvasNameCls = 'min-w-0 max-w-[240px] sm:min-w-[60px] sm:max-w-[320px]'

function CanvasName() {
  const canvas = useStore((s) => s.canvas)
  const [draft, setDraft] = useState<string | null>(null)
  if (!canvas)
    return <span className={cn(canvasNameCls, 'px-2 py-[5px] font-display text-[15px] font-semibold')}>…</span>
  return (
    <Input
      variant="title"
      inputSize="sm"
      className={cn(canvasNameCls, 'truncate max-md:max-w-[calc(100vw-72px)]')}
      value={draft ?? canvas.name}
      size={Math.max(6, (draft ?? canvas.name).length)}
      onFocus={() => setDraft(canvas.name)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() && draft !== canvas.name) {
          api.renameCanvas(canvas.id, draft.trim()).catch(console.error)
          useStore.getState().renameCanvasLocal(draft.trim())
        }
        setDraft(null)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}
