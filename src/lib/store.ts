import { create } from 'zustand'
import { canvasPages, framePageId } from '../../shared/pages'
import { openingPageId } from './pageLink'
import { sortByStack } from '../../shared/frameStack'
import { sourceOf, type SharedComponent } from '../../shared/frameCompose'
import type { DesignToken } from '../../shared/designTokens'
import type { AgentRole } from '../../shared/agents'
import type {
  ActivityItem,
  AgentTask,
  ClientCanvas,
  CanvasGuide,
  DesignDecision,
  ElementComment,
  Frame,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  PeerViewport,
  Presence,
  TaskFeedback,
  WireCanvas,
  WireFrame,
} from '../../shared/types'
import { roleAllows, type CanvasRole } from '../../shared/canvasRole'
import type { SnapGuide } from './snap'
import { isDrawingTool, type Tool } from './tools'
import { setOutlines } from './frameBridge'
import { readViewOptions, writeViewOptions, type ViewOption, type ViewOptions } from './viewOptions'

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export type PanelTab = 'tasks' | 'comments' | 'activity' | 'memory'

/** A send from the Agents tab composer: in flight, or how the last one
 *  ended. Lives in the store because the composer unmounts with its tab and
 *  a failure must still be there when the tab comes back. */
export type ComposerSend =
  | { canvasId: string; status: 'busy' }
  | { canvasId: string; status: 'sent'; at: number }
  | { canvasId: string; status: 'error'; message: string; at: number }

/** Who is streaming into a frame: enough to name, colour and identify them. */
export type StreamActor = { name: string; color: string; agentKey?: string }

export interface State {
  canvas: ClientCanvas | null
  presences: Record<string, Presence>
  cursors: Record<string, { x: number; y: number }>
  /** peers' cameras, keyed by clientId. Kept out of `presences` on purpose:
   *  a camera moves many times a second, and a new presences map re-renders
   *  everything that reads the roster (every FrameView among them). */
  peerViewports: Record<string, PeerViewport>
  activity: ActivityItem[]
  /** agent task history (newest first) — every set_status becomes a task */
  tasks: AgentTask[]
  /** human feedback on tasks (newest first) */
  feedback: TaskFeedback[]
  /** element-anchored comments (newest first) */
  comments: ElementComment[]
  /** design decisions captured into Memory (newest first) */
  decisions: DesignDecision[]
  /** distiller rule proposals (newest first) */
  proposals: MemoryProposal[]
  /** which tab the side panel shows — in the store so a Memory-suggestion
   *  toast anywhere in the app can jump straight to the Memory tab */
  panelTab: PanelTab
  /** every selected frame, in selection order — marquee and ⇧-click build
   *  this up; a plain click collapses it to one */
  selectedIds: string[]
  /** the primary selection (the last frame added) — what the Inspector,
   *  presence, and the flow overlay follow */
  selectedId: string | null
  /** the active canvas tool in the bottom toolbar */
  tool: Tool
  /** space bar held: the stage pans on drag instead of drawing a marquee */
  panMode: boolean
  /** a file is being dragged over the page: every frame keeps its shield up,
   *  so a drop over a frame being edited still reaches the canvas */
  fileDragging: boolean
  /** the Inspector panel is showing — opened by clicking a frame's name, not
   *  by mere selection, so clicking around a frame doesn't slide the panel in */
  inspectorOpen: boolean
  /** the Page panel (the page's own settings) has the properties slot while
   *  nothing is selected; opened from the rail, it stays until closed */
  pagePanelOpen: boolean
  /** open frame context menu; deferPanel hides the Inspector until it closes
   *  (right-click selecting a frame must not slide a panel in under the menu) */
  ctxMenu: { frameId: string; deferPanel: boolean } | null
  /** the element outlined inside the selected frame — a click on the frame
   *  surface and a click on a Layers row both land here, so the outline in
   *  the frame and the highlighted row stay in step */
  selectedElement: { frameId: string; selector: string } | null
  /** every element picked in `selectedElement`'s frame, the primary last:
   *  ⇧-click on the surface or ⌘/Ctrl-click in the Layers rail adds to it
   *  (⇧-click there replaces it with a range). Read it through
   *  `pickedSelectors`, which ignores a list that no longer
   *  holds the primary */
  selectedElements: string[]
  /** the element under the pointer in the Layers panel — its frame outlines
   *  it on the canvas, the same as a hover over the frame itself */
  hoveredLayer: { frameId: string; selector: string } | null
  /** a comment pin being dragged: its thread root and where the pointer
   *  holds it, in world px — CanvasComments draws the ghost there, above
   *  every frame, while the pin itself hides */
  commentDrag: { id: string; x: number; y: number } | null
  /** the element properties panel is showing — opened by a pick (a click on
   *  the frame surface or a Layers row) unless `elementPanelClosed`, it then
   *  follows whatever element is selected until it is closed. Picks go through
   *  `panelOnPick`, never a bare `setElementPanelOpen(true)` */
  elementPanelOpen: boolean
  /** the person closed the element panel: picks no longer open it until they
   *  open it again from the rail. Per browser, so it sticks across visits */
  elementPanelClosed: boolean
  /** the Layers rail is showing (desktop); the choice sticks across visits */
  layersOpen: boolean
  /** which face the Layers panel shows: the layer tree, or the design tokens */
  layersTab: 'layers' | 'components' | 'tokens'
  /** ⌘. — every panel and toolbar is off screen, leaving only the canvas.
   *  A plain overlay flag: the panels' own open/closed state is untouched
   *  underneath, so toggling back shows exactly what was open before */
  uiHidden: boolean
  /** Prototype mode: the element panel shows its Interactions tab and the
   *  stage draws each interaction's connector to its target frame */
  prototypeMode: boolean
  viewport: Viewport
  /** live alignment guide lines while a frame drag is snapped to a neighbour */
  snapGuides: SnapGuide[]
  /** ⇧R — the rulers along the stage's top and left edges; the choice sticks */
  rulers: boolean
  /** the pixel grid, other people's cursors and the comment pins; the choice sticks */
  viewOptions: ViewOptions
  /** the ruler guide clicked last, which Delete removes */
  selectedGuideId: string | null
  /** ⌘Y — frames drawn as outlines, fills off; nothing is saved */
  outlines: boolean
  /** ⌥L asks the Layers panel to fold every row; it watches the stamp */
  layersCollapseAt: number
  connected: boolean
  /** the join for the current canvasId was refused: no such canvas (deleted,
   *  or the id in the URL was never one) — CanvasPage shows a not-found
   *  screen instead of an unusable, unresponsive canvas UI */
  canvasNotFound: boolean
  /** a signed-out guest's join was refused (a private canvas, or the owner
   *  turned the link off mid-visit) — App shows the sign-in form instead */
  signInRequired: boolean
  /** a reconnect revealed a newer client bundle on the server — offer a reload */
  updateReady: boolean
  /** frameId -> color, set briefly when a remote actor updates a frame */
  flashes: Record<string, { color: string; at: number }>
  /** frameId -> actor currently streaming a design into it */
  /** frame id -> the agent streaming into it (agentKey: shared/agentIdentity.ts) */
  streams: Record<string, StreamActor>
  /** a transient toast — in the store so long actions fired from surfaces
   *  that close at once (a context menu) can still report back. A `busy`
   *  notice (an export in flight) stays up until the next notice replaces it. */
  notice: { text: string; at: number; busy?: boolean } | null
  /** the free-tier wall is showing — in the store so any surface that hits
   *  the resident-task limit (board, prompt bar, element comment) can raise it */
  limitWall: boolean
  /** bumped whenever the allowance could have changed (a model account was
   *  connected or dropped) so every meter on screen re-reads it */
  allowanceVersion: number
  /** a request for the Stage to glide the camera to a frame — the prompt bar
   *  raises it so a first deliverable streams in on-screen, never off-canvas */
  flyTo: { frameId: string; at: number } | { point: { x: number; y: number }; at: number } | null
  /** a request for the frame holding this comment thread to open its pin —
   *  the Comments panel raises it; the FrameView that owns the root consumes it */
  threadRequest: { id: string; at: number } | null
  /** when the "Design it" composer in the Agents tab was last asked to take
   *  focus (⌘/) — a timestamp, so a composer that mounts long after an old
   *  request does not grab the keyboard */
  composerFocusAt: number
  /** the composer's unsent text per canvas — collapsing the panel or
   *  switching tabs unmounts the field and must not eat the draft */
  composerDrafts: Record<string, string>
  composerSend: ComposerSend | null
  /** clientId of the peer whose camera this one is tracking (Figma-style
   *  follow); any camera move of our own lets go. An agent is followed to the
   *  frame it works on, and stays followed while it is idle and out of the
   *  presence roster: its clientId (`agent:<name>`) is the same when it comes back */
  following: string | null
  /** the agent being followed, as last seen, so the follow pill can name it
   *  while it is idle and not in `presences` */
  followedAgent: Presence | null

  activePageId: string | null
  /** `keepFollow`: the follow loop itself moving to its leader's page, so the
   *  follow stays on (any other page switch lets go, as a camera move does) */
  /** pages whose frames' HTML is not here, or not current: the room's `init`
   *  left them out, or sent one of their frames without its HTML since. Their
   *  frames carry their metadata, and their HTML is '' or an old copy, until
   *  `page:frames` brings the page (pageReady, src/lib/pages.ts). Every other
   *  page, one made after the join included, the room keeps current here */
  stalePages: Record<string, true>
  setActivePage(id: string, opts?: { keepFollow?: boolean }): void
  setPages(pages: import('../../shared/types').CanvasPageInfo[], canvasId?: string): void
  /** paint one page locally (this client's own edit, before or after its save) */
  setPageBackgroundLocal(pageId: string, background: string | null): void
  /** `loadedPageIds`: the pages whose frames carry their HTML (every other
   *  page is stale). Left out, a new canvas counts as whole and the same canvas
   *  keeps the pages it had. A frame without `html` keeps the copy here, or ''. */
  setCanvas(c: ClientCanvas | WireCanvas | null, loadedPageIds?: readonly string[]): void
  /** a page's frames whole, answering `page:load`: the page is loaded from now on */
  setPageFrames(pageId: string, frames: Frame[]): void
  /** the room stopped keeping this page current here (`page:dropped`): read it again before it shows */
  setPageStale(pageId: string): void
  setConnected(v: boolean): void
  setCanvasNotFound(v: boolean): void
  setSignInRequired(v: boolean): void
  setUpdateReady(v: boolean): void
  setPresences(list: Presence[]): void
  upsertPresence(p: Presence): void
  removePresence(clientId: string): void
  setCursor(clientId: string, x: number, y: number): void
  setEditing(clientId: string, frameId: string | null): void
  setPeerViewport(clientId: string, viewport: PeerViewport): void
  /** start (clientId) or stop (null) following a peer's camera */
  setFollowing(clientId: string | null): void
  /** camera write that keeps the follow alive — only the follow loop uses it */
  setViewportFollowing(v: Viewport): void
  setStatus(clientId: string, status: string | null): void
  setActivity(items: ActivityItem[]): void
  pushActivity(item: ActivityItem): void
  setTasks(tasks: AgentTask[]): void
  upsertTask(task: AgentTask): void
  setFeedback(feedback: TaskFeedback[]): void
  upsertFeedback(fb: TaskFeedback): void
  setComments(comments: ElementComment[]): void
  upsertComment(c: ElementComment): void
  /** a frame from the room; one without `html` keeps what is here, and a
   *  loaded page it lands on is loaded no more until it is read again */
  upsertFrame(f: Frame | WireFrame): void
  patchFrameLocal(frameId: string, patch: Partial<Frame>): void
  removeFrame(frameId: string): void
  renameCanvasLocal(name: string): void
  closeSharingLocal(): void
  /** upsert (doc set) or remove (doc null) a style guide on the open canvas */
  setGuidelineLocal(name: string, doc: GuidelineDoc | null): void
  /** a component changed in the room, or was deleted (null) */
  setComponentLocal(id: string, component: import('../../shared/components').WireComponentDef | null): void
  /** counts what the workspace's libraries have published or withdrawn since this
   *  page loaded: the Components panel reads its library again when it moves */
  libraryTick: number
  bumpLibrary(): void
  /** replace the open canvas's design tokens and themes (the room sends the whole list) */
  setTokensLocal(tokens: DesignToken[], themes: string[]): void
  /** the canvas's Doop Agent team changed (a room `team` message) */
  setTeamLocal(team: AgentRole[]): void
  /** pin (reference set) or unpin (null) a Memory reference on the open canvas */
  setReferenceLocal(id: string, reference: MemoryReference | null): void
  setDecisions(decisions: DesignDecision[]): void
  pushDecision(decision: DesignDecision): void
  setProposals(proposals: MemoryProposal[]): void
  upsertProposal(proposal: MemoryProposal): void
  setPanelTab(tab: PanelTab): void
  /** show `text` as a toast for a few seconds — or, with `busy`, with a
   *  spinner until the next notice replaces it */
  pushNotice(text: string, options?: { busy?: boolean }): void
  setLimitWall(v: boolean): void
  allowanceChanged(): void
  requestFlyTo(frameId: string): void
  /** glide the camera to a world point at the current zoom (a peer's cursor) */
  requestFlyToPoint(x: number, y: number): void
  /** open the pin of this comment thread on its frame (the Comments panel) */
  requestOpenThread(commentId: string): void
  /** the owning frame has opened the thread */
  clearThreadRequest(): void
  /** put the keyboard in the Agents tab's composer (the page opens the panel
   *  on that tab first) */
  requestComposerFocus(): void
  setComposerDraft(canvasId: string, text: string): void
  setComposerSend(send: ComposerSend | null): void
  select(id: string | null): void
  /** ⇧-click: add the frame to the selection, or drop it if already in */
  toggleSelect(id: string): void
  /** marquee: replace the selection with these frames */
  selectMany(ids: string[]): void
  /** picks a tool the caller's role allows; drawing needs edit, the
   *  Comment tool needs comment — anything else is ignored */
  setTool(tool: Tool): void
  /** the share link changed under an open canvas: the caller's role now */
  setRole(role: CanvasRole): void
  setPanMode(v: boolean): void
  setFileDragging(v: boolean): void
  setInspectorOpen(v: boolean): void
  setPagePanelOpen(v: boolean): void
  openCtxMenu(menu: { frameId: string; deferPanel: boolean }): void
  closeCtxMenu(): void
  setSelectedElement(el: { frameId: string; selector: string } | null): void
  setHoveredLayer(el: { frameId: string; selector: string } | null): void
  /** ask the Layers panel to rename a frame or layer, opening the panel */
  setCommentDrag(drag: { id: string; x: number; y: number } | null): void
  /** an element picked by the user — on the frame surface or in the Layers
   *  rail: selects it and opens its properties panel; picking nothing clears
   *  the selection and closes the panel */
  pickElement(el: { frameId: string; selector: string } | null, only?: boolean): void
  /** add the element to the picked set of its frame, or drop it from the
   *  set; an element in another frame starts a new set */
  toggleElement(el: { frameId: string; selector: string }): void
  /** replace the picked set with these elements of one frame, the last
   *  the primary (⌘A inside a frame, a keyboard walk of the tree) */
  pickElements(frameId: string, selectors: string[]): void
  setElementPanelOpen(v: boolean): void
  /** the person closed the element panel: it stays closed across picks */
  closeElementPanel(): void
  /** the person opened the element panel again: picks open it once more */
  openElementPanel(): void
  setLayersOpen(v: boolean): void
  setLayersTab(tab: 'layers' | 'components' | 'tokens'): void
  toggleUiHidden(): void
  setPrototypeMode(on: boolean): void
  setViewport(v: Viewport): void
  setSnapGuides(guides: SnapGuide[]): void
  toggleRulers(): void
  toggleViewOption(name: ViewOption): void
  toggleOutlines(): void
  requestCollapseLayers(): void
  selectGuide(id: string | null): void
  /** add or move (guide set) or remove (null) a ruler guide on the open canvas */
  setGuideLocal(id: string, guide: CanvasGuide | null): void
  flash(frameId: string, color: string): void
  setStream(frameId: string, actor: StreamActor | null): void
}

const LAYERS_OPEN_KEY = 'doop:layers-open'
const ELEMENT_PANEL_CLOSED_KEY = 'doop:element-panel-closed'
const RULERS_KEY = 'doop:rulers'
/* longer than the slowest real export (Canva: render + verify, ~3 min) */
const BUSY_NOTICE_MAX_MS = 5 * 60_000

/** a per-browser on/off choice, stored as '1' / '0'; unset or unreadable is `fallback` */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* private mode: the choice just doesn't stick */
  }
}

/** ends a follow: the leader and, for an agent, its last-seen record */
const UNFOLLOW = { following: null, followedAgent: null }

/**
 * The server renders a frame again, with no write of it, when a component it uses changes
 * its markup: `html` and `rendered` move and `updatedAt` stays (the frame stores a reference
 * to the component, so nothing a save could conflict with changed). A copy of the frame that
 * left the server before that (a save's HTTP response overtaken by the room's message) has
 * the same `updatedAt` and the older rendering: it keeps its other fields and takes the
 * newer rendering this browser already holds.
 */
function newestRendering(incoming: Frame, held: Frame | undefined): Frame {
  if (!held || held.updatedAt !== incoming.updatedAt) return incoming
  if ((held.rendered ?? 0) <= (incoming.rendered ?? 0) || held.html === undefined) return incoming
  return { ...incoming, html: held.html, rendered: held.rendered }
}

/** A frame as the store keeps it: its source. What the canvas supplies to every frame
 *  (component stylesheets, token values) is composed in where a frame is shown
 *  (src/lib/frameCompose.ts), so a frame that arrives carrying those blocks (stored before
 *  lean storage, or sent by a server that still writes them) is taken without them. */
function asSource<F extends { html?: string }>(frame: F, components: readonly SharedComponent[] | undefined): F {
  if (typeof frame.html !== 'string') return frame
  const html = sourceOf(frame.html, components ?? [])
  return html === frame.html ? frame : { ...frame, html }
}

export const useStore = create<State>((set, get) => ({
  canvas: null,
  activePageId: null,
  stalePages: {},
  presences: {},
  cursors: {},
  peerViewports: {},
  activity: [],
  tasks: [],
  feedback: [],
  comments: [],
  decisions: [],
  proposals: [],
  panelTab: 'tasks',
  limitWall: false,
  allowanceVersion: 0,
  flyTo: null,
  followedAgent: null,
  threadRequest: null,
  composerFocusAt: 0,
  composerDrafts: {},
  composerSend: null,
  following: null,
  selectedIds: [],
  selectedId: null,
  tool: 'select',
  panMode: false,
  fileDragging: false,
  inspectorOpen: false,
  pagePanelOpen: false,
  ctxMenu: null,
  selectedElement: null,
  selectedElements: [],
  hoveredLayer: null,
  commentDrag: null,
  elementPanelOpen: false,
  elementPanelClosed: readFlag(ELEMENT_PANEL_CLOSED_KEY, false),
  layersOpen: readFlag(LAYERS_OPEN_KEY, true),
  layersTab: 'layers',
  uiHidden: false,
  prototypeMode: false,
  viewport: { x: 0, y: 0, zoom: 1 },
  snapGuides: [],
  rulers: readFlag(RULERS_KEY, false),
  viewOptions: readViewOptions(),
  selectedGuideId: null,
  outlines: false,
  layersCollapseAt: 0,
  connected: false,
  canvasNotFound: false,
  signInRequired: false,
  updateReady: false,
  notice: null,
  flashes: {},
  streams: {},

  setCanvas: (wire, loadedPageIds) =>
    set((s) => {
      const canvas: ClientCanvas | null = wire && {
        ...wire,
        frames: wire.frames.map((f) => withHtml(asSource(f, wire.components), s.canvas)),
      }
      return {
        /* the stage paints frames in array order: back to front */
        canvas: canvas && { ...canvas, frames: sortByStack(canvas.frames) },
        stalePages: !canvas
          ? {}
          : loadedPageIds
            ? Object.fromEntries(
                canvasPages(canvas)
                  .filter((page) => !loadedPageIds.includes(page.id))
                  .map((page) => [page.id, true as const]),
              )
            : canvas.id === s.canvas?.id
              ? s.stalePages
              : {},
        /* leaving a canvas (CanvasPage unmounts or its id changes) ends ⌘.
         hide-UI, so the next canvas never opens with its chrome gone; a
         re-join of the same canvas keeps it */
        uiHidden: canvas ? s.uiHidden : false,
        /* an agent follow outlives the agent's presence, not the canvas */
        ...(s.following && canvas?.id !== s.canvas?.id ? UNFOLLOW : {}),
        activePageId: canvas
          ? canvas.id === s.canvas?.id && canvasPages(canvas).some((p) => p.id === s.activePageId)
            ? s.activePageId
            : /* a canvas being opened starts on the page its URL asks for, so
               the first paint is already that page */
              openingPageId(canvas, typeof location === 'undefined' ? '' : location.search)
          : null,
      }
    }),
  setPageFrames: (pageId, frames) =>
    set((s) => {
      if (!s.canvas) return {}
      const components = s.canvas.components
      const fresh = new Map(
        frames.filter((f) => f.canvasId === s.canvas!.id).map((f) => [f.id, asSource(f, components)]),
      )
      const merged = s.canvas.frames.map((f) => fresh.get(f.id) ?? f)
      for (const f of s.canvas.frames) fresh.delete(f.id)
      return {
        canvas: { ...s.canvas, frames: sortByStack([...merged, ...fresh.values()]) },
        stalePages: withoutPage(s.stalePages, pageId),
      }
    }),
  setPageStale: (pageId) =>
    set((s) => {
      if (!s.canvas || s.stalePages[pageId] || !canvasPages(s.canvas).some((p) => p.id === pageId)) return {}
      return { stalePages: { ...s.stalePages, [pageId]: true as const } }
    }),
  setActivePage: (id, opts) =>
    set((s) => {
      if (!s.canvas || !canvasPages(s.canvas).some((p) => p.id === id) || s.activePageId === id) return {}
      return {
        activePageId: id,
        selectedId: null,
        selectedIds: [],
        selectedElement: null,
        elementPanelOpen: false,
        inspectorOpen: false,
        ctxMenu: null,
        ...(opts?.keepFollow ? {} : UNFOLLOW),
        snapGuides: [],
        selectedGuideId: null,
        viewport: { x: 0, y: 0, zoom: 1 },
      }
    }),
  setPageBackgroundLocal: (pageId, background) =>
    set((s) => {
      if (!s.canvas) return {}
      const pages = canvasPages(s.canvas).map((page) => {
        if (page.id !== pageId) return page
        const { background: _previous, ...rest } = page
        return background ? { ...rest, background } : rest
      })
      return { canvas: { ...s.canvas, pages } }
    }),
  setPages: (pages, canvasId) =>
    set((s) => {
      if (!s.canvas || (canvasId !== undefined && s.canvas.id !== canvasId)) return {}
      const firstId = canvasPages(s.canvas)[0]!.id
      const canvas = { ...s.canvas, pages, frames: s.canvas.frames.map((f) => ({ ...f, pageId: f.pageId ?? firstId })) }
      /* a deleted page takes its guides with it, as it does on the server */
      if (canvas.guides?.some((g) => !pages.some((p) => p.id === g.pageId)))
        canvas.guides = canvas.guides.filter((g) => pages.some((p) => p.id === g.pageId))
      const selectedGuideId = canvas.guides?.some((g) => g.id === s.selectedGuideId) ? s.selectedGuideId : null
      const activePageId = pages.some((p) => p.id === s.activePageId) ? s.activePageId : pages[0]!.id
      return {
        canvas,
        activePageId,
        selectedGuideId,
        ...(activePageId !== s.activePageId
          ? {
              selectedId: null,
              selectedIds: [],
              selectedElement: null,
              inspectorOpen: false,
              elementPanelOpen: false,
              ctxMenu: null,
              ...UNFOLLOW,
            }
          : {}),
      }
    }),
  setConnected: (connected) => set({ connected }),
  setCanvasNotFound: (canvasNotFound) => set({ canvasNotFound }),
  setSignInRequired: (signInRequired) => set({ signInRequired }),
  setUpdateReady: (updateReady) => set({ updateReady }),
  setPresences: (list) =>
    set((s) => ({
      presences: Object.fromEntries(list.map((p) => [p.clientId, p])),
      peerViewports: Object.fromEntries(list.flatMap((p) => (p.viewport ? [[p.clientId, p.viewport]] : []))),
      /* a fresh roster (new canvas, reconnect) without our leader ends the
         follow, unless the leader is an agent: it is only idle */
      ...(s.following && !list.some((p) => p.clientId === s.following)
        ? s.followedAgent?.clientId === s.following
          ? { followedAgent: s.presences[s.following] ?? s.followedAgent }
          : UNFOLLOW
        : {}),
    })),
  upsertPresence: (p) =>
    set((s) => ({
      presences: { ...s.presences, [p.clientId]: p },
      ...(p.viewport ? { peerViewports: { ...s.peerViewports, [p.clientId]: p.viewport } } : {}),
    })),
  removePresence: (clientId) =>
    set((s) => {
      const presences = { ...s.presences }
      const cursors = { ...s.cursors }
      const peerViewports = { ...s.peerViewports }
      delete presences[clientId]
      delete cursors[clientId]
      delete peerViewports[clientId]
      /* the person we were following left: nothing to track any more. An
         agent leaves the roster whenever it goes idle and is still followed,
         from where it was last seen */
      const leader =
        s.following !== clientId
          ? {}
          : s.followedAgent?.clientId === clientId
            ? { followedAgent: s.presences[clientId] ?? s.followedAgent }
            : UNFOLLOW
      return { presences, cursors, peerViewports, ...leader }
    }),
  setPeerViewport: (clientId, viewport) =>
    set((s) => (s.presences[clientId] ? { peerViewports: { ...s.peerViewports, [clientId]: viewport } } : {})),
  setFollowing: (following) => {
    const leader = following ? get().presences[following] : undefined
    const pageId = following ? get().peerViewports[following]?.pageId : undefined
    if (pageId) get().setActivePage(pageId)
    set({ following: leader || !following ? following : null, followedAgent: leader?.kind === 'agent' ? leader : null })
  },
  setViewportFollowing: (viewport) => set({ viewport }),
  setCursor: (clientId, x, y) => set((s) => ({ cursors: { ...s.cursors, [clientId]: { x, y } } })),
  setEditing: (clientId, frameId) =>
    set((s) => {
      const p = s.presences[clientId]
      if (!p) return {}
      return { presences: { ...s.presences, [clientId]: { ...p, activeFrameId: frameId } } }
    }),
  setStatus: (clientId, status) =>
    set((s) => {
      const p = s.presences[clientId]
      if (!p) return {}
      return { presences: { ...s.presences, [clientId]: { ...p, status: status ?? undefined } } }
    }),
  setActivity: (activity) => set({ activity }),
  pushActivity: (item) =>
    set((s) => (s.activity.some((a) => a.id === item.id) ? {} : { activity: [item, ...s.activity].slice(0, 100) })),
  setTasks: (tasks) => set({ tasks }),
  upsertTask: (task) =>
    set((s) => {
      const tasks = s.tasks.some((t) => t.id === task.id)
        ? s.tasks.map((t) => (t.id === task.id ? task : t))
        : [task, ...s.tasks].slice(0, 100)
      return { tasks }
    }),
  setFeedback: (feedback) => set({ feedback }),
  setComments: (comments) => set({ comments }),
  upsertComment: (c) =>
    set((s) => {
      const comments = s.comments.some((x) => x.id === c.id)
        ? s.comments.map((x) => (x.id === c.id ? c : x))
        : [c, ...s.comments].slice(0, 100)
      return { comments }
    }),
  upsertFeedback: (fb) =>
    set((s) => {
      const feedback = s.feedback.some((f) => f.id === fb.id)
        ? s.feedback.map((f) => (f.id === fb.id ? fb : f))
        : [fb, ...s.feedback].slice(0, 100)
      return { feedback }
    }),
  upsertFrame: (wire) =>
    set((s) => {
      if (!s.canvas || wire.canvasId !== s.canvas.id) return {}
      const f = newestRendering(
        withHtml(asSource(wire, s.canvas.components), s.canvas),
        s.canvas.frames.find((x) => x.id === wire.id),
      )
      const frames = sortByStack(
        s.canvas.frames.some((x) => x.id === f.id)
          ? s.canvas.frames.map((x) => (x.id === f.id ? f : x))
          : [...s.canvas.frames, f],
      )
      const pageId = framePageId(s.canvas, f)
      /* the room left the HTML out: this page's copy of the frame may be stale,
         so the page is read again before it shows */
      const stale = wire.html === undefined && !s.stalePages[pageId]
      const hidden = s.selectedIds.includes(f.id) && pageId !== s.activePageId
      return {
        canvas: { ...s.canvas, frames },
        ...(stale ? { stalePages: { ...s.stalePages, [pageId]: true as const } } : {}),
        ...(hidden
          ? {
              selectedIds: s.selectedIds.filter((id) => id !== f.id),
              selectedId: null,
              selectedElement: null,
              inspectorOpen: false,
              elementPanelOpen: false,
            }
          : {}),
      }
    }),
  patchFrameLocal: (frameId, patch) =>
    set((s) => {
      if (!s.canvas) return {}
      const local = asSource(patch, s.canvas.components)
      const frames = s.canvas.frames.map((f) => (f.id === frameId ? { ...f, ...local } : f))
      return { canvas: { ...s.canvas, frames: 'z' in patch ? sortByStack(frames) : frames } }
    }),
  removeFrame: (frameId) =>
    set((s) => {
      if (!s.canvas) return {}
      const selectedIds = s.selectedIds.filter((id) => id !== frameId)
      return {
        canvas: { ...s.canvas, frames: s.canvas.frames.filter((f) => f.id !== frameId) },
        selectedIds,
        /* losing the primary promotes the last surviving member, so a group
           never sits selected with nothing driving the Inspector/presence */
        selectedId: s.selectedId === frameId ? (selectedIds[selectedIds.length - 1] ?? null) : s.selectedId,
        /* an open Inspector must not silently retarget onto the promoted frame */
        inspectorOpen: s.selectedId === frameId ? false : s.inspectorOpen,
        ctxMenu: s.ctxMenu?.frameId === frameId ? null : s.ctxMenu,
      }
    }),
  renameCanvasLocal: (name) => set((s) => (s.canvas ? { canvas: { ...s.canvas, name } } : {})),
  closeSharingLocal: () =>
    set((s) =>
      s.canvas
        ? {
            canvas: {
              ...s.canvas,
              linkAccess: undefined,
              publishedAt: undefined,
              description: undefined,
              category: undefined,
            },
          }
        : {},
    ),
  setComponentLocal: (id, component) =>
    set((s) => {
      if (!s.canvas) return {}
      const others = (s.canvas.components ?? []).filter((def) => def.id !== id)
      return { canvas: { ...s.canvas, components: component ? [...others, component] : others } }
    }),
  libraryTick: 0,
  bumpLibrary: () => set((s) => ({ libraryTick: s.libraryTick + 1 })),
  setGuidelineLocal: (name, doc) =>
    set((s) => {
      if (!s.canvas) return {}
      const docs = (s.canvas.guidelines ?? []).filter((d) => d.name !== name)
      if (doc) {
        docs.push(doc)
        docs.sort((a, b) => a.name.localeCompare(b.name))
      }
      return { canvas: { ...s.canvas, guidelines: docs } }
    }),
  setTokensLocal: (tokens, themes) =>
    set((s) => (s.canvas ? { canvas: { ...s.canvas, tokens, tokenThemes: themes } } : {})),
  setTeamLocal: (team) => set((s) => (s.canvas ? { canvas: { ...s.canvas, team } } : {})),
  setReferenceLocal: (id, reference) =>
    set((s) => {
      if (!s.canvas) return {}
      const refs = (s.canvas.references ?? []).filter((r) => r.id !== id)
      if (reference) refs.unshift(reference)
      return { canvas: { ...s.canvas, references: refs } }
    }),
  setDecisions: (decisions) => set({ decisions }),
  pushDecision: (decision) =>
    set((s) => {
      /* upsert by id — the summarizer re-broadcasts the same decision with
         its generalized summary attached a moment after capture */
      const decisions = s.decisions.some((d) => d.id === decision.id)
        ? s.decisions.map((d) => (d.id === decision.id ? decision : d))
        : [decision, ...s.decisions].slice(0, 100)
      return { decisions }
    }),
  setProposals: (proposals) => set({ proposals }),
  upsertProposal: (proposal) =>
    set((s) => {
      const proposals = s.proposals.some((p) => p.id === proposal.id)
        ? s.proposals.map((p) => (p.id === proposal.id ? proposal : p))
        : [proposal, ...s.proposals].slice(0, 100)
      return { proposals }
    }),
  setPanelTab: (panelTab) => set({ panelTab }),
  pushNotice: (text, options) => {
    const busy = options?.busy === true
    const at = Date.now()
    set({ notice: { text, at, busy } })
    if (busy) {
      /* a backstop for a request that never settles (a stalled Canva
         export) — normally the outcome replaces a busy notice long before */
      setTimeout(() => {
        if (get().notice?.at === at) set({ notice: null })
      }, BUSY_NOTICE_MAX_MS)
      return
    }
    setTimeout(() => {
      const cur = get().notice
      /* only clear our own notice — a newer one restarts the clock */
      if (cur && !cur.busy && Date.now() - cur.at >= 4900) set({ notice: null })
    }, 5000)
  },
  setLimitWall: (limitWall) => set({ limitWall }),
  allowanceChanged: () => set((s) => ({ allowanceVersion: s.allowanceVersion + 1 })),
  requestFlyTo: (frameId) => {
    const s = get()
    const frame = s.canvas?.frames.find((f) => f.id === frameId)
    if (frame && s.canvas) s.setActivePage(framePageId(s.canvas, frame))
    set({ flyTo: { frameId, at: Date.now() } })
  },
  requestFlyToPoint: (x, y) => set({ flyTo: { point: { x, y }, at: Date.now() } }),
  requestOpenThread: (id) => set({ threadRequest: { id, at: Date.now() } }),
  clearThreadRequest: () => set({ threadRequest: null }),
  requestComposerFocus: () => set({ composerFocusAt: Date.now() }),
  setComposerDraft: (canvasId, text) =>
    set((s) => ({
      composerDrafts: { ...s.composerDrafts, [canvasId]: text },
      /* a failure stays up until the draft is touched again: it is not on a
         timer, so a send that failed while another tab was open is still
         there when this one comes back */
      composerSend: s.composerSend?.status === 'error' ? null : s.composerSend,
    })),
  setComposerSend: (composerSend) => set({ composerSend }),
  /* selecting a different frame (or deselecting) closes the Inspector — the
     panel must not follow surface clicks, paste, or undo onto another frame.
     Re-selecting the same frame keeps an open panel open. */
  select: (selectedId) => {
    const state = get()
    const frame = state.canvas?.frames.find((f) => f.id === selectedId)
    if (frame && state.canvas) state.setActivePage(framePageId(state.canvas, frame))
    set((s) => {
      const selectedIds = selectedId ? [selectedId] : []
      return s.selectedId === selectedId
        ? { selectedId, selectedIds }
        : { selectedId, selectedIds, inspectorOpen: false, selectedElement: null, elementPanelOpen: false }
    })
  },
  toggleSelect: (id) =>
    set((s) => {
      const selectedIds = s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id]
      const selectedId = selectedIds[selectedIds.length - 1] ?? null
      return selectedId === s.selectedId
        ? { selectedIds }
        : { selectedIds, selectedId, inspectorOpen: false, selectedElement: null, elementPanelOpen: false }
    }),
  selectMany: (ids) => {
    const state = get()
    const frame = state.canvas?.frames.find((f) => f.id === ids[ids.length - 1])
    if (frame && state.canvas) state.setActivePage(framePageId(state.canvas, frame))
    set((s) => {
      const selectedId = ids[ids.length - 1] ?? null
      return selectedId === s.selectedId
        ? { selectedIds: ids }
        : { selectedIds: ids, selectedId, inspectorOpen: false, selectedElement: null, elementPanelOpen: false }
    })
  },
  setTool: (tool) => set((s) => (toolAllowed(tool, roleOf(s)) ? { tool } : {})),
  setRole: (role) =>
    set((s) => {
      if (!s.canvas) return {}
      const demoted = !roleAllows(role, 'edit')
      return {
        canvas: { ...s.canvas, role },
        tool: toolAllowed(s.tool, role) ? s.tool : 'select',
        /* an open Design panel or Inspector would keep offering edits */
        ...(demoted ? { inspectorOpen: false, elementPanelOpen: false } : {}),
      }
    }),
  setPanMode: (panMode) => set({ panMode }),
  setFileDragging: (fileDragging) => set({ fileDragging }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setPagePanelOpen: (pagePanelOpen) => set({ pagePanelOpen }),
  openCtxMenu: (ctxMenu) => set({ ctxMenu }),
  closeCtxMenu: () => set({ ctxMenu: null }),
  setCommentDrag: (commentDrag) => set({ commentDrag }),
  setHoveredLayer: (hoveredLayer) =>
    set((s) =>
      s.hoveredLayer?.frameId === hoveredLayer?.frameId && s.hoveredLayer?.selector === hoveredLayer?.selector
        ? s
        : { hoveredLayer },
    ),
  /* re-pointing at the primary keeps the set (the frame resolving a pick
     lands here too); any other element starts a set of its own */
  setSelectedElement: (selectedElement) =>
    set((s) =>
      s.selectedElement?.frameId === selectedElement?.frameId &&
      s.selectedElement?.selector === selectedElement?.selector
        ? s
        : { selectedElement, selectedElements: selectedElement ? [selectedElement.selector] : [] },
    ),
  /* `only` collapses a set onto the element — a plain click on one that is
     already picked */
  pickElement: (el, only = false) =>
    set((s) => {
      if (!el)
        return s.selectedElement || s.elementPanelOpen
          ? { selectedElement: null, selectedElements: [], elementPanelOpen: false }
          : s
      const same = s.selectedElement?.frameId === el.frameId && s.selectedElement?.selector === el.selector
      const collapse = only && pickedSelectors(s).length > 1
      if (same && (s.elementPanelOpen || s.elementPanelClosed) && !collapse) return s
      return same && !collapse
        ? { elementPanelOpen: true }
        : { selectedElement: el, selectedElements: [el.selector], ...panelOnPick(s) }
    }),
  toggleElement: (el) =>
    set((s) => {
      const picked = s.selectedElement?.frameId === el.frameId ? pickedSelectors(s) : []
      if (!picked.includes(el.selector)) {
        return {
          selectedElement: el,
          selectedElements: [...picked, el.selector],
          ...panelOnPick(s),
        }
      }
      const rest = picked.filter((x) => x !== el.selector)
      const primary = rest.at(-1)
      return primary
        ? { selectedElement: { frameId: el.frameId, selector: primary }, selectedElements: rest }
        : { selectedElement: null, selectedElements: [], elementPanelOpen: false }
    }),
  pickElements: (frameId, selectors) => {
    const primary = selectors.at(-1)
    if (!primary) return
    set((s) => ({
      selectedElement: { frameId, selector: primary },
      selectedElements: selectors,
      ...panelOnPick(s),
    }))
  },
  setElementPanelOpen: (elementPanelOpen) => set({ elementPanelOpen }),
  /* closing the panel empties the slot: the frame Inspector it covered goes too */
  closeElementPanel: () => {
    writeFlag(ELEMENT_PANEL_CLOSED_KEY, true)
    set({ elementPanelOpen: false, elementPanelClosed: true, inspectorOpen: false })
  },
  openElementPanel: () => {
    writeFlag(ELEMENT_PANEL_CLOSED_KEY, false)
    set({ elementPanelOpen: true, elementPanelClosed: false })
  },
  setLayersOpen: (layersOpen) => {
    writeFlag(LAYERS_OPEN_KEY, layersOpen)
    set({ layersOpen })
  },
  setLayersTab: (layersTab) => set({ layersTab }),
  /* hidden guides cannot stay selected: Delete would remove one unseen */
  toggleUiHidden: () => set((s) => ({ uiHidden: !s.uiHidden, ...(s.uiHidden ? {} : { selectedGuideId: null }) })),
  setPrototypeMode: (prototypeMode) => set({ prototypeMode }),
  /* every ordinary camera move (pan, zoom, fit, fly-to) is ours, so it ends a follow */
  setViewport: (viewport) => set({ viewport, ...UNFOLLOW }),
  /* fires on every pointermove during a drag — skip the no-op transitions
     so unsnapped drags don't render the (empty) guide layer each frame */
  setSnapGuides: (snapGuides) =>
    set((s) => (snapGuides.length === 0 && s.snapGuides.length === 0 ? s : { snapGuides })),
  toggleRulers: () =>
    set((s) => {
      writeFlag(RULERS_KEY, !s.rulers)
      return { rulers: !s.rulers, ...(s.rulers ? { selectedGuideId: null } : {}) }
    }),
  toggleOutlines: () =>
    set((s) => {
      setOutlines(!s.outlines)
      return { outlines: !s.outlines }
    }),
  requestCollapseLayers: () => set({ layersCollapseAt: Date.now() }),
  toggleViewOption: (name) =>
    set((s) => {
      const viewOptions = { ...s.viewOptions, [name]: !s.viewOptions[name] }
      writeViewOptions(viewOptions)
      return { viewOptions }
    }),
  selectGuide: (selectedGuideId) => set((s) => (s.selectedGuideId === selectedGuideId ? s : { selectedGuideId })),
  setGuideLocal: (id, guide) =>
    set((s) => {
      if (!s.canvas) return {}
      const guides = s.canvas.guides ?? []
      const next = !guide
        ? guides.filter((g) => g.id !== id)
        : guides.some((g) => g.id === id)
          ? guides.map((g) => (g.id === id ? guide : g))
          : [...guides, guide]
      return {
        canvas: { ...s.canvas, guides: next },
        ...(!guide && s.selectedGuideId === id ? { selectedGuideId: null } : {}),
      }
    }),
  setStream: (frameId, actor) =>
    set((s) => {
      const streams = { ...s.streams }
      if (actor) streams[frameId] = actor
      else delete streams[frameId]
      return { streams }
    }),
  flash: (frameId, color) => {
    set((s) => ({ flashes: { ...s.flashes, [frameId]: { color, at: Date.now() } } }))
    setTimeout(() => {
      const cur = get().flashes[frameId]
      if (cur && Date.now() - cur.at >= 1150) {
        set((s) => {
          const flashes = { ...s.flashes }
          delete flashes[frameId]
          return { flashes }
        })
      }
    }, 1200)
  },
}))

/** The picked elements' selectors in `selectedElement`'s frame, the primary
 *  last; empty when nothing is picked. A path that set the primary alone
 *  leaves a stale list behind, which counts as a set of one. */
export function pickedSelectors(s: Pick<State, 'selectedElement' | 'selectedElements'>): string[] {
  const primary = s.selectedElement?.selector
  if (!primary) return []
  return s.selectedElements.at(-1) === primary ? s.selectedElements : [primary]
}

/** The caller's role on the open canvas. A canvas without one (an older
 *  server) is treated as editable; the server enforces it either way. */
export function roleOf(s: Pick<State, 'canvas'>): CanvasRole {
  return s.canvas?.role ?? 'edit'
}

/** May the caller change the open canvas? View and comment links may not. */
export function canEditOpenCanvas(s: Pick<State, 'canvas'>): boolean {
  return roleAllows(roleOf(s), 'edit')
}

/** May the caller comment on the open canvas? */
export function canCommentOpenCanvas(s: Pick<State, 'canvas'>): boolean {
  return roleAllows(roleOf(s), 'comment')
}

/** Select, Hand and the Comment tool for commenters; every tool for editors. */
export function toolAllowed(tool: Tool, role: CanvasRole): boolean {
  if (isDrawingTool(tool)) return roleAllows(role, 'edit')
  if (tool === 'comment') return roleAllows(role, 'comment')
  return true
}

/** A frame from the room as the store keeps it: one sent without its HTML
 *  keeps the copy here (stale, its page not loaded) or ''. */
/** What a pick does to the properties slot: the element panel opens, unless the
 *  person closed it, when the slot empties (a frame Inspector left showing would
 *  describe the frame while an element is picked, and hide the rail's way back). */
function panelOnPick(s: State): Partial<State> {
  return s.elementPanelClosed ? { elementPanelOpen: false, inspectorOpen: false } : { elementPanelOpen: true }
}

function withHtml(frame: Frame | WireFrame, canvas: ClientCanvas | null): Frame {
  if (typeof frame.html === 'string') return frame as Frame
  const kept = canvas?.id === frame.canvasId ? canvas.frames.find((f) => f.id === frame.id)?.html : undefined
  return { ...frame, html: kept ?? '' }
}

function withoutPage(pages: Record<string, true>, pageId: string): Record<string, true> {
  const { [pageId]: _dropped, ...rest } = pages
  return rest
}
