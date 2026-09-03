import { create } from 'zustand'
import type {
  ActivityItem,
  AgentTask,
  Canvas,
  DesignDecision,
  ElementComment,
  Frame,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  Presence,
  TaskFeedback,
} from '../../shared/types'
import type { SnapGuide } from './snap'

export interface Viewport {
  x: number
  y: number
  zoom: number
}

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
  panelTab: 'tasks' | 'activity' | 'memory'
  /** every selected frame, in selection order — marquee and ⇧-click build
   *  this up; a plain click collapses it to one */
  selectedIds: string[]
  /** the primary selection (the last frame added) — what the Inspector,
   *  presence, and the flow overlay follow */
  selectedId: string | null
  /** space bar held: the stage pans on drag instead of drawing a marquee */
  panMode: boolean
  /** the Inspector panel is showing — opened by clicking a frame's name, not
   *  by mere selection, so clicking around a frame doesn't slide the panel in */
  inspectorOpen: boolean
  /** open frame context menu; deferPanel hides the Inspector until it closes
   *  (right-click selecting a frame must not slide a panel in under the menu) */
  ctxMenu: { frameId: string; deferPanel: boolean } | null
  viewport: Viewport
  /** live alignment guide lines while a frame drag is snapped to a neighbour */
  snapGuides: SnapGuide[]
  connected: boolean
  /** a reconnect revealed a newer client bundle on the server — offer a reload */
  updateReady: boolean
  /** frameId -> color, set briefly when a remote actor updates a frame */
  flashes: Record<string, { color: string; at: number }>
  /** frameId -> actor currently streaming a design into it */
  streams: Record<string, { name: string; color: string }>
  /** the free-tier wall is showing — in the store so any surface that hits
   *  the resident-task limit (board, prompt bar, element comment) can raise it */
  limitWall: boolean
  /** bumped whenever the allowance could have changed (a model account was
   *  connected or dropped) so every meter on screen re-reads it */
  allowanceVersion: number
  /** a request for the Stage to glide the camera to a frame — the prompt bar
   *  raises it so a first deliverable streams in on-screen, never off-canvas */
  flyTo: { frameId: string; at: number } | null

  setCanvas(c: Canvas | null): void
  setConnected(v: boolean): void
  setUpdateReady(v: boolean): void
  setPresences(list: Presence[]): void
  upsertPresence(p: Presence): void
  removePresence(clientId: string): void
  setCursor(clientId: string, x: number, y: number): void
  setEditing(clientId: string, frameId: string | null): void
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
  setPanelTab(tab: 'tasks' | 'activity' | 'memory'): void
  setLimitWall(v: boolean): void
  allowanceChanged(): void
  requestFlyTo(frameId: string): void
  select(id: string | null): void
  /** ⇧-click: add the frame to the selection, or drop it if already in */
  toggleSelect(id: string): void
  /** marquee: replace the selection with these frames */
  selectMany(ids: string[]): void
  setPanMode(v: boolean): void
  setInspectorOpen(v: boolean): void
  openCtxMenu(menu: { frameId: string; deferPanel: boolean }): void
  closeCtxMenu(): void
  setViewport(v: Viewport): void
  setSnapGuides(guides: SnapGuide[]): void
  flash(frameId: string, color: string): void
  setStream(frameId: string, actor: { name: string; color: string } | null): void
}

export const useStore = create<State>((set, get) => ({
  canvas: null,
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
  selectedIds: [],
  selectedId: null,
  panMode: false,
  inspectorOpen: false,
  ctxMenu: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  snapGuides: [],
  connected: false,
  updateReady: false,
  flashes: {},
  streams: {},

  setCanvas: (canvas) => set({ canvas }),
  setConnected: (connected) => set({ connected }),
  setUpdateReady: (updateReady) => set({ updateReady }),
  setPresences: (list) => set({ presences: Object.fromEntries(list.map((p) => [p.clientId, p])) }),
  upsertPresence: (p) => set((s) => ({ presences: { ...s.presences, [p.clientId]: p } })),
  removePresence: (clientId) =>
    set((s) => {
      const presences = { ...s.presences }
      const cursors = { ...s.cursors }
      delete presences[clientId]
      delete cursors[clientId]
      return { presences, cursors }
    }),
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
      if (!s.canvas) return {}
      const frames = s.canvas.frames.some((x) => x.id === f.id)
        ? s.canvas.frames.map((x) => (x.id === f.id ? f : x))
        : [...s.canvas.frames, f]
      return { canvas: { ...s.canvas, frames } }
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
  setLimitWall: (limitWall) => set({ limitWall }),
  allowanceChanged: () => set((s) => ({ allowanceVersion: s.allowanceVersion + 1 })),
  requestFlyTo: (frameId) => set({ flyTo: { frameId, at: Date.now() } }),
  /* selecting a different frame (or deselecting) closes the Inspector — the
     panel must not follow surface clicks, paste, or undo onto another frame.
     Re-selecting the same frame keeps an open panel open. */
  select: (selectedId) =>
    set((s) => {
      const selectedIds = selectedId ? [selectedId] : []
      return s.selectedId === selectedId
        ? { selectedId, selectedIds }
        : { selectedId, selectedIds, inspectorOpen: false }
    }),
  toggleSelect: (id) =>
    set((s) => {
      const selectedIds = s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id]
      const selectedId = selectedIds[selectedIds.length - 1] ?? null
      return selectedId === s.selectedId ? { selectedIds } : { selectedIds, selectedId, inspectorOpen: false }
    }),
  selectMany: (ids) =>
    set((s) => {
      const selectedId = ids[ids.length - 1] ?? null
      return selectedId === s.selectedId ? { selectedIds: ids } : { selectedIds: ids, selectedId, inspectorOpen: false }
    }),
  setPanMode: (panMode) => set({ panMode }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  openCtxMenu: (ctxMenu) => set({ ctxMenu }),
  closeCtxMenu: () => set({ ctxMenu: null }),
  setViewport: (viewport) => set({ viewport }),
  /* fires on every pointermove during a drag — skip the no-op transitions
     so unsnapped drags don't render the (empty) guide layer each frame */
  setSnapGuides: (snapGuides) =>
    set((s) => (snapGuides.length === 0 && s.snapGuides.length === 0 ? s : { snapGuides })),
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
