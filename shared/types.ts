export interface Frame {
  id: string
  canvasId: string
  name: string
  x: number
  y: number
  width: number
  height: number
  html: string
  createdAt: number
  updatedAt: number
  updatedBy: string
  /** product-made onboarding/example content (welcome demo, seeded frames) —
   *  not the user's work; agents must never read it as the canvas's style */
  demo?: boolean
}

export interface CanvasMeta {
  id: string
  name: string
  /** user id of the creator; unset for legacy/seeded canvases (visible to everyone) */
  ownerId?: string
  /** true when this canvas is on the list because the user was invited */
  shared?: boolean
  createdAt: number
  updatedAt: number
  frameCount: number
  /** most recently updated frame — render /i/<id>.jpg for a canvas preview */
  previewFrameId?: string
  /** agents that have worked on this canvas (most recent first) */
  agents?: { name: string; owner?: string; lastAt?: number }[]
}

export interface Canvas {
  id: string
  name: string
  ownerId?: string
  /** what the share link grants people who are not the owner or invited:
   *  'edit' (anyone with the link collaborates) or 'none' (private — the
   *  default; unset means 'none'). */
  linkAccess?: 'edit' | 'none'
  /** user ids invited to collaborate (the owner is not listed) */
  memberIds?: string[]
  createdAt: number
  updatedAt: number
  frames: Frame[]
  /** named design docs (brand rules, style recipes) every actor on the canvas follows */
  guidelines?: GuidelineDoc[]
  /** frames pinned to Memory as style exemplars — HTML snapshotted at pin time */
  references?: MemoryReference[]
}

/* ---- design memory ---- */

/** A frame pinned to Memory as a style reference: "more like this one".
 *  The HTML is snapshotted at pin time, so later edits to (or deletion of)
 *  the frame never change what the exemplar shows. */
export interface MemoryReference {
  id: string
  /** the frame it was pinned from; the frame may no longer exist */
  frameId: string
  title: string
  html: string
  width: number
  height: number
  pinnedBy: string
  pinnedAt: number
}

/** A resolved design decision, captured automatically when an agent addresses
 *  human feedback or an @agent element comment gets resolved. Raw material
 *  the distiller condenses into rule proposals. */
export interface DesignDecision {
  id: string
  /** the human's words — what they asked to change */
  text: string
  /** the generalized preference distilled from the raw words shortly after
   *  capture (e.g. "Prefer white and blue; no italic serif") — what the UI
   *  leads with; absent until the summarizer has run (or without an API key) */
  summary?: string
  /** where the decision came from: task feedback, an @agent element comment,
   *  or the human's own conversation with a connected agent (save_decision) */
  source: 'feedback' | 'comment' | 'chat'
  frameId?: string
  /** the human who gave the feedback */
  from: string
  /** the agent that addressed it */
  agentName?: string
  at: number
  /** consumed by a distiller run (whether or not it yielded a proposal) */
  distilledAt?: number
}

/** A rule edit the distiller proposes from accumulated decisions. Nothing is
 *  written to a guide until a human accepts — memory is curated, not scraped. */
export interface MemoryProposal {
  id: string
  /** slug of the guide the rule should land in (existing or new) */
  guideName: string
  /** pretty display name, used when the guide doesn't exist yet */
  guideTitle?: string
  /** markdown to append to the guide (usually one bullet) */
  rule: string
  /** why the distiller thinks this is a rule, in one sentence */
  rationale: string
  /** decision ids this was distilled from */
  basedOn: string[]
  at: number
  status: 'pending' | 'accepted' | 'dismissed'
  resolvedBy?: string
  resolvedAt?: number
}

/** A named design markdown attached to a canvas — palettes, fonts, layout
 *  recipes, asset URLs. Written for agents, readable by humans. Rendered as
 *  a pinned "style guide" card on the canvas next to the frames. */
export interface GuidelineDoc {
  /** slug, unique per canvas (e.g. "feature-image") */
  name: string
  /** pretty display name (e.g. "Featured Images"); fall back to the slug */
  title?: string
  markdown: string
  updatedAt: number
  updatedBy: string
  /** world position of the card on the canvas; unset = auto-placed */
  x?: number
  y?: number
}

export type ActorKind = 'user' | 'agent'

export interface Actor {
  name: string
  kind: ActorKind
  color: string
  clientId?: string
  /** for agents: display name of the user whose OAuth token authorized it */
  owner?: string
}

export interface Presence {
  clientId: string
  name: string
  color: string
  kind: ActorKind
  cursor?: { x: number; y: number }
  activeFrameId?: string | null
  /** one-line "what I'm working on right now" (agents set this via set_status) */
  status?: string
  /** for agents: whose token they connected with */
  owner?: string
}

/** A unit of work an agent announced via set_status. A new status completes the previous task.
 *  Board cards are the same object: a human queues one (queuedBy set, agentName empty)
 *  and an agent claims it — cards stay open until explicitly completed. */
export interface AgentTask {
  id: string
  /** empty string while a queued card waits for an agent */
  agentName: string
  /** whose token the agent connected with */
  owner?: string
  color: string
  status: string
  startedAt: number
  endedAt?: number
  /** inferred by the server from frame edits (agent never called set_status) */
  auto?: boolean
  /** human who queued this as a board card */
  queuedBy?: string
  /** account id of that human — decides which model credential runs the card */
  queuedByUserId?: string
  claimedAt?: number
  /** unsuccessful agent attempt; failed work waits for an explicit human retry */
  failedAt?: number
  failureReason?: string
  /** board cards: ordered agent-role ids the card walks through, one at a time.
   *  Absent on status tasks and on cards queued before pipelines existed. */
  pipeline?: string[]
  /** board cards: ids of reference image frames uploaded with the prompt */
  attachments?: string[]
  /** index into pipeline of the stage that is queued or running right now */
  stage?: number
  /** structured board cards the resident runner dispatches on, instead of
   *  handing the title to the chat agent. Absent on prompt cards. */
  kind?: RepoCardKind
  payload?: RepoCardPayload
}

export type RepoCardKind = 'sketch' | 'design-system'

/** A screen of a connected GitHub repository, as the import manifest lists it. */
export interface RepoScreenRef {
  kind: 'page' | 'story' | 'component' | 'static'
  route: string
  sourcePath: string
  title: string
  /** where the pixels come from: repo HTML, or the agent's sketch of the code */
  source: 'static' | 'placeholder'
}

/** What a repo card carries: enough to run it from any process, later. The
 *  connection is looked up by id at run time, so no credential is ever here. */
export interface RepoCardPayload {
  connectionId: string
  repo: string
  /** one import = one click; groups the cards it queued on the board */
  importId: string
  /** the screen to sketch — absent on a design-system card */
  screen?: RepoScreenRef
}

/** Human feedback left on an agent task: an open request on the canvas that ANY
 *  agent can pick up — delivered inside the next identified agent tool result. */
export interface TaskFeedback {
  id: string
  taskId: string
  canvasId: string
  /** whose work the feedback is about (the task's agent), not who must handle it */
  agentName: string
  /** the resident agent this is routed to; unset = open to any agent */
  targetAgent?: string
  from: string
  /** account id of the human who left it — decides which model credential runs it */
  fromUserId?: string
  text: string
  at: number
  /** set once the feedback has been included in some agent's tool result */
  deliveredAt?: number
  /** the agent that picked it up */
  claimedBy?: string
  /** resident Doop finished handling this feedback */
  completedAt?: number
  /** unsuccessful resident-agent attempt; never retried automatically */
  failedAt?: number
  failureReason?: string
}

/** A comment pinned to a specific element inside a frame. Comments that
 *  mention @Doop are routed to the resident agent; others are notes for
 *  the humans in the room. */
export interface ElementComment {
  id: string
  canvasId: string
  frameId: string
  /** CSS selector of the anchored element, resolved at comment time */
  selector: string
  /** outerHTML excerpt of the element, for agent context and dead-anchor display */
  snippet: string
  from: string
  /** account id of the human who left it — decides which model credential runs it */
  fromUserId?: string
  text: string
  at: number
  /** true when the text @mentions a resident agent — that agent picks it up */
  forAgent?: boolean
  /** which resident agent was mentioned; defaults to Doop */
  targetAgent?: string
  claimedBy?: string
  claimedAt?: number
  /** unsuccessful agent attempt; the comment remains paused until retried */
  failedAt?: number
  failureReason?: string
  resolvedBy?: string
  resolvedAt?: number
  /** set on a reply: the root comment of its thread. Replies inherit the
   *  root's anchor and are listed under its pin instead of getting their own */
  parentId?: string
}

export interface ActivityItem {
  id: string
  actorName: string
  actorKind: ActorKind
  actorColor: string
  message: string
  frameId?: string
  at: number
}

/* ---- websocket protocol ---- */

export type ClientMessage =
  | { type: 'join'; canvasId: string; clientId: string; name: string; kind: ActorKind }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'editing'; frameId: string | null }
  | { type: 'frame:drag'; frameId: string; x: number; y: number; width: number; height: number }

export type ServerMessage =
  | {
      type: 'init'
      canvas: Canvas
      presences: Presence[]
      activity: ActivityItem[]
      tasks: AgentTask[]
      feedback: TaskFeedback[]
      comments: ElementComment[]
      decisions: DesignDecision[]
      proposals: MemoryProposal[]
      selfColor: string
      /** id of the client bundle the server is serving; 'dev' outside production */
      serverBuild: string
    }
  | { type: 'presence:join'; presence: Presence }
  | { type: 'presence:leave'; clientId: string }
  | { type: 'cursor'; clientId: string; x: number; y: number }
  | { type: 'editing'; clientId: string; frameId: string | null }
  | { type: 'status'; clientId: string; status: string | null }
  | { type: 'task'; task: AgentTask }
  | { type: 'feedback'; feedback: TaskFeedback }
  | { type: 'comment'; comment: ElementComment }
  | { type: 'frame:drag'; clientId: string; frameId: string; x: number; y: number; width: number; height: number }
  | { type: 'frame:created'; frame: Frame; actor: Actor }
  | { type: 'frame:updated'; frame: Frame; actor: Actor }
  | { type: 'frame:deleted'; frameId: string; actor: Actor }
  | { type: 'frame:streaming'; frameId: string; active: boolean; actor: Actor }
  | { type: 'canvas:renamed'; name: string; actor: Actor }
  /** a style-guide doc was written, moved (doc set) or deleted (doc null) */
  | { type: 'guidelines'; name: string; doc: GuidelineDoc | null; actor: Actor }
  /** a frame was pinned to (reference set) or unpinned from (null) Memory */
  | { type: 'reference'; id: string; reference: MemoryReference | null; actor: Actor }
  /** a design decision was captured into Memory */
  | { type: 'decision'; decision: DesignDecision }
  /** the distiller proposed a rule, or a proposal was accepted/dismissed */
  | { type: 'proposal'; proposal: MemoryProposal }
  | { type: 'canvas:deleted' }
  | { type: 'activity'; item: ActivityItem }

export const CURSOR_PALETTE = [
  '#2743EE', // cursor blue — the brand accent leads
  '#0E9F6E', // green
  '#8B5CF6', // violet
  '#D0341F', // vermillion
  '#C77800', // amber
  '#D62A7E', // magenta
  '#0E8A8A', // teal
  '#8E2E5C', // plum
]

export function colorFor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return CURSOR_PALETTE[h % CURSOR_PALETTE.length]
}
