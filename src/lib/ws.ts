import type { ClientMessage, ServerMessage } from '../../shared/types'
import { isPeerViewport } from '../../shared/viewport'
import { roleAllows } from '../../shared/canvasRole'
import { canvasPages, framePageId } from '../../shared/pages'
import { getIdentity } from './identity'
import { pageReady } from './pages'
import { useStore } from './store'
import { noteTheirSave } from './theirSaves'

let socket: WebSocket | null = null
let currentCanvasId: string | null = null
/* joined without a session, as a guest on a link-shared canvas */
let joinedAsGuest = false
let retryTimer: number | null = null
/* the server build this page first connected under; survives reconnects */
let loadedBuild: string | null = null
/* the socket has had its `init`: pages may be asked for on it */
let joined = false
/* pages asked for with `page:load` on this socket and not answered yet */
const requested = new Set<string>()
/* pages something waits on (`loadPages`), counted: asked for again on a new socket */
const awaited = new Map<string, number>()
/* frames on screen besides the editor's page (a prototype's screens), per `showFrames` */
const shownFrames = new Map<number, readonly string[]>()
let showCount = 0
/* the shown pages last told to the room (`pages:shown`) on this socket */
let announcedShown: string | null = null
/* how long a page that could not be read waits before it is asked for again */
const PAGE_RETRY_MS = 2000
/* how long `loadPages` waits for the room before it gives up */
const PAGE_WAIT_MS = 30_000

export function connect(canvasId: string, guest = false) {
  currentCanvasId = canvasId
  joinedAsGuest = guest
  /* a fresh attempt for a (possibly different) id — any not-found from a
     previous canvas must not leak into this one */
  useStore.getState().setCanvasNotFound(false)
  open()
}

export function disconnect() {
  currentCanvasId = null
  if (retryTimer) window.clearTimeout(retryTimer)
  socket?.close()
  socket = null
}

export function sendWs(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

function open() {
  if (!currentCanvasId) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const s = new WebSocket(`${proto}://${location.host}/ws`)
  socket = s
  const canvasId = currentCanvasId

  s.onopen = () => {
    if (socket !== s) return
    const { clientId, name } = getIdentity()
    joined = false
    announcedShown = null
    requested.clear()
    /* join first: flipping `connected` makes the Stage announce its camera,
       and the server drops anything sent before the socket has a canvas */
    sendWs({
      type: 'join',
      canvasId,
      clientId,
      name,
      kind: 'user',
      pagesOnDemand: true,
      composesFrames: true,
      ...openingPage(canvasId),
    })
    useStore.getState().setConnected(true)
  }

  s.onmessage = (ev) => {
    if (socket !== s) return
    let msg: ServerMessage
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    handle(msg)
  }

  s.onclose = (ev) => {
    /* a superseded socket must not trigger reconnects */
    if (socket !== s) return
    useStore.getState().setConnected(false)
    if (joinedAsGuest && (ev.code === 4401 || ev.code === 4403)) {
      /* a guest may not look (any more): App swaps in the sign-in form at
         this same URL, rather than reloading into the same refusal */
      currentCanvasId = null
      useStore.getState().setSignInRequired(true)
      return
    }
    if (ev.code === 4401) {
      /* session expired or missing — reload lands on the sign-in page */
      currentCanvasId = null
      location.reload()
      return
    }
    if (ev.code === 4403) {
      /* the owner locked this canvas — retrying would loop forever */
      currentCanvasId = null
      location.href = '/'
      return
    }
    if (ev.code === 4404) {
      /* no such canvas — a typo'd id, or one that was just deleted. Stop
         retrying (there is nothing to reconnect to) and let CanvasPage show
         a not-found screen instead of an unresponsive, empty canvas UI. */
      currentCanvasId = null
      useStore.getState().setCanvasNotFound(true)
      return
    }
    if (currentCanvasId) {
      retryTimer = window.setTimeout(open, 1200)
    }
  }
}

/** What the join names for the server to send whole: the page shown, on a
 *  rejoin, else the frame or page the URL links (the server picks the page the
 *  way the store's `setCanvas` does). */
function openingPage(canvasId: string): { pageId?: string; frameId?: string } {
  const s = useStore.getState()
  if (s.canvas?.id === canvasId && s.activePageId) return { pageId: s.activePageId }
  const params = new URLSearchParams(location.search)
  const pageId = params.get('page')
  const frameId = params.get('frame')
  return { ...(pageId ? { pageId } : {}), ...(frameId ? { frameId } : {}) }
}

/** Ask the room for a page whose frames' HTML is not here (or is stale). */
function requestPage(pageId: string) {
  const s = useStore.getState()
  if (!joined || !s.canvas || !s.stalePages[pageId] || requested.has(pageId)) return
  requested.add(pageId)
  sendWs({ type: 'page:load', pageId })
}

/** The pages on screen: the editor's page, and the pages of the frames shown
 *  elsewhere (`showFrames`). The room keeps their HTML in memory. */
function shownPageIds(): string[] {
  const { canvas, activePageId } = useStore.getState()
  if (!canvas) return []
  const pages = new Set<string>(activePageId ? [activePageId] : [])
  for (const frameIds of shownFrames.values()) {
    for (const frameId of frameIds) {
      const frame = canvas.frames.find((candidate) => candidate.id === frameId)
      if (frame) pages.add(framePageId(canvas, frame))
    }
  }
  return [...pages].sort()
}

/** Tell the room which pages are on screen, when that changed. */
function announceShown(pageIds: readonly string[]) {
  const key = pageIds.join('\n')
  if (!joined || key === announcedShown) return
  announcedShown = key
  sendWs({ type: 'pages:shown', pageIds: [...pageIds] })
}

/** The pages on screen, and the ones something waits on. */
function requestWantedPages() {
  const shown = shownPageIds()
  announceShown(shown)
  for (const pageId of shown) requestPage(pageId)
  for (const pageId of awaited.keys()) requestPage(pageId)
}

useStore.subscribe((state, previous) => {
  /* a shown frame may move to another page */
  const moved = shownFrames.size > 0 && state.canvas !== previous.canvas
  if (moved || state.activePageId !== previous.activePageId || state.stalePages !== previous.stalePages)
    requestWantedPages()
})

/** Keep these frames' pages here and current while they are on screen outside
 *  the editor's page (a prototype's screens): asked for whenever they are not
 *  here, again after a failed read, and kept in the room's memory. Returns the
 *  function that takes them off screen. */
export function showFrames(frameIds: readonly string[]): () => void {
  const id = ++showCount
  shownFrames.set(id, frameIds)
  requestWantedPages()
  return () => {
    shownFrames.delete(id)
    requestWantedPages()
  }
}

/** Resolve once every one of these pages has its frames' HTML here, asking
 *  the room for the ones that do not; rejects if the room does not answer in
 *  time. For work on frames that may be on a page this browser has not
 *  opened: an export, an undo. */
export function loadPages(pageIds: readonly string[]): Promise<void> {
  return waitForPages(() => pageIds)
}

/** `loadPages` for the pages these frames are on, followed as they move: it
 *  resolves once each frame's current page is here, and rejects if one is
 *  deleted or the canvas changes meanwhile. A frame not on the canvas is left out. */
export function loadFramePages(frameIds: readonly string[]): Promise<void> {
  const { canvas } = useStore.getState()
  if (!canvas) return Promise.resolve()
  const ids = frameIds.filter((id) => canvas.frames.some((frame) => frame.id === id))
  return waitForPages(() => {
    const current = useStore.getState().canvas
    if (current?.id !== canvas.id) return new Error('The canvas changed.')
    const pages = new Set<string>()
    for (const id of ids) {
      const frame = current.frames.find((candidate) => candidate.id === id)
      if (!frame) return new Error('The frame was deleted.')
      pages.add(framePageId(current, frame))
    }
    return [...pages]
  })
}

/** Wait until the pages `wanted` names (asked again on every store change)
 *  are all here, asking the room for them meanwhile; an Error from `wanted`
 *  ends the wait with it. */
function waitForPages(wanted: () => readonly string[] | Error): Promise<void> {
  let held: readonly string[] = []
  const hold = (pageIds: readonly string[]) => {
    for (const pageId of pageIds) awaited.set(pageId, (awaited.get(pageId) ?? 0) + 1)
    for (const pageId of held) {
      const left = (awaited.get(pageId) ?? 1) - 1
      if (left > 0) awaited.set(pageId, left)
      else awaited.delete(pageId)
    }
    held = pageIds
  }
  /* 'ready', the reason waiting stopped, or the pages still waited on */
  const check = (): 'ready' | Error | readonly string[] => {
    const pageIds = wanted()
    if (pageIds instanceof Error) return pageIds
    return pageIds.every((pageId) => pageReady(useStore.getState(), pageId)) ? 'ready' : pageIds
  }
  const first = check()
  if (first === 'ready') return Promise.resolve()
  if (first instanceof Error) return Promise.reject(first)
  hold(first)
  requestWantedPages()
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      window.clearTimeout(timer)
      unsubscribe()
      hold([])
    }
    const timer = window.setTimeout(() => {
      done()
      reject(new Error('The page did not load.'))
    }, PAGE_WAIT_MS)
    const unsubscribe = useStore.subscribe(() => {
      const state = check()
      if (state === 'ready') {
        done()
        resolve()
      } else if (state instanceof Error) {
        done()
        reject(state)
      } else if (state.join('\n') !== held.join('\n')) {
        hold(state)
        requestWantedPages()
      }
    })
  })
}

function handle(msg: ServerMessage) {
  const s = useStore.getState()
  const me = getIdentity().clientId
  switch (msg.type) {
    case 'init':
      /* a reconnect that lands on a different build means this page is
         running a stale bundle — offer a reload instead of forcing one,
         so in-progress work is never yanked away */
      if (msg.serverBuild !== 'dev') {
        if (loadedBuild === null) loadedBuild = msg.serverBuild
        else if (loadedBuild !== msg.serverBuild) s.setUpdateReady(true)
      }
      {
        const firstJoin = s.canvas?.id !== msg.canvas.id
        /* a server from before page loading sends every page whole */
        s.setCanvas(msg.canvas, msg.loadedPageIds ?? canvasPages(msg.canvas).map((page) => page.id))
        /* drops a tool the role does not allow, e.g. on a rejoin after the
         owner turned the link to view-only */
        s.setRole(msg.canvas.role ?? 'edit')
        /* someone who cannot edit came to look: they start on the Hand tool,
         the way Figma opens a file for a viewer. A reconnect keeps their pick. */
        if (firstJoin && !roleAllows(msg.canvas.role ?? 'edit', 'edit')) s.setTool('hand')
      }
      s.setPresences(msg.presences)
      s.setActivity(msg.activity)
      s.setTasks(msg.tasks)
      s.setFeedback(msg.feedback)
      s.setComments(msg.comments)
      s.setDecisions(msg.decisions)
      s.setProposals(msg.proposals)
      joined = true
      requestWantedPages()
      break
    case 'page:frames':
      requested.delete(msg.pageId)
      s.setPageFrames(msg.pageId, msg.frames)
      break
    case 'page:dropped':
      s.setPageStale(msg.pageId)
      break
    case 'page:failed':
      /* its storage is away for now: asked again while it is still the one shown */
      window.setTimeout(() => {
        requested.delete(msg.pageId)
        requestWantedPages()
      }, PAGE_RETRY_MS)
      break
    case 'role':
      s.setRole(msg.role)
      break
    case 'presence:join':
      if (msg.presence.clientId !== me) s.upsertPresence(msg.presence)
      break
    case 'presence:leave':
      s.removePresence(msg.clientId)
      break
    case 'cursor':
      s.setCursor(msg.clientId, msg.x, msg.y)
      break
    case 'viewport':
      if (isPeerViewport(msg.viewport)) s.setPeerViewport(msg.clientId, msg.viewport)
      break
    case 'editing':
      s.setEditing(msg.clientId, msg.frameId)
      break
    case 'status':
      s.setStatus(msg.clientId, msg.status)
      break
    case 'task':
      s.upsertTask(msg.task)
      break
    case 'feedback':
      s.upsertFeedback(msg.feedback)
      break
    case 'comment':
      s.upsertComment(msg.comment)
      break
    case 'frame:drag':
      s.patchFrameLocal(msg.frameId, {
        x: msg.x,
        y: msg.y,
        width: msg.width,
        height: msg.height,
        ...(msg.rotation !== undefined ? { rotation: msg.rotation } : {}),
      })
      break
    case 'frame:created':
      s.upsertFrame(msg.frame)
      if (msg.actor.clientId !== me) noteTheirSave(msg.frame.id, msg.frame.updatedAt)
      if (msg.actor.clientId !== me) s.flash(msg.frame.id, msg.actor.color)
      break
    case 'frame:updated':
      s.upsertFrame(msg.frame)
      if (msg.actor.clientId !== me) noteTheirSave(msg.frame.id, msg.frame.updatedAt)
      /* during a live stream the marching border replaces per-chunk flashes */
      if (msg.actor.clientId !== me && !s.streams[msg.frame.id]) s.flash(msg.frame.id, msg.actor.color)
      break
    case 'frame:streaming':
      s.setStream(msg.frameId, msg.active ? msg.actor : null)
      break
    case 'frame:deleted':
      s.removeFrame(msg.frameId)
      break
    case 'canvas:pages':
      s.setPages(msg.pages)
      break
    case 'guide':
      s.setGuideLocal(msg.id, msg.guide)
      break
    case 'canvas:renamed':
      s.renameCanvasLocal(msg.name)
      break
    case 'canvas:sharing-closed':
      s.closeSharingLocal()
      break
    case 'component':
      s.setComponentLocal(msg.id, msg.component)
      break
    case 'library':
      s.bumpLibrary()
      break
    case 'guidelines':
      s.setGuidelineLocal(msg.name, msg.doc)
      break
    case 'tokens':
      s.setTokensLocal(msg.tokens, msg.themes)
      break
    case 'team':
      s.setTeamLocal(msg.team)
      break
    case 'reference':
      s.setReferenceLocal(msg.id, msg.reference)
      break
    case 'decision':
      s.pushDecision(msg.decision)
      break
    case 'proposal':
      s.upsertProposal(msg.proposal)
      break
    case 'canvas:deleted':
      /* the room only receives this for the canvas it's viewing */
      location.href = '/'
      break
    case 'activity':
      s.pushActivity(msg.item)
      break
  }
}
