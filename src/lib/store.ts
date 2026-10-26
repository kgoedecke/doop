import { create } from 'zustand'
import { canvasPages, framePageId } from '../../shared/pages'
import type {
  ActivityItem,
  AgentTask,
  Canvas,
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
} from '../../shared/types'
import { roleAllows, type CanvasRole } from '../../shared/canvasRole'
import type { SnapGuide } from './snap'
import { isDrawingTool, type Tool } from './tools'

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

interface State {
  canvas: Canvas | null
  presences: Record<string, Presence>
  cursors: Record<string, { x: number; y: number }>
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
  /** the Inspector panel is showing — opened by clicking a frame's name, not
   *  by mere selection, so clicking around a frame doesn't slide the panel in */
  inspectorOpen: boolean
  /** open frame context menu; deferPanel hides the Inspector until it closes
   *  (right-click selecting a frame must not slide a panel in under the menu) */
  ctxMenu: { frameId: string; deferPanel: boolean } | null
  /** the element outlined inside the selected frame — a click on the frame
   *  surface and a click on a Layers row both land here, so the outline in
   *  the frame and the highlighted row stay in step */
  selectedElement: { frameId: string; selector: string } | null
  /** every element picked in `selectedElement`'s frame, the primary last:
   *  ⇧-click on the surface or ⇧/⌘-click in the Layers rail adds to it.
   *  Read it through `pickedSelectors`, which ignores a list that no longer
   *  holds the primary */
  selectedElements: string[]
  /** the element under the pointer in the Layers panel — its frame outlines
   *  it on the canvas, the same as a hover over the frame itself */
  hoveredLayer: { frameId: string; selector: string } | null
  /** the element properties panel is showing — opened by a pick (a click on
   *  the frame surface or a Layers row), it then follows whatever element is
   *  selected until it is closed */
  elementPanelOpen: boolean
  /** the Layers rail is showing (desktop); the choice sticks across visits */
  layersOpen: boolean
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
  /** the ruler guide clicked last, which Delete removes */
  selectedGuideId: string | null
  connected: boolean
  /** the join for the current canvasId was refused: no such canvas (deleted,
   *  or the id in the URL was never one) — CanvasPage shows a not-found
   *  screen instead of an unusable, unresponsive canvas UI */
  canvasNotFound: boolean
  /** a reconnect revealed a newer client bundle on the server — offer a reload */
  updateReady: boolean
  /** frameId -> color, set briefly when a remote actor updates a frame */
  flashes: Record<string, { color: string; at: number }>
  /** frameId -> actor currently streaming a design into it */
  streams: Record<string, { name: string; color: string }>
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
   *  focus (⌘K) — a timestamp, so a composer that mounts long after an old
   *  request does not grab the keyboard */
  composerFocusAt: number
  /** the composer's unsent text per canvas — collapsing the panel or
   *  switching tabs unmounts the field and must not eat the draft */
  composerDrafts: Record<string, string>
  composerSend: ComposerSend | null
  /** clientId of the peer whose camera this one is tracking (Figma-style
   *  follow); any camera move of our own lets go */
  following: string | null

  activePageId: string | null
  setActivePage(id: string): void
  setPages(pages: import('../../shared/types').CanvasPageInfo[], canvasId?: string): void
  setCanvas(c: Canvas | null): void
  setConnected(v: boolean): void
  setCanvasNotFound(v: boolean): void
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
  upsertFrame(f: Frame): void
  patchFrameLocal(frameId: string, patch: Partial<Frame>): void
  removeFrame(frameId: string): void
  renameCanvasLocal(name: string): void
  /** upsert (doc set) or remove (doc null) a style guide on the open canvas */
  setGuidelineLocal(name: string, doc: GuidelineDoc | null): void
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
  setInspectorOpen(v: boolean): void
  openCtxMenu(menu: { frameId: string; deferPanel: boolean }): void
  closeCtxMenu(): void
  setSelectedElement(el: { frameId: string; selector: string } | null): void
  setHoveredLayer(el: { frameId: string; selector: string } | null): void
  /** an element picked by the user — on the frame surface or in the Layers
   *  rail: selects it and opens its properties panel; picking nothing clears
   *  the selection and closes the panel */
  pickElement(el: { frameId: string; selector: string } | null, only?: boolean): void
  /** add the element to the picked set of its frame, or drop it from the
   *  set; an element in another frame starts a new set */
  toggleElement(el: { frameId: string; selector: string }): void
  setElementPanelOpen(v: boolean): void
  setLayersOpen(v: boolean): void
  toggleUiHidden(): void
  setPrototypeMode(on: boolean): void
  setViewport(v: Viewport): void
  setSnapGuides(guides: SnapGuide[]): void
  toggleRulers(): void
  selectGuide(id: string | null): void
  /** add or move (guide set) or remove (null) a ruler guide on the open canvas */
  setGuideLocal(id: string, guide: CanvasGuide | null): void
  flash(frameId: string, color: string): void
  setStream(frameId: string, actor: { name: string; color: string } | null): void
}

const LAYERS_OPEN_KEY = 'doop:layers-open'
const RULERS_KEY = 'doop:rulers'
/* longer than the slowest real export (Canva: render + verify, ~3 min) */
const BUSY_NOTICE_MAX_MS = 5 * 60_000

function readLayersOpen(): boolean {
  try {
    return localStorage.getItem(LAYERS_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function readRulers(): boolean {
  try {
    return localStorage.getItem(RULERS_KEY) === '1'
  } catch {
    return false
  }
}

export const useStore = create<State>((set, get) => ({
  canvas: null,
  activePageId: null,
  presences: {},
  cursors: {},
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
  threadRequest: null,
  composerFocusAt: 0,
  composerDrafts: {},
  composerSend: null,
  following: null,
  selectedIds: [],
  selectedId: null,
  tool: 'select',
  panMode: false,
  inspectorOpen: false,
  ctxMenu: null,
  selectedElement: null,
  selectedElements: [],
  hoveredLayer: null,
  elementPanelOpen: false,
  layersOpen: readLayersOpen(),
  uiHidden: false,
  prototypeMode: false,
  viewport: { x: 0, y: 0, zoom: 1 },
  snapGuides: [],
  rulers: readRulers(),
  selectedGuideId: null,
  connected: false,
  canvasNotFound: false,
  updateReady: false,
  notice: null,
  flashes: {},
  streams: {},

  setCanvas: (canvas) =>
    set((s) => ({
      canvas,
      /* leaving a canvas (CanvasPage unmounts or its id changes) ends ⌘.
         hide-UI, so the next canvas never opens with its chrome gone; a
         re-join of the same canvas keeps it */
      uiHidden: canvas ? s.uiHidden : false,
      activePageId: canvas
        ? canvas.id === s.canvas?.id && canvasPages(canvas).some((p) => p.id === s.activePageId)
          ? s.activePageId
          : canvasPages(canvas)[0]!.id
        : null,
    })),
  setActivePage: (id) =>
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
        following: null,
        snapGuides: [],
        selectedGuideId: null,
        viewport: { x: 0, y: 0, zoom: 1 },
      }
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
              following: null,
            }
          : {}),
      }
    }),
  setConnected: (connected) => set({ connected }),
  setCanvasNotFound: (canvasNotFound) => set({ canvasNotFound }),
  setUpdateReady: (updateReady) => set({ updateReady }),
  setPresences: (list) =>
    set((s) => ({
      presences: Object.fromEntries(list.map((p) => [p.clientId, p])),
      /* a fresh roster (new canvas, reconnect) without our leader ends the follow */
      ...(s.following && !list.some((p) => p.clientId === s.following) ? { following: null } : {}),
    })),
  upsertPresence: (p) => set((s) => ({ presences: { ...s.presences, [p.clientId]: p } })),
  removePresence: (clientId) =>
    set((s) => {
      const presences = { ...s.presences }
      const cursors = { ...s.cursors }
      delete presences[clientId]
      delete cursors[clientId]
      /* the one we were following left: nothing to track any more */
      return { presences, cursors, ...(s.following === clientId ? { following: null } : {}) }
    }),
  setPeerViewport: (clientId, viewport) =>
    set((s) => {
      const p = s.presences[clientId]
      if (!p) return {}
      return { presences: { ...s.presences, [clientId]: { ...p, viewport } } }
    }),
  setFollowing: (following) => {
    const pageId = following ? get().presences[following]?.viewport?.pageId : undefined
    if (pageId) get().setActivePage(pageId)
    set({ following })
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
  upsertFrame: (f) =>
    set((s) => {
      if (!s.canvas || f.canvasId !== s.canvas.id) return {}
      const frames = s.canvas.frames.some((x) => x.id === f.id)
        ? s.canvas.frames.map((x) => (x.id === f.id ? f : x))
        : [...s.canvas.frames, f]
      const hidden = s.selectedIds.includes(f.id) && framePageId(s.canvas, f) !== s.activePageId
      return {
        canvas: { ...s.canvas, frames },
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
      return {
        canvas: {
          ...s.canvas,
          frames: s.canvas.frames.map((f) => (f.id === frameId ? { ...f, ...patch } : f)),
        },
      }
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
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  openCtxMenu: (ctxMenu) => set({ ctxMenu }),
  closeCtxMenu: () => set({ ctxMenu: null }),
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
      if (same && s.elementPanelOpen && !collapse) return s
      return same && !collapse
        ? { elementPanelOpen: true }
        : { selectedElement: el, selectedElements: [el.selector], elementPanelOpen: true }
    }),
  toggleElement: (el) =>
    set((s) => {
      const picked = s.selectedElement?.frameId === el.frameId ? pickedSelectors(s) : []
      if (!picked.includes(el.selector)) {
        return { selectedElement: el, selectedElements: [...picked, el.selector], elementPanelOpen: true }
      }
      const rest = picked.filter((x) => x !== el.selector)
      const primary = rest.at(-1)
      return primary
        ? { selectedElement: { frameId: el.frameId, selector: primary }, selectedElements: rest }
        : { selectedElement: null, selectedElements: [], elementPanelOpen: false }
    }),
  setElementPanelOpen: (elementPanelOpen) => set({ elementPanelOpen }),
  setLayersOpen: (layersOpen) => {
    try {
      localStorage.setItem(LAYERS_OPEN_KEY, layersOpen ? '1' : '0')
    } catch {
      /* private mode: the choice just doesn't stick */
    }
    set({ layersOpen })
  },
  /* hidden guides cannot stay selected: Delete would remove one unseen */
  toggleUiHidden: () => set((s) => ({ uiHidden: !s.uiHidden, ...(s.uiHidden ? {} : { selectedGuideId: null }) })),
  setPrototypeMode: (prototypeMode) => set({ prototypeMode }),
  /* every ordinary camera move (pan, zoom, fit, fly-to) is ours, so it ends a follow */
  setViewport: (viewport) => set({ viewport, following: null }),
  /* fires on every pointermove during a drag — skip the no-op transitions
     so unsnapped drags don't render the (empty) guide layer each frame */
  setSnapGuides: (snapGuides) =>
    set((s) => (snapGuides.length === 0 && s.snapGuides.length === 0 ? s : { snapGuides })),
  toggleRulers: () =>
    set((s) => {
      try {
        localStorage.setItem(RULERS_KEY, s.rulers ? '0' : '1')
      } catch {
        /* private mode: the choice just doesn't stick */
      }
      return { rulers: !s.rulers, ...(s.rulers ? { selectedGuideId: null } : {}) }
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
