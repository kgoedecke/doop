import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useStore } from '../lib/store'
import { MOD_KEY, isHideUiShortcut } from '../lib/keys'
import { canHideUi, hideUiHinted } from '../lib/hideUi'
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
import { DoopMark } from '../components/Logo'
import {
  BarPill,
  TopBar,
  TopBarTitle,
  barIconBtn,
  barPillBtn,
  barPillIconBtn,
  barPrimaryBtn,
} from '../components/TopBar'
import { LivePresence } from '../components/LivePresence'
import { ensureTab } from '../lib/desktop'
import { Stage } from '../components/Stage'
import { Inspector } from '../components/Inspector'
import { ElementPanel } from '../components/ElementPanel'
import { ActivityPanel } from '../components/ActivityPanel'
import { ConnectModal } from '../components/ConnectModal'
import { LimitWall, isResidentLimit } from '../components/TeamAllowance'
import { WorkingNow } from '../components/WorkingNow'
import { MobilePanelTabs, SideRail } from '../components/SideRail'
import { LayersPanel, LayersRailToggle } from '../components/LayersPanel'
import { Onboarding } from '../components/Onboarding'
import { ShareModal } from '../components/ShareModal'
import { ImportStepFooter, ImportStepHeader, SourcePicker } from '../components/ImportSources'
import { importSources } from '../components/importSourceList'
import { PresentMode } from '../components/PresentMode'
import { getIdentity, setName } from '../lib/identity'
import {
  copyFrames,
  duplicateFrames,
  hasFrameClip,
  pasteFrameCentered,
  pasteImagesCentered,
} from '../lib/frameClipboard'
import { clearHistory, redo, undo } from '../lib/history'
import { deleteSelection, toggleLockSelection, toggleSelectionHidden } from '../lib/layerEdits'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { useIsMobile } from '../hooks/use-mobile'
import { cn } from '@/lib/utils'
import { Button } from '../components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../components/ui/sheet'
import { AuthCard, AuthCardText, AuthScreen } from '../components/ui/screen'
import {
  BrainIcon,
  CopyIcon,
  FolderIcon,
  GithubIcon,
  ImportIcon,
  LayersIcon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusIcon,
  GearIcon,
  RadioTowerIcon,
  ShareIcon,
  ShareUpIcon,
  WebIcon,
  XIcon,
} from '../components/ui/icons'
import { Badge } from '../components/ui/badge'
import { SelectionBar, SelectionBarAction } from '../components/ui/selection-bar'
import { Input } from '../components/ui/input'
import { Field } from '../components/ui/field'
import { PeerAvatars, PresenceFace } from '../components/PeerAvatars'
import { Checkbox, CheckboxCard } from '../components/ui/checkbox'
import { Toast, ToastAction, ToastSpinner } from '../components/ui/toast'
import { Tooltip } from '../components/ui/tooltip'
import { Note } from '../components/ui/note'
import { Textarea } from '../components/ui/textarea'
import { Modal, ModalActions, ModalEyebrow, ModalLede, ModalTitle } from '../components/ui/modal'
import { createCenteredFrame } from '../lib/framePlacement'
import { AGENTS_MIN, LAYERS_MIN, fitPanelWidths } from '../lib/panelWidths'

/* The floating chrome's geometry, in px from the canvas area's edges. The
   panels sit 14px in from the edge; on the right the resizable Agents panel
   always hugs the edge, the Inspector (244) opens to its left, and the icon
   islands (40) sit left of whatever is open. On the left the tool rail follows the Layers
   panel, or its collapsed 40px island. --chrome-left/--chrome-right
   mark where the open canvas begins and ends, for the zoom pill and toasts. */
const EDGE = 14
const LAYERS_W = 264
const RAIL_W = 40
const INSPECTOR_W = 244
const AGENTS_W = 280
const PANEL_WIDTH_KEY = 'doop:canvas-panel-widths'

function readPanelWidths(): { layers: number; agents: number } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PANEL_WIDTH_KEY) ?? 'null')
    if (saved && typeof saved === 'object' && 'layers' in saved && 'agents' in saved) {
      return {
        layers: typeof saved.layers === 'number' && Number.isFinite(saved.layers) ? saved.layers : LAYERS_W,
        agents: typeof saved.agents === 'number' && Number.isFinite(saved.agents) ? saved.agents : AGENTS_W,
      }
    }
  } catch {
    /* Unavailable or invalid storage must not prevent opening a canvas. */
  }
  return { layers: LAYERS_W, agents: AGENTS_W }
}

function chromeLayout({
  layersOpen,
  propertiesShown,
  agentsOpen,
  layersWidth,
  agentsWidth,
}: {
  layersOpen: boolean
  propertiesShown: boolean
  agentsOpen: boolean
  layersWidth: number
  agentsWidth: number
}) {
  const toolRail = layersOpen ? EDGE + layersWidth + 12 : EDGE + RAIL_W + 10
  const properties = agentsOpen ? EDGE + agentsWidth + 8 : EDGE
  const island = propertiesShown ? properties + INSPECTOR_W + 10 : agentsOpen ? EDGE + agentsWidth + 10 : EDGE
  return { toolRail, properties, island, left: toolRail + RAIL_W + 16, right: island + RAIL_W + 10 }
}

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
  const [panelWidths, setPanelWidths] = useState(readPanelWidths)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateWidth)
    return () => window.removeEventListener('resize', updateWidth)
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, JSON.stringify(panelWidths))
    } catch {
      /* Resizing still works when preferences cannot be saved. */
    }
  }, [panelWidths])
  const [showActivity, setShowActivity] = useState(() => !window.matchMedia('(max-width: 900px)').matches)
  /* ?connect=1 (the "connect your agent" email) lands on the Connect AI
     modal; the flag comes off the URL once the page is up so a reload or a
     copied link does not reopen it */
  const [showConnect, setShowConnect] = useState(() => new URLSearchParams(location.search).get('connect') === '1')
  useEffect(() => {
    const url = new URL(location.href)
    if (url.searchParams.get('connect') !== '1') return
    url.searchParams.delete('connect')
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])
  const [showShare, setShowShare] = useState(false)
  const [presenting, setPresenting] = useState(false)
  /* ⌘. acts only over the canvas view, outside PresentMode */
  const hideUiActive = canHideUi({ view: 'canvas', presenting })
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
  /* ?import=<source> (Home's Import picker, on the canvas it just made) opens
     the import modal on that source's screen (`1` for the picker itself); the
     flag comes off the URL once the page is up, the same way ?connect=1 does —
     stripping it in the initializer loses it to the remount that follows the
     canvas load */
  const [importRequested] = useState(() => new URLSearchParams(location.search).get('import'))
  useEffect(() => {
    const url = new URL(location.href)
    if (!url.searchParams.has('import')) return
    url.searchParams.delete('import')
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])
  const [showImport, setShowImport] = useState(!!ghInstallPass || !!ghInstallError || !!importRequested)
  const [showMobileActions, setShowMobileActions] = useState(false)
  const [showMobileLayers, setShowMobileLayers] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const storeNotice = useStore((s) => s.notice)
  const updateReady = useStore((s) => s.updateReady)
  const limitWall = useStore((s) => s.limitWall)
  const canvasNotFound = useStore((s) => s.canvasNotFound)

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
      useStore.getState().setCanvasNotFound(false)
      select(null)
      useStore.getState().setTool('select')
      clearHistory()
    }
  }, [canvasId, select])

  /* broadcast which frame I'm focused on */
  useEffect(() => {
    sendWs({ type: 'editing', frameId: selectedId })
  }, [selectedId])

  /* frame keyboard shortcuts: delete, copy/paste/duplicate, undo/redo */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      /* ⌘K from anywhere, fields included: open the side panel on the Agents
         tab and put the keyboard in its "Design it" composer. Asking for the
         composer ends ⌘. hide-UI — a field under `hidden` cannot take focus. */
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowActivity(true)
        if (useStore.getState().uiHidden) useStore.getState().toggleUiHidden()
        useStore.getState().setPanelTab('tasks')
        useStore.getState().requestComposerFocus()
        return
      }
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const selectedIds = useStore.getState().selectedIds
      /* a picked element (from the canvas or the layers tree) is what ⌫
         removes — the frame it lives in only goes when nothing inside it is
         selected. Auto-repeat is ignored: a held key must not take the
         element and then, on the next repeat, the frame under it. */
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.repeat && deleteSelection()) e.preventDefault()
      if (e.key === 'Escape') {
        select(null)
        useStore.getState().setFollowing(null)
      }
      /* ⌘. hides every panel and toolbar; ⌘. again brings them back as they
         were. Escape deliberately leaves the UI hidden, as in Figma. */
      if (isHideUiShortcut(e) && hideUiActive) {
        e.preventDefault()
        useStore.getState().toggleUiHidden()
        if (useStore.getState().uiHidden && !hideUiHinted()) showToast(`UI hidden · ${MOD_KEY}. to show`)
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) void redo()
        else void undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        void redo()
        return
      }
      /* ⌘⇧H hides or shows what is selected — the picked element, else the
         frames — as the eye in the Layers panel would */
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h') {
        if (toggleSelectionHidden()) e.preventDefault()
        return
      }
      /* ⌘⇧L locks or unlocks what is selected: the picked layer, else the frames */
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
        if (toggleLockSelection()) e.preventDefault()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        /* ⌘C and ⌘D act on the whole selection */
        const frames = useStore.getState().canvas?.frames.filter((f) => selectedIds.includes(f.id)) ?? []
        /* don't hijack ⌘C when the user is copying selected text */
        if (e.key === 'c' && frames.length && !window.getSelection()?.toString()) copyFrames(frames)
        if (e.key === 'd' && frames.length) {
          e.preventDefault()
          duplicateFrames(frames)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canvasId, hideUiActive]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const frame = await createCenteredFrame(canvasId, `Frame ${n}`, STARTER_HTML)
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
  const layersOpen = useStore((s) => s.layersOpen)
  /* ⌘. — the canvas view with nothing over it; the board and PresentMode keep their chrome */
  const uiHidden = useStore((s) => s.uiHidden) && hideUiActive
  /* the element panel takes the frame inspector's spot while a Layers row
     has it open; it follows the element selection until it is closed */
  const selectedElement = useStore((s) => s.selectedElement)
  const elementPanelOpen = useStore((s) => s.elementPanelOpen)
  const panelElement = elementPanelOpen && selectedElement?.frameId === selectedFrame?.id ? selectedElement : null
  /* the frame Inspector or the element panel, whichever has the slot */
  const propertiesShown = !!selectedFrame && !deferPanel && (!!panelElement || inspectorOpen)
  const fixedChrome = chromeLayout({
    layersOpen,
    propertiesShown,
    agentsOpen: showActivity,
    layersWidth: 0,
    agentsWidth: 0,
  })
  const panels = fitPanelWidths({
    saved: panelWidths,
    viewport: viewportWidth,
    reserved: fixedChrome.left + fixedChrome.right,
    layersOpen,
    agentsOpen: showActivity,
  })
  const layersWidth = panels.layers
  const agentsWidth = panels.agents
  const chrome = chromeLayout({ layersOpen, propertiesShown, agentsOpen: showActivity, layersWidth, agentsWidth })
  const chromeVars = {
    '--chrome-top': isMobile ? '0px' : '50px',
    '--rail-left': `${chrome.toolRail}px`,
    '--chrome-left': `${chrome.left}px`,
    '--chrome-right': `${chrome.right}px`,
  } as CSSProperties
  const meFace = { name: me.name, color: presences[me.clientId]?.color ?? 'var(--brand)' }

  function openConnect() {
    posthog.capture('agent_connection_opened')
    setShowConnect(true)
  }

  /* the id in the URL isn't a canvas — a typo, a stale link, or one someone
     just deleted. Say so plainly rather than opening a canvas shell that
     can't load anything and never will. */
  if (canvasNotFound) {
    return (
      <AuthScreen>
        <AuthCard title="Canvas not found" align="center">
          <AuthCardText>
            &ldquo;{canvasId}&rdquo; doesn&rsquo;t match a canvas we know about. It may have been deleted, or the link
            may be wrong.
          </AuthCardText>
          <Button className="self-center" onClick={() => navigate('/')}>
            Back to your canvases
          </Button>
        </AuthCard>
      </AuthScreen>
    )
  }

  return (
    /* --app-inset is 0 normally; the impersonation shell raises it so this
       fixed layer starts below the banner instead of under it */
    <div className="fixed inset-x-0 bottom-0 top-[var(--app-inset,0px)] bg-paper">
      {/* Floating pills over the canvas, which shows through the transparent
          bar: the title pill on the left, live presence centred, sharing on
          the right. Tablet (xs..md) folds the text actions into the •••
          sheet; phone (< xs) wraps to two rows. ⌘. hides the chrome (this
          bar, the panels, the toolbars) with display:none rather than
          unmounting it, so what it holds — a composer draft, the expanded
          layers, a scroll position — is exactly as it was when ⌘. brings it
          back. */}
      <TopBar variant="canvas" className={cn(uiHidden && 'hidden')}>
        <div className="flex min-w-0 items-center gap-2 max-xs:basis-full">
          <BarPill className="min-w-0 gap-1 pr-3 pl-1">
            <Tooltip label="All canvases" side="bottom" align="start">
              <Button
                variant="bare"
                size="icon-sm"
                className={barPillIconBtn}
                aria-label="All canvases"
                onClick={() => navigate('/')}
              >
                <FolderIcon className="size-3.5" />
              </Button>
            </Tooltip>
            <CanvasName />
            <Badge className="max-md:hidden" title="Canvas id — agents use this with the MCP tools">
              {canvasId}
            </Badge>
            {connected ? (
              <span className="ml-1 whitespace-nowrap text-ink-faint max-lg:hidden">— Auto-saved</span>
            ) : (
              <span className="ml-1 whitespace-nowrap text-accent-ink">— Reconnecting…</span>
            )}
          </BarPill>
        </div>
        <div className="absolute top-3.5 left-1/2 -translate-x-1/2 max-[1180px]:hidden">
          <LivePresence me={meFace} others={others} onRenameSelf={() => setRenaming(true)} />
        </div>
        <div className="ml-auto flex flex-none items-center gap-2 max-md:hidden">
          {/* the presence pill needs the bar's centre; narrower desktops keep
              the plain avatar stack (and its follow buttons) over here */}
          <div
            className="mr-1 flex items-center min-[1181px]:hidden"
            title={others.map((p) => p.name).join(', ') || 'Just you here'}
          >
            <PresenceFace name={meFace.name} color={meFace.color} kind="user" />
            <span className="-ml-[7px] flex items-center">
              <PeerAvatars others={others} />
            </span>
          </div>
          <BarPill>
            <Button
              variant="bare"
              className={barPillBtn}
              onClick={() => setShowImport(true)}
              title="Import a live web page as a frame"
            >
              <ImportIcon className="size-3.5" />
              Import
            </Button>
          </BarPill>
          <BarPill>
            <Button variant="bare" className={barPillBtn} onClick={() => setShowShare(true)}>
              <ShareUpIcon className="size-3.5" />
              Share
            </Button>
            <Tooltip label={selectedId ? 'Present this frame' : 'Select a frame to present'} side="bottom">
              <span className="inline-flex">
                <Button
                  variant="bare"
                  size="icon-sm"
                  className={barPillIconBtn}
                  aria-label="Present selected frame"
                  disabled={!selectedId}
                  onClick={() => setPresenting(true)}
                >
                  <PlayIcon className="size-3.5" />
                </Button>
              </span>
            </Tooltip>
          </BarPill>
          {/* the bar's one black action — it opens the MCP connection modal */}
          <Button variant="primary" className={barPrimaryBtn} onClick={openConnect}>
            <PlusIcon className="size-3.5" strokeWidth={1.4} />
            Connect AI
          </Button>
        </div>
        <div className="ml-auto hidden items-center gap-1.5 max-md:flex max-xs:order-3">
          <div
            className="mr-1 flex items-center max-sm:hidden"
            title={others.map((p) => p.name).join(', ') || 'Just you here'}
          >
            <PresenceFace name={meFace.name} color={meFace.color} kind="user" />
            <span className="-ml-[7px] flex items-center">
              <PeerAvatars others={others} />
            </span>
          </div>
          <Button variant="primary" className={barPrimaryBtn} onClick={openConnect}>
            <PlusIcon className="size-3.5" strokeWidth={1.4} />
            <span className="max-sm:hidden">Connect AI</span>
            <span className="sm:hidden">AI</span>
          </Button>
          <Tooltip label="Canvas actions" side="bottom" align="end">
            <Button
              variant="ghost"
              size="icon"
              className={barIconBtn}
              aria-label="Canvas actions"
              onClick={() => setShowMobileActions(true)}
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </Tooltip>
        </div>
      </TopBar>

      {/* the canvas runs under the transparent top bar to the window's top
          edge; the floating chrome gets its own layer that starts below the
          bar, so every panel offset stays measured from there */}
      <div className="absolute inset-0 overflow-hidden" style={chromeVars}>
        <Stage onAddFrame={addFrame} rightInset={isMobile ? 0 : chrome.right} />
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 top-[50px] max-md:top-14 max-xs:top-[100px]',
            uiHidden && 'hidden',
          )}
        >
          <div className="pointer-events-none absolute top-3.5 right-[var(--chrome-right)] z-30 flex flex-col items-end gap-2 transition-[right] duration-150 [&>*]:pointer-events-auto max-md:top-[56px] max-md:right-2 max-md:left-2">
            {pendingProposal && mutedProposal !== pendingProposal.id && !(showActivity && panelTab === 'memory') && (
              <div className="flex items-center rounded-[10px] bg-surface shadow-ring">
                <Button
                  variant="bare"
                  className="h-8 pr-1 pl-3 text-[12px] font-medium text-ink hover:bg-transparent hover:text-ink"
                  onClick={() => {
                    useStore.getState().setPanelTab('memory')
                    setShowActivity(true)
                  }}
                >
                  <DoopMark size={12} /> Memory suggestion — review
                </Button>
                <Button
                  variant="bare"
                  size="icon-sm"
                  className="mr-1 size-6 rounded-[6px] text-ink-faint"
                  title="Hide for now"
                  aria-label="Hide for now"
                  onClick={() => setMutedProposal(pendingProposal.id)}
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
            )}
            {decisionToast && (
              <Button
                variant="bare"
                className="max-w-full items-center gap-2.5 whitespace-normal rounded-[12px] bg-surface px-3.5 py-2.5 text-left font-normal shadow-pop transition-shadow hover:bg-surface hover:shadow-ring-hover sm:max-w-[320px] [&_svg]:text-ink-soft"
                title="Open Memory"
                onClick={() => {
                  useStore.getState().setPanelTab('memory')
                  setShowActivity(true)
                  setDecisionToast(null)
                }}
              >
                <BrainIcon className="size-4" />
                <span>
                  <b className="block text-[12.5px] font-medium text-ink">Saved to Memory</b>
                  <span className="mt-[1px] block text-[12px] leading-[1.4] text-ink-soft">{decisionToast}</span>
                </span>
              </Button>
            )}
          </div>
          {/* the presence pill in the bar already carries each agent's status
              line; this per-agent stack is only for windows too narrow for it */}
          <WorkingNow style={{ left: chrome.left }} className="min-[1180px]:hidden" />
          <Onboarding canvasId={canvasId} />
          {!isMobile &&
            (layersOpen ? (
              <LayersPanel
                onAddFrame={addFrame}
                resize={{
                  label: 'Resize Layers panel',
                  edge: 'right',
                  width: layersWidth,
                  min: LAYERS_MIN,
                  max: panels.layersMax,
                  /* the other panel keeps the width it shows, not a larger saved
                     one the window had squeezed */
                  onResize: (layers) =>
                    setPanelWidths((widths) => ({ layers, agents: showActivity ? panels.agents : widths.agents })),
                }}
              />
            ) : (
              <LayersRailToggle />
            ))}
          {isMobile && !showActivity && (
            <MobilePanelTabs
              onOpen={(tab) => {
                useStore.getState().setPanelTab(tab)
                setShowActivity(true)
              }}
            />
          )}
          {!isMobile && selectedFrame && panelElement && !deferPanel && (
            <ElementPanel
              /* keyed by frame, not element: picking the next element swaps
                 the values in place instead of remounting the panel blank */
              key={selectedFrame.id}
              frame={selectedFrame}
              selector={panelElement.selector}
              style={{ right: chrome.properties }}
            />
          )}
          {!isMobile && selectedFrame && inspectorOpen && !panelElement && !deferPanel && (
            <Inspector frame={selectedFrame} style={{ right: chrome.properties }} />
          )}
          {!isMobile && showActivity && (
            <ActivityPanel
              canvasId={canvasId}
              onClose={() => setShowActivity(false)}
              style={{ right: EDGE }}
              resize={{
                label: 'Resize Agents panel',
                edge: 'left',
                width: agentsWidth,
                min: AGENTS_MIN,
                max: panels.agentsMax,
                onResize: (agents) =>
                  setPanelWidths((widths) => ({ agents, layers: layersOpen ? panels.layers : widths.layers })),
              }}
            />
          )}
          {!isMobile && (
            <SideRail
              style={{ right: chrome.island }}
              agentsOpen={showActivity}
              onToggleAgents={() => setShowActivity((open) => !open)}
              inspectorOpen={propertiesShown}
              inspectorAvailable={!!selectedFrame}
              onToggleInspector={() => {
                const s = useStore.getState()
                if (propertiesShown) {
                  /* the element panel and the inspector share the slot —
                     hiding it closes whichever is showing */
                  s.setElementPanelOpen(false)
                  s.setInspectorOpen(false)
                } else s.setInspectorOpen(true)
              }}
              me={meFace}
              onRenameSelf={() => setRenaming(true)}
            />
          )}
        </div>
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
                  Layers, import, export, share, or your account settings.
                </SheetDescription>
              </div>
              {/* the same glyphs as the desktop bar and islands; pages live
                  in the Layers sheet, as on desktop */}
              <div className="grid gap-2 p-4 [&_svg]:size-3.5 [&_svg]:text-ink-soft">
                <Button
                  variant="ghost"
                  className="h-11 justify-start gap-2.5 border-line bg-surface px-4"
                  onClick={() => {
                    setShowMobileActions(false)
                    setShowMobileLayers(true)
                  }}
                >
                  <LayersIcon /> Layers
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 justify-start gap-2.5 border-line bg-surface px-4"
                  onClick={() => {
                    setShowMobileActions(false)
                    setShowImport(true)
                  }}
                >
                  <ImportIcon /> Import website
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 justify-start gap-2.5 border-line bg-surface px-4"
                  onClick={() => {
                    setShowMobileActions(false)
                    setShowShare(true)
                  }}
                >
                  <ShareIcon /> Share canvas
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 justify-start gap-2.5 px-4 text-ink-soft"
                  onClick={() => navigate('/settings')}
                >
                  <GearIcon /> Settings
                </Button>
              </div>
            </SheetContent>
          </Sheet>
          <Sheet open={showMobileLayers && !uiHidden} onOpenChange={setShowMobileLayers}>
            <SheetContent
              side="bottom"
              showCloseButton={false}
              /* the first focusable is the panel's close button, whose
                 tooltip would pop on the sheet's auto-focus; the finger is
                 the focus on a phone anyway */
              onOpenAutoFocus={(e) => e.preventDefault()}
              className="max-h-[calc(100svh-56px)] gap-0 rounded-t-2xl border-line bg-surface p-0 shadow-pop data-[side=bottom]:h-[min(78svh,680px)]"
            >
              <SheetTitle className="sr-only">Layers</SheetTitle>
              <LayersPanel onAddFrame={addFrame} surface="inline" onClose={() => setShowMobileLayers(false)} />
            </SheetContent>
          </Sheet>
          {/* ⌘. closes both sheets (and their backdrops) for the moment only:
              the open state they read from is untouched, so they are back
              as they were when ⌘. restores the chrome */}
          <Sheet
            open={!!selectedFrame && inspectorOpen && !deferPanel && !uiHidden}
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
          <Sheet open={showActivity && !uiHidden} onOpenChange={setShowActivity}>
            <SheetContent
              side="bottom"
              showCloseButton={false}
              className="max-h-[calc(100svh-56px)] gap-0 rounded-t-2xl border-line bg-surface p-0 shadow-pop data-[side=bottom]:h-[min(78svh,680px)]"
            >
              <SheetTitle className="sr-only">Canvas activity</SheetTitle>
              <ActivityPanel canvasId={canvasId} onClose={() => setShowActivity(false)} surface="inline" />
            </SheetContent>
          </Sheet>
        </>
      )}

      {renaming && <RenameSelfModal current={me.name} onClose={() => setRenaming(false)} />}
      {showConnect && <ConnectModal canvasId={canvasId} onClose={() => setShowConnect(false)} />}
      {presenting && selectedId && <PresentMode frameId={selectedId} onClose={() => setPresenting(false)} />}
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
          initialSource={importRequested && importRequested !== '1' ? importRequested : null}
          onClose={() => {
            setShowImport(false)
            setGhInstallPass(null)
          }}
          onDone={(frameIds, failedCount) => {
            setShowImport(false)
            select(frameIds[0] ?? null)
            const imported = frameIds.length === 1 ? '1 item imported' : `${frameIds.length} items imported`
            showToast(failedCount ? `${imported} · ${failedCount} failed` : imported)
          }}
          onQueued={(cardCount) => {
            setShowImport(false)
            setGhInstallPass(null)
            showToast(`${cardCount} ${cardCount === 1 ? 'card' : 'cards'} queued — Doop is on it`)
          }}
        />
      )}
      {updateReady ? (
        <Toast>
          doop was updated
          <ToastAction onClick={() => location.reload()}>Reload</ToastAction>
        </Toast>
      ) : toast ? (
        <Toast>{toast}</Toast>
      ) : (
        storeNotice && (
          <Toast>
            {storeNotice.busy && <ToastSpinner />}
            {storeNotice.text}
          </Toast>
        )
      )}
    </div>
  )
}

function ImportModal({
  canvasId,
  installPass,
  installError,
  initialSource = null,
  onClose,
  onDone,
  onQueued,
}: {
  canvasId: string
  installPass: string | null
  installError: string | null
  /** open straight on this source's screen (Home's picker already chose) */
  initialSource?: string | null
  onClose: () => void
  onDone: (frameIds: string[], failedCount: number) => void
  /** a repo import queues cards on the board instead of landing frames */
  onQueued: (cardCount: number) => void
}) {
  /* which source's screen is open — null is the picker; landing back from
     GitHub's install flow jumps straight to that screen */
  const [source, setSource] = useState<string | null>(installPass || installError ? 'github' : initialSource)
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
      if (!result.cards.length) {
        setError(
          result.rejected.length
            ? 'Those screens are no longer in the repository — re-run the scan'
            : 'Everything you picked is already on the board',
        )
        setBusy(null)
        return
      }
      posthog.capture('github_screens_imported', {
        requested_count: screens.length,
        queued_count: result.cards.length,
        rejected_count: result.rejected.length,
      })
      onQueued(result.cards.length)
    } catch (e) {
      if (isResidentLimit(e)) {
        useStore.getState().setLimitWall(true)
        onClose()
        return
      }
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
    <Modal size="xl" className="sm:max-w-[820px]" onClose={() => !busy && onClose()}>
      <>
        {repoReview ? (
          <>
            <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row sm:gap-6">
              <div className="flex flex-col gap-[5px]">
                <ModalEyebrow>Review before import</ModalEyebrow>
                <ModalTitle>Import the design system</ModalTitle>
              </div>
              <Badge shape="pill">
                {repoReview.connection.repo}@{repoReview.connection.branch}
              </Badge>
            </div>
            <ModalLede>
              {repoReview.manifest.framework ? `A ${repoReview.manifest.framework} app. ` : ''}Doop distills the repo's
              design system into a style guide pinned to this canvas — every agent follows it from then on. Each
              component or page you pick becomes a card on the board: Doop sketches it from the source and lands it as a
              frame. Whole pages are optional.
            </ModalLede>
            <CheckboxCard
              checked={extractSystem}
              disabled={!!busy}
              onChange={setExtractSystem}
              title="Extract the design system into a style guide"
              description="Palette, type and spacing from the repo's theme — pinned to the canvas, followed by every agent."
            />
            <SelectionBar
              className="mt-4"
              count={repoSelected.size}
              total={visibleScreens.length}
              actions={
                <>
                  <SelectionBarAction
                    disabled={!!busy}
                    onClick={() => setRepoSelected(new Set(visibleScreens.map(screenKey)))}
                  >
                    Select all
                  </SelectionBarAction>
                  <SelectionBarAction disabled={!!busy} onClick={() => setRepoSelected(new Set())}>
                    Clear
                  </SelectionBarAction>
                </>
              }
            />
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
                  className="relative grid min-h-[58px] cursor-pointer grid-cols-[20px_24px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line bg-surface px-3 py-[9px] first:rounded-t-[10px] last:rounded-t-none last:rounded-b-[10px] last:border-b-0 hover:bg-paper"
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
                      'rounded-full px-2 py-[3px] text-micro font-medium',
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
                size="inline"
                className="mt-2 self-start text-ink-faint"
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
                      .replace(/^./, (c) => 'Import ' + c)}
              </Button>
            </ModalActions>
          </>
        ) : !discovery ? (
          <>
            {source === null ? (
              <SourcePicker onPick={setSource} sources={importSources()} />
            ) : source === 'website' ? (
              <>
                <ImportStepHeader icon={<WebIcon className="size-[22px] text-ink" />} title="Import a website" />
                <ModalLede>
                  Bring in one page, or discover a whole site and choose the pages you want before anything is added.
                </ModalLede>
                <Field className="mt-[22px]" label="Website URL" labelVariant="form" htmlFor="import-url">
                  <Input
                    id="import-url"
                    variant="well"
                    inputSize="lg"
                    className="font-mono"
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
                        if (wholeSite) void discover()
                        else void runSinglePage()
                      }
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
                      <em className="ml-[7px] rounded-full bg-paper-deep px-1.5 py-px text-micro font-medium not-italic text-ink-faint">
                        Optional
                      </em>
                    </>
                  }
                  description="Find public pages on the same site, then review the list."
                />
                {error && <p className={errorNoteCls}>{error}</p>}
                <ImportStepFooter
                  note="Snapshots stay editable and commentable. Scripts are removed."
                  onBack={() => setSource(null)}
                  backDisabled={!!busy}
                >
                  <Button
                    variant="primary"
                    disabled={!!busy || !url.trim()}
                    onClick={wholeSite ? discover : runSinglePage}
                  >
                    {busy === 'discovering'
                      ? 'Finding pages…'
                      : busy === 'importing'
                        ? 'Importing…'
                        : wholeSite
                          ? 'Discover pages'
                          : 'Import page'}
                  </Button>
                </ImportStepFooter>
              </>
            ) : source === 'liveapp' ? (
              <SyncKeysSection canvasId={canvasId} onBack={() => setSource(null)} />
            ) : source === 'github' ? (
              <GithubSection
                canvasId={canvasId}
                installPass={installPass}
                installError={installError}
                onReview={openRepoReview}
                onBack={() => setSource(null)}
              />
            ) : null}
          </>
        ) : (
          <>
            <div className="flex flex-col items-start justify-between gap-2.5 sm:flex-row sm:gap-6">
              <div className="flex flex-col gap-[5px]">
                <ModalEyebrow>Review before import</ModalEyebrow>
                <ModalTitle>Choose pages</ModalTitle>
              </div>
              <Badge shape="pill">{new URL(discovery.siteUrl).hostname}</Badge>
            </div>
            <ModalLede>
              {discovery.pages.length} {discovery.pages.length === 1 ? 'page' : 'pages'} found. Everything is selected
              by default; uncheck anything you don’t need.
            </ModalLede>
            <SelectionBar
              className="mt-5"
              count={selectedCount}
              total={discovery.pages.length}
              actions={
                <>
                  <SelectionBarAction
                    disabled={!!busy}
                    onClick={() => setSelected(new Set(discovery.pages.map((p) => p.url)))}
                  >
                    Select all
                  </SelectionBarAction>
                  <SelectionBarAction disabled={!!busy} onClick={() => setSelected(new Set())}>
                    Clear
                  </SelectionBarAction>
                </>
              }
            />
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
                    className="relative grid min-h-[58px] cursor-pointer grid-cols-[20px_24px_minmax(0,1fr)] items-center gap-2.5 border-b border-line bg-surface px-3 py-[9px] first:rounded-t-[10px] last:rounded-t-none last:rounded-b-[10px] last:border-b-0 hover:bg-paper"
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
                  : `Import ${selectedCount} ${selectedCount === 1 ? 'page' : 'pages'}`}
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
    authClient.updateUser({ name: clean }).then(
      () => {
        setName(clean)
        location.reload()
      },
      (err: unknown) => {
        console.error(err)
        setBusy(false)
      },
    )
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

function SyncKeysSection({ canvasId, onBack }: { canvasId: string; onBack: () => void }) {
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

  if (forbidden) {
    return (
      <>
        <ImportStepHeader icon={<RadioTowerIcon className="size-[22px] text-ink" />} title="Sync a live app" />
        <ModalLede>Sync keys are for canvas members — ask the owner for durable access.</ModalLede>
        <ImportStepFooter onBack={onBack} />
      </>
    )
  }
  return (
    <>
      <ImportStepHeader icon={<RadioTowerIcon className="size-[22px] text-ink" />} title="Sync a live app" />
      <ModalLede>
        For apps a crawler cannot reach: behind a login, a VPN, or on localhost. Paste one script tag and each screen
        people visit lands here as a frame, imported once.
      </ModalLede>
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
              className="resize-none border-line-soft bg-ink/[0.04] py-2 pl-2.5 pr-[84px] font-mono text-[11px] leading-normal text-ink-faint focus:border-line focus:text-ink focus:ring-0 md:text-[11px] [word-break:break-all]"
              readOnly
              rows={4}
              value={snippetFor(k.secret)}
              onFocus={(e) => e.target.select()}
            />
            <Button
              size="sm"
              className="absolute top-3 right-3.5 gap-1.5 bg-surface px-2.5 text-xs"
              onClick={() => copySnippet(k)}
            >
              {copiedId === k.id ? (
                'Copied!'
              ) : (
                <>
                  <CopyIcon className="size-3.5" />
                  Copy
                </>
              )}
            </Button>
          </div>
        </div>
      ))}
      <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row">
        <Field className="flex-1" label="App name" labelVariant="form" htmlFor="sync-app-name">
          <Input
            id="sync-app-name"
            variant="well"
            inputSize="lg"
            placeholder="Admin dashboard"
            value={name}
            disabled={busy}
            onChange={(e) => setAppName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
        </Field>
        <Button
          variant="primary"
          className="justify-center self-end sm:h-12"
          disabled={busy || !name.trim()}
          onClick={create}
        >
          Create key
        </Button>
      </div>
      <ol className="mt-3 flex flex-col divide-y divide-line-soft rounded-[10px] border border-line">
        {[
          ['Get a key for this canvas', 'The key only writes here. Revoke it from this screen at any time.'],
          ['Paste the script tag', 'One script tag in your app’s layout. Nothing else to install.'],
          ['Browse the app', 'Every new screen someone visits lands as a frame. Delete a frame to re-import it fresh.'],
        ].map(([title, detail], i) => (
          <li key={title} className="flex gap-3.5 px-3.5 py-3">
            <span className="font-mono text-[11px] leading-[1.6] text-ink-faint">0{i + 1}</span>
            <span className="min-w-0">
              <b className="block text-[13.5px] font-semibold tracking-[-0.012em]">{title}</b>
              <span className="text-[12.5px] leading-[1.45] text-ink-soft">{detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <ImportStepFooter
        note="Visible page content uploads to Doop as static HTML. Input values are dropped; mark anything sensitive with data-doop-mask."
        onBack={onBack}
      />
    </>
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
  onBack,
}: {
  canvasId: string
  installPass: string | null
  installError: string | null
  onReview: (connection: GithubConnectionInfo, manifest: RepoManifest) => void
  onBack: () => void
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

  if (forbidden) {
    return (
      <>
        <ImportStepHeader icon={<GithubIcon width={22} height={22} />} title="Connect a GitHub repo" />
        <ModalLede>Repo connections are for canvas members — ask the owner for durable access.</ModalLede>
        <ImportStepFooter onBack={onBack} />
      </>
    )
  }
  return (
    <>
      <ImportStepHeader icon={<GithubIcon width={22} height={22} />} title="Connect a GitHub repo" />
      <ModalLede>
        Doop reads the repo&rsquo;s routing conventions and lists its screens for review. Nothing lands until you pick.
      </ModalLede>
      <div className="mt-[22px] flex flex-col gap-2.5">
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
          <Button variant="primary" className="justify-center self-start" disabled={!!busy} onClick={startInstall}>
            {busy === 'connecting' ? 'Opening GitHub…' : 'Connect GitHub'}
          </Button>
        )}
        {appEnabled && !showTokenForm && (
          <Button
            variant="bare"
            size="inline"
            className="self-start text-ink-faint"
            onClick={() => setShowTokenForm(true)}
          >
            paste a token instead
          </Button>
        )}
        {(!appEnabled || showTokenForm) && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col items-stretch gap-2 sm:flex-row">
              <Input
                variant="well"
                className="flex-1 font-mono text-[12px]"
                placeholder="owner/repository"
                value={repo}
                disabled={!!busy}
                onChange={(e) => {
                  setRepo(e.target.value)
                  setError(null)
                }}
              />
              <Input
                variant="well"
                className="flex-1 font-mono text-[12px]"
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
      <ImportStepFooter
        note={
          appEnabled
            ? 'Access is scoped to the repos you pick and revocable on GitHub.'
            : 'A fine-grained, read-only token — it never leaves the server.'
        }
        onBack={onBack}
        backDisabled={!!busy}
      />
    </>
  )
}

/* The canvas title doubles as its rename field. */
function CanvasName() {
  const canvas = useStore((s) => s.canvas)
  return (
    <TopBarTitle
      pill
      loading={!canvas}
      value={canvas?.name ?? ''}
      onCommit={(name) => {
        if (!canvas) return
        api.renameCanvas(canvas.id, name).catch(console.error)
        useStore.getState().renameCanvasLocal(name)
      }}
    />
  )
}
