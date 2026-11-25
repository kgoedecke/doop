import { parseCardScope } from '../shared/cardScope.ts'
import type { ResolvedMentions } from '../shared/personMentions.ts'
import { nanoid } from 'nanoid'
import { indexOfAscii, lastIndexOfAscii } from '../shared/asciiSearch.ts'
import { env } from './env.ts'
import * as propagation from './propagation.ts'
import { runOperation, WorkBudgetError } from './workBudget.ts'
import {
  afterCommit,
  atomic,
  checkpoint,
  detached,
  inTransaction,
  postCommit,
  recordUndo,
  transaction,
} from './journal.ts'
import {
  dedupeIssues,
  prepareChunk,
  prepareFrameHtml,
  referencesComponent,
  bumpRevision,
  rederiveFromMains,
  refuseUnclosedUses,
} from './components.ts'
import {
  COMPONENT_ATTR,
  isDeleted,
  isHollow,
  wireComponent,
  type ComponentDef,
  type ComponentIssue,
} from '../shared/components.ts'
import { MAX_DECISION_CHARS } from '../shared/designDecisions.ts'
import { MAX_PAGES, PageLimitError, store } from './store.ts'
import * as persist from './db/persist.ts'
import * as thumbs from './thumbs.ts'
import { colorFor } from '../shared/types.ts'
import { agentKeyOf, isAgentsTask } from '../shared/agentIdentity.ts'
import type { AgentBrand } from '../shared/agentBrand.ts'
import type { StackWrite } from '../shared/frameStack.ts'
import {
  DEFAULT_ROLE_ID,
  DEFAULT_ROLE_NAME,
  mentionedRole,
  normalizePipeline,
  roleByAgentName,
  roleName,
  type Roster,
} from '../shared/agents.ts'
import { rosterFor, teamOfCanvas } from './customAgents.ts'
import { canvasPages } from '../shared/pages.ts'
import { FRAME_COMMENT_SELECTOR, isCanvasComment, type CommentAnchorInput } from '../shared/comments.ts'
import { isElementId } from '../shared/elementId.ts'
import { parseRunnerPick, runnerKey, type RunnerPick } from '../shared/agentRunner.ts'
import { hasElementId, stampElementId } from './elementIds.ts'
import { decodeEscapedHtml, looksEscapedHtml, repairEscapedHtml } from './escapedHtml.ts'
import { forgetLibrary } from './componentLibrary.ts'
import {
  advanceInstanceMarks,
  applyRename,
  renameInComponents,
  renameTokenRefs,
  type MarkAdvance,
  type TokenRename,
} from './tokenRenames.ts'
import { withCanvasFaces, withCanvasFacesMidStream, withCanvasStyles } from './canvasFaces.ts'
import { resourcesOf, sameStored, storedHtml } from './frameCompose.ts'
import { htmlLoaded } from './frameHtml.ts'
import { sameAtRest, storesCompactly } from './frameRest.ts'
import { componentsUsedBy, syncComponentHead } from '../shared/frameCompose.ts'
import { withHostedIcons } from './iconProxy.ts'
import { EMBEDDED_MIN_LENGTH } from './inlineData.ts'
import { WriteRefusedError } from './writeRefusal.ts'
import {
  MAX_TOKENS,
  MAX_TOKEN_DESCRIPTION,
  MAX_TOKEN_THEMES,
  aliasOf,
  isThemeName,
  isTokenName,
  isTokenType,
  normalizeTokenName,
  normalizeTokenValue,
  referencedTokens,
  resolveToken,
  tokensUsedBy,
  usesToken,
  type DesignToken,
  type TokenEdit,
  type TokenResult,
  type TokenType,
} from '../shared/designTokens.ts'
import { emitCanvasEvent } from './events.ts'
import type {
  Actor,
  Canvas,
  CanvasGuide,
  ActorKind,
  ActivityItem,
  AgentTask,
  DesignDecision,
  ElementComment,
  Frame,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  RepoCardKind,
  RepoCardPayload,
  RepoScreenRef,
  ServerMessage,
  TaskFeedback,
} from '../shared/types.ts'

/**
 * Mutations shared by the REST API and the MCP tools. Every mutation
 * appends to the canvas activity log and broadcasts to the ws room.
 */

type Broadcast = (canvasId: string, msg: ServerMessage, excludeClientId?: string) => void
type AgentTouch = (
  canvasId: string,
  agent: Pick<Actor, 'name' | 'owner' | 'brand' | 'agentKey'>,
  frameId?: string | null,
  status?: string | null,
) => void

let send: Broadcast = () => {}
/* presence is a heartbeat, not a write: it is never queued, so a tool call that takes long
   shows its agent alive from its first moment */
let agentTouch: AgentTouch = () => {}

export function wire(b: Broadcast, t: AgentTouch) {
  send = b
  agentTouch = t
}

/* ------------------------------------------------------------------ */
/* The write boundary (server/journal.ts). Inside an operation nothing  */
/* here leaves the process before the commit: a broadcast, a presence   */
/* touch, a database write, an event and a kick to another module all   */
/* queue, in order, and are dropped if the operation is refused (the   */
/* presence heartbeat alone is sent at once). What                     */
/* this module keeps in memory (its logs, streams, reveals, bursts) is  */
/* changed through the helpers below, which record how to put it back.  */
/* With no operation open each of these acts at once, as it always did. */
/* ------------------------------------------------------------------ */

const broadcast: Broadcast = (canvasId, msg, excludeClientId) =>
  afterCommit(() => (excludeClientId === undefined ? send(canvasId, msg) : send(canvasId, msg, excludeClientId)))

/** The database writes of this module, each waiting for the commit. The row is read when
 *  it is written, so a record changed again before then is stored as it ended up. */
const stored = {
  saveTask: (canvasId: string, task: AgentTask) => afterCommit(() => persist.saveTask(canvasId, task)),
  saveFeedback: (feedback: TaskFeedback) => afterCommit(() => persist.saveFeedback(feedback)),
  saveComment: (comment: ElementComment) => afterCommit(() => persist.saveComment(comment)),
  saveActivity: (canvasId: string, item: ActivityItem) => afterCommit(() => persist.saveActivity(canvasId, item)),
  saveDecision: (canvasId: string, decision: DesignDecision) =>
    afterCommit(() => persist.saveDecision(canvasId, decision)),
  saveProposal: (canvasId: string, proposal: MemoryProposal) =>
    afterCommit(() => persist.saveProposal(canvasId, proposal)),
  saveFrameVersion: (version: Parameters<typeof persist.saveFrameVersion>[0]) =>
    afterCommit(() => persist.saveFrameVersion(version)),
  saveGuidelineVersion: (...args: Parameters<typeof persist.saveGuidelineVersion>) =>
    afterCommit(() => persist.saveGuidelineVersion(...args)),
}

const emitEvent: typeof emitCanvasEvent = (canvasId, event) => afterCommit(() => emitCanvasEvent(canvasId, event))

/** Work for the resident agents (a card, feedback, an @mention) is in: they hear once it is
 *  committed, and start from nothing, never inside the request that queued it. Dynamic
 *  import: resident depends on this module. No-op without an API key. */
function kickResident(canvasId: string, what: 'onFeedback' | 'onCardStopped' = 'onFeedback') {
  afterCommit(() =>
    detached(() => {
      import('./resident.ts').then((r) => r[what](canvasId)).catch(() => {})
    }),
  )
}

/** A record of one of the logs (a task, a comment, feedback) is about to be changed in
 *  place: its fields go back if the operation is undone. The object stays the same one,
 *  since runs hold on to the cards they claimed. */
function edit<T extends object>(record: T): T {
  if (!inTransaction()) return record
  const before = { ...record }
  recordUndo(() => {
    for (const key of Object.keys(record)) if (!(key in before)) delete (record as Record<string, unknown>)[key]
    Object.assign(record, before)
  })
  return record
}

/** Put a new record at the head of a canvas's log, newest first, capped. */
function prepend<T>(log: Map<string, T[]>, canvasId: string, record: T, cap = 100) {
  const had = log.has(canvasId)
  const list = log.get(canvasId) ?? []
  list.unshift(record)
  const dropped = list.length > cap ? list.splice(cap) : []
  log.set(canvasId, list)
  recordUndo(() => {
    const at = list.indexOf(record)
    if (at !== -1) list.splice(at, 1)
    list.push(...dropped)
    if (!had && !list.length && log.get(canvasId) === list) log.delete(canvasId)
  })
}

/** `map.set`, with the way back. */
function setKey<K, V>(map: Map<K, V>, key: K, value: V) {
  const had = map.has(key)
  const before = map.get(key)
  map.set(key, value)
  recordUndo(() => {
    if (map.get(key) !== value) return
    if (had) map.set(key, before as V)
    else map.delete(key)
  })
}

/** `map.delete`, with the way back. */
function dropKey<K, V>(map: Map<K, V>, key: K) {
  if (!map.has(key)) return
  const before = map.get(key) as V
  map.delete(key)
  recordUndo(() => {
    if (!map.has(key)) map.set(key, before)
  })
}

const activityLog = new Map<string, ActivityItem[]>() // canvasId -> items (newest first)

/** Fill the log maps from the database at boot. */
export function hydrateLogs(data: {
  tasks: Map<string, AgentTask[]>
  feedback: Map<string, TaskFeedback[]>
  comments: Map<string, ElementComment[]>
  activity: Map<string, ActivityItem[]>
  decisions: Map<string, DesignDecision[]>
  proposals: Map<string, MemoryProposal[]>
}) {
  for (const [canvasId, list] of data.tasks) taskLog.set(canvasId, list)
  for (const [canvasId, list] of data.feedback) feedbackLog.set(canvasId, list)
  for (const [canvasId, list] of data.comments) commentLog.set(canvasId, list)
  for (const [canvasId, list] of data.activity) activityLog.set(canvasId, list)
  for (const [canvasId, list] of data.decisions) decisionLog.set(canvasId, list)
  for (const [canvasId, list] of data.proposals) proposalLog.set(canvasId, list)
  failInterruptedWork()
}

/** Work that was mid-flight when the process last died (deploy, crash,
 *  dev restart): no agent will ever finish it, so at boot it becomes a
 *  visible, retryable failure instead of sitting "in progress" forever. */
function failInterruptedWork() {
  const reason = 'Interrupted by a server restart. Retry when you are ready.'
  const now = Date.now()
  for (const [canvasId, list] of taskLog) {
    for (const t of list) {
      if (t.endedAt || t.failedAt || !t.agentName) continue
      if (t.queuedBy) {
        /* a claimed card whose run died — retryable */
        t.failedAt = now
        t.failureReason = reason
      } else {
        /* a live status row from the dead process — just close it out */
        t.endedAt = now
      }
      persist.saveTask(canvasId, t)
    }
  }
  for (const [, list] of feedbackLog) {
    for (const f of list) {
      if (f.deliveredAt && !f.completedAt && !f.failedAt) {
        f.failedAt = now
        f.failureReason = reason
        persist.saveFeedback(f)
      }
    }
  }
  for (const [, list] of commentLog) {
    for (const c of list) {
      if (c.claimedBy && !c.resolvedAt && !c.failedAt) {
        c.failedAt = now
        c.failureReason = reason
        persist.saveComment(c)
      }
    }
  }
}

export function getActivity(canvasId: string): ActivityItem[] {
  return activityLog.get(canvasId) ?? []
}

function logActivity(canvasId: string, actor: Actor, message: string, frameId?: string) {
  const item: ActivityItem = {
    id: nanoid(8),
    actorName: actor.name,
    actorKind: actor.kind,
    actorColor: actor.color,
    message,
    frameId,
    at: Date.now(),
  }
  prepend(activityLog, canvasId, item)
  stored.saveActivity(canvasId, item)
  broadcast(canvasId, { type: 'activity', item })
}

export function resolveActor(
  raw:
    | { name?: string; kind?: string; clientId?: string; owner?: string; brand?: AgentBrand; agentKey?: string }
    | undefined,
): Actor {
  const kind = raw?.kind === 'agent' ? 'agent' : raw?.kind === 'user' ? 'user' : 'agent'
  const name = raw?.name?.trim() || (kind === 'agent' ? 'AI Agent' : 'Anonymous')
  return {
    name,
    kind,
    color: colorFor(name),
    clientId: raw?.clientId,
    owner: raw?.owner,
    brand: raw?.brand,
    ...(kind === 'agent' && raw?.agentKey ? { agentKey: raw.agentKey } : {}),
  }
}

function touch(canvasId: string, actor: Actor, frameId?: string | null) {
  if (actor.kind === 'agent') agentTouch(canvasId, actor, frameId)
}

/** Refresh an agent's presence without changing its frame or status. A model
 *  turn can stay silent longer than the presence TTL, and expiry fails the
 *  run's claimed cards as "disconnected" — resident runs beat this on a timer
 *  for as long as they are actually alive. */
export function heartbeatAgent(canvasId: string, actor: Actor) {
  touch(canvasId, actor)
}

/* ------------------------------------------------------------------ */
/* Agent routing: a board card carries an ordered pipeline of roles and */
/* is only ever visible to the role at its current stage. Feedback and  */
/* element comments carry a target agent instead. Untargeted work stays */
/* open to anyone — that's what outside MCP agents pick up.             */
/* ------------------------------------------------------------------ */

/** The pipeline of a card, tolerating cards queued before pipelines existed. */
export function pipelineOf(task: AgentTask): string[] {
  return task.pipeline?.length ? task.pipeline : [DEFAULT_ROLE_ID]
}

/** The roster a canvas's work is addressed with: the built-in team plus its
 *  custom agents. */
export function canvasRoster(canvasId: string): Roster {
  return rosterFor(store.getCanvas(canvasId))
}

/** The resident agent a comment or reply is for, by the name it was addressed
 *  to: that agent while the canvas still has it, else the default agent (a
 *  custom agent deleted with work still waiting on it). Unset stays unset. */
function addressee(target: string | undefined, roster: Roster): string | undefined {
  if (!target) return undefined
  return roleByAgentName(target, roster)?.name ?? DEFAULT_ROLE_NAME
}

/** The agent whose turn it is on this card. */
function stageAgent(task: AgentTask, roster: Roster): string {
  const pipeline = pipelineOf(task)
  return roleName(pipeline[Math.min(task.stage ?? 0, pipeline.length - 1)], roster)
}

/** Distinct resident agents with work waiting, in the order work arrived. */
export function pendingWorkAgents(canvasId: string): string[] {
  const names: string[] = []
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name)
  }
  const roster = canvasRoster(canvasId)
  /* oldest first so a queue is worked in the order humans filled it */
  for (const card of [...(taskLog.get(canvasId) ?? [])].reverse()) {
    if (card.queuedBy && !card.agentName && !card.failedAt && !card.endedAt && !isOutsideCard(card))
      add(stageAgent(card, roster))
  }
  const now = Date.now()
  for (const f of [...(feedbackLog.get(canvasId) ?? [])].reverse()) {
    /* feedback still waiting for the outside agent whose work it is about is
       no resident's yet: addTaskFeedback wakes them when the wait is over */
    if (!f.deliveredAt && !f.failedAt && !awaitingOwner(f, now))
      add(addressee(f.targetAgent, roster) ?? DEFAULT_ROLE_NAME)
  }
  for (const c of [...(commentLog.get(canvasId) ?? [])].reverse()) {
    if (c.forAgent && !c.claimedBy && !c.failedAt && !c.resolvedAt)
      add(addressee(c.targetAgent, roster) ?? DEFAULT_ROLE_NAME)
  }
  return names
}

/** The oldest claimable item's requester and the connection it asked for. */
export interface NextWork {
  /** '' when the item predates per-user attribution */
  payer: string
  /** the card's pick; absent (and `key` '') for work on the Settings default */
  runner?: RunnerPick
  /** `payer` and the pick together: what one run claims, and what a sweep skips */
  key: string
}

export function workKey(payer: string, runner: RunnerPick | undefined): string {
  return `${payer}\n${runnerKey(runner)}`
}

/** Feedback runs on what the task it answers ran on, so a reply to a card
 *  sent to the Claude Plan stays on the Claude Plan. The pick is kept on the
 *  feedback itself; the task history is only asked for feedback left before
 *  that, while its task is still there. */
function feedbackRunner(f: TaskFeedback): RunnerPick | undefined {
  return f.runner ?? (taskLog.get(f.canvasId) ?? []).find((t) => t.id === f.taskId)?.runner
}

/**
 * Who pays for the next run, and on what: the account behind the OLDEST piece
 * of work this agent can claim, and the connection that work asked for. A run
 * bills exactly one person and calls one model, so the queue is worked one
 * requester and one connection at a time rather than sweeping several
 * people's work into a single model call on whichever account happened to
 * be found first.
 *
 * `payer` is '' when the oldest item predates per-user attribution (the
 * caller falls back to the canvas owner); the result is undefined when
 * nothing is claimable. `skip` holds work keys already found to have no
 * usable model this sweep, so one stalled requester never blocks everyone
 * behind them.
 */
export function nextWork(canvasId: string, agentName: string, skip?: ReadonlySet<string>): NextWork | undefined {
  return oldestWork(canvasId, agentName, (work) => !!skip?.has(work.key))
}

/** The oldest claimable work the predicate does not pass over. */
function oldestWork(canvasId: string, agentName: string, passOver: (work: NextWork) => boolean): NextWork | undefined {
  let oldest: { at: number; work: NextWork } | undefined
  const consider = (at: number, userId: string | undefined, runner: RunnerPick | undefined) => {
    const payer = userId ?? ''
    const key = workKey(payer, runner)
    if (passOver({ payer, key })) return
    if (!oldest || at < oldest.at) oldest = { at, work: { payer, ...(runner ? { runner } : {}), key } }
  }
  const roster = canvasRoster(canvasId)
  for (const card of taskLog.get(canvasId) ?? []) {
    if (
      card.queuedBy &&
      !card.agentName &&
      !card.failedAt &&
      !card.endedAt &&
      !isOutsideCard(card) &&
      stageAgent(card, roster) === agentName
    ) {
      consider(card.startedAt, card.queuedByUserId, card.runner)
    }
  }
  for (const c of commentLog.get(canvasId) ?? []) {
    if (
      c.forAgent &&
      !c.claimedBy &&
      !c.failedAt &&
      !c.resolvedAt &&
      (addressee(c.targetAgent, roster) ?? DEFAULT_ROLE_NAME) === agentName
    ) {
      consider(c.at, c.fromUserId, undefined)
    }
  }
  const now = Date.now()
  for (const f of feedbackLog.get(canvasId) ?? []) {
    if (!f.deliveredAt && !f.failedAt && feedbackFor(f, { name: agentName }, roster, now)) {
      consider(f.at, f.fromUserId, feedbackRunner(f))
    }
  }
  return oldest?.work
}

/** Whether this agent may take a reply: one addressed to it, or one left for
 *  whoever shows up (the work it answers was an outside agent's), once that
 *  agent has had first pick. */
function feedbackFor(f: TaskFeedback, agent: Pick<Actor, 'name' | 'agentKey'>, roster: Roster, now: number): boolean {
  const target = addressee(f.targetAgent, roster)
  if (target && target !== agent.name) return false
  return f.agentKey === agentKeyOf(agent) || !awaitingOwner(f, now)
}

/** The requester behind the oldest work, for callers that bill but do not
 *  run; `skip` holds requesters (not work keys) who cannot pay. */
export function nextWorkPayer(canvasId: string, agentName: string, skip?: ReadonlySet<string>): string | undefined {
  return oldestWork(canvasId, agentName, (work) => !!skip?.has(work.payer))?.payer
}

/* ------------------------------------------------------------------ */
/* Agent tasks: every set_status becomes a task entry, so the client   */
/* can show a per-agent history of work (à la Cursor's agent panel),   */
/* not just the current status. A new status completes the previous.   */
/* ------------------------------------------------------------------ */

const taskLog = new Map<string, AgentTask[]>() // canvasId -> tasks (newest first)

export function getTasks(canvasId: string): AgentTask[] {
  return taskLog.get(canvasId) ?? []
}

/** Which canvas a task lives on — routes that take a bare task id resolve it
 *  here so the canvas access check can run before mutating. */
export function taskCanvasId(taskId: string): string | undefined {
  for (const [canvasId, list] of taskLog) if (list.some((t) => t.id === taskId)) return canvasId
  return undefined
}

/** Say what an agent is doing next to its face, without logging a task: for
 *  work whose board cards already are the tasks (a repo import), so a failed
 *  card never leaves a narration behind that reads as finished work. */
export function narrateAgent(canvasId: string, actor: Actor, status: string) {
  agentTouch(canvasId, actor, undefined, status.trim() || null)
}

/** Agent announces what it is working on right now (empty string clears it). */

export function setAgentStatus(canvasId: string, actor: Actor, status: string) {
  const clean = status.trim()
  agentTouch(canvasId, actor, undefined, clean || null)

  const list = taskLog.get(canvasId) ?? []
  /* board cards stay open until explicitly completed — a status change
     narrates work ON a card, it doesn't end it */
  const open = list.find((t) => isAgentsTask(t, actor) && !t.endedAt && !t.queuedBy)
  if (open?.status === clean) return // same status re-posted: nothing new
  const runStartedAt = open ? (open.runStartedAt ?? open.startedAt) : undefined
  if (open) {
    edit(open).endedAt = Date.now()
    stored.saveTask(canvasId, open)
    broadcast(canvasId, { type: 'task', task: open })
  }
  if (clean) {
    const task: AgentTask = {
      id: nanoid(8),
      agentName: actor.name,
      ...(actor.agentKey ? { agentKey: actor.agentKey } : {}),
      owner: actor.owner,
      color: actor.color,
      status: clean,
      startedAt: Date.now(),
      ...(runStartedAt ? { runStartedAt } : {}),
    }
    prepend(taskLog, canvasId, task)
    stored.saveTask(canvasId, task)
    broadcast(canvasId, { type: 'task', task })
    logActivity(canvasId, actor, `is working on: ${clean}`)
  }
}

/* ------------------------------------------------------------------ */
/* Progress tasks: a server-side job (an import) shown the way an      */
/* agent's work is — a named worker in the Agents panel, one task, a   */
/* status that changes in place and a bar that fills.                  */
/* ------------------------------------------------------------------ */

/** Open a task with `total` countable steps for `actor`. Unlike
 *  setAgentStatus, later updates rewrite this one task instead of closing it
 *  and opening another — forty steps are one job, not forty tasks. */
export function startProgressTask(canvasId: string, actor: Actor, status: string, total: number): AgentTask {
  const task: AgentTask = {
    id: nanoid(8),
    agentName: actor.name,
    ...(actor.agentKey ? { agentKey: actor.agentKey } : {}),
    owner: actor.owner,
    color: actor.color,
    status,
    startedAt: Date.now(),
    progress: { done: 0, total: Math.max(1, total) },
  }
  prepend(taskLog, canvasId, task)
  stored.saveTask(canvasId, task)
  broadcast(canvasId, { type: 'task', task })
  agentTouch(canvasId, actor, undefined, status)
  logActivity(canvasId, actor, `started: ${status}`)
  return task
}

/** Move a progress task along: new wording, more steps done, or both. Also
 *  the job's heartbeat — presence would otherwise expire mid-import and fail
 *  the task as "disconnected". */
export function advanceProgressTask(
  canvasId: string,
  taskId: string,
  patch: { status?: string; done?: number; total?: number; frameId?: string },
) {
  const task = (taskLog.get(canvasId) ?? []).find((t) => t.id === taskId)
  if (!task || task.endedAt || !task.progress) return
  edit(task)
  if (patch.status) task.status = patch.status
  const total = Math.max(1, patch.total ?? task.progress.total)
  /* A job learns its size as it goes, so the total can grow. The bar must not
     go backwards when it does: hold the fraction already shown, and let the
     newly discovered work slow the bar instead of rewinding it. */
  const shown = task.progress.done / task.progress.total
  const done = Math.max(patch.done ?? 0, Math.ceil(shown * total - 1e-9))
  task.progress = { done: Math.min(total, done), total }
  if (patch.frameId) task.frameIds = [...(task.frameIds ?? []), patch.frameId].slice(-TASK_FRAMES_CAP)
  broadcast(canvasId, { type: 'task', task })
  agentTouch(canvasId, progressAgent(task), patch.frameId, task.status)
}

/** The worker a progress task belongs to, as its presence knows it. */
function progressAgent(task: AgentTask) {
  return { name: task.agentName, owner: task.owner, ...(task.agentKey ? { agentKey: task.agentKey } : {}) }
}

/** Close a progress task: done, or failed with the reason as its last word. */
export function finishProgressTask(canvasId: string, taskId: string, outcome: { status: string; failed?: boolean }) {
  const task = (taskLog.get(canvasId) ?? []).find((t) => t.id === taskId)
  if (!task || task.endedAt) return
  const now = Date.now()
  edit(task).status = outcome.status
  if (outcome.failed) {
    task.failedAt = now
    task.failureReason = outcome.status
  } else if (task.progress) task.progress = { ...task.progress, done: task.progress.total }
  task.endedAt = now
  stored.saveTask(canvasId, task)
  broadcast(canvasId, { type: 'task', task })
  agentTouch(canvasId, progressAgent(task), undefined, null)
  logActivity(canvasId, resolveActor({ ...progressAgent(task), kind: 'agent' }), outcome.status)
}

/* ------------------------------------------------------------------ */
/* Task feedback: humans reply to a task in the UI; the text is        */
/* delivered to the agent inside its NEXT MCP tool result (MCP is      */
/* pull-based — the result-nudge layer is our channel into the agent). */
/* ------------------------------------------------------------------ */

const feedbackLog = new Map<string, TaskFeedback[]>() // canvasId -> entries (newest first)

export function getFeedback(canvasId: string): TaskFeedback[] {
  return feedbackLog.get(canvasId) ?? []
}

/** Look a feedback entry up by id (it carries its canvasId) for access checks. */
export function findFeedback(feedbackId: string): TaskFeedback | undefined {
  for (const list of feedbackLog.values()) {
    const fb = list.find((f) => f.id === feedbackId)
    if (fb) return fb
  }
  return undefined
}

export function addTaskFeedback(
  taskId: string,
  from: string,
  text: string,
  fromUserId?: string,
): TaskFeedback | undefined {
  const clean = text.trim()
  if (!clean) return undefined
  for (const [canvasId, tasks] of taskLog) {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) continue
    /* a reply goes back to the agent whose work it is about — unless that was
       an outside agent, in which case it stays open to whoever shows up */
    const target = roleByAgentName(task.agentName, canvasRoster(canvasId))?.name
    const fb: TaskFeedback = {
      id: nanoid(8),
      taskId,
      canvasId,
      agentName: task.agentName,
      ...(task.agentKey ? { agentKey: task.agentKey } : {}),
      ...(target ? { targetAgent: target } : {}),
      from,
      ...(fromUserId ? { fromUserId } : {}),
      ...(task.runner ? { runner: task.runner } : {}),
      text: clean,
      at: Date.now(),
    }
    prepend(feedbackLog, canvasId, fb)
    stored.saveFeedback(fb)
    broadcast(canvasId, { type: 'feedback', feedback: fb })
    /* resident Doop agent picks feedback up instantly (no-op without an API
       key). Dynamic import: resident depends on this module. Feedback on an
       outside agent's work is that agent's for a minute: the residents hear
       again when it is open to them. */
    kickResident(canvasId)
    if (fb.agentKey) afterCommit(() => setTimeout(() => kickResident(canvasId), OWNER_FIRST_MS).unref())
    logActivity(
      canvasId,
      resolveActor({ name: from, kind: 'user' }),
      `left feedback on ${task.agentName}’s task: “${clean}”`,
    )
    return fb
  }
  return undefined
}

/** How long feedback on an outside agent's task waits for that agent before
 *  any agent may take it: the longest an agent's presence outlives its last
 *  tool call (server/index.ts), so an agent still at work is asked first. */
export const OWNER_FIRST_MS = 60_000

/** Feedback on an outside agent's work that is still that agent's alone:
 *  every other agent, a resident one too, waits out OWNER_FIRST_MS. */
function awaitingOwner(f: TaskFeedback, now: number): boolean {
  return !!f.agentKey && now - f.at < OWNER_FIRST_MS
}

/** The feedback takeFeedbackFor would claim, left unclaimed: what read-only
 *  tools mention without assigning anything. */
export function openFeedbackFor(
  canvasId: string,
  agent: Pick<Actor, 'name' | 'agentKey'>,
  payer?: string,
  runner?: string,
): TaskFeedback[] {
  const roster = canvasRoster(canvasId)
  const now = Date.now()
  return (feedbackLog.get(canvasId) ?? []).filter(
    (f) =>
      !f.deliveredAt &&
      !f.failedAt &&
      feedbackFor(f, agent, roster, now) &&
      (payer === undefined || (f.fromUserId ?? '') === payer) &&
      (runner === undefined || runnerKey(feedbackRunner(f)) === runner),
  )
}

/** Open feedback this outside agent may take: everything addressed to it,
 *  plus untargeted feedback — that part stays a canvas-level queue where the
 *  first identified agent call wins, after the agent whose work it is about
 *  has had first pick (OWNER_FIRST_MS). */
export function takeFeedbackFor(
  canvasId: string,
  agent: Pick<Actor, 'name' | 'agentKey'>,
  payer?: string,
  runner?: string,
): TaskFeedback[] {
  return claimFeedback(canvasId, agent, false, payer, runner)
}

/** takeFeedbackFor for a resident run: the claim is marked in-process, which
 *  is what restart recovery fails as interrupted. */
export function takeResidentFeedbackFor(
  canvasId: string,
  agentName: string,
  payer?: string,
  runner?: string,
): TaskFeedback[] {
  return claimFeedback(canvasId, { name: agentName }, true, payer, runner)
}

/** `runner` (a `runnerKey`) narrows the claim to one connection, since a run
 *  calls one model. */
function claimFeedback(
  canvasId: string,
  agent: Pick<Actor, 'name' | 'agentKey'>,
  resident: boolean,
  payer?: string,
  runner?: string,
): TaskFeedback[] {
  const pending = openFeedbackFor(canvasId, agent, payer, runner)
  for (const f of pending) {
    edit(f).deliveredAt = Date.now()
    f.claimedBy = agent.name
    f.claimedByResident = resident
    stored.saveFeedback(f)
    broadcast(canvasId, { type: 'feedback', feedback: f }) // clients flip the entry to "picked up"
  }
  return pending
}

export function failTaskFeedback(feedbackId: string, reason: string): TaskFeedback | undefined {
  for (const [canvasId, list] of feedbackLog) {
    const feedback = list.find((f) => f.id === feedbackId)
    if (!feedback) continue
    edit(feedback).failedAt = Date.now()
    feedback.failureReason = reason
    stored.saveFeedback(feedback)
    broadcast(canvasId, { type: 'feedback', feedback })
    return feedback
  }
  return undefined
}

export function completeTaskFeedback(feedbackId: string): TaskFeedback | undefined {
  for (const [canvasId, list] of feedbackLog) {
    const feedback = list.find((f) => f.id === feedbackId)
    if (!feedback) continue
    edit(feedback).completedAt = Date.now()
    delete feedback.failedAt
    delete feedback.failureReason
    stored.saveFeedback(feedback)
    broadcast(canvasId, { type: 'feedback', feedback })
    /* addressed feedback is a settled design decision — capture it into Memory */
    captureDecision(canvasId, {
      text: feedback.text,
      source: 'feedback',
      from: feedback.from,
      agentName: feedback.claimedBy,
    })
    return feedback
  }
  return undefined
}

export function retryTaskFeedback(feedbackId: string, by: string): TaskFeedback | undefined {
  for (const [canvasId, list] of feedbackLog) {
    const feedback = list.find((f) => f.id === feedbackId)
    if (!feedback) continue
    if (!feedback.failedAt) return feedback
    edit(feedback)
    delete feedback.deliveredAt
    delete feedback.claimedBy
    delete feedback.completedAt
    delete feedback.failedAt
    delete feedback.failureReason
    stored.saveFeedback(feedback)
    broadcast(canvasId, { type: 'feedback', feedback })
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), 'retried agent feedback')
    kickResident(canvasId)
    return feedback
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Comments: pinned to a specific element inside a frame, or to a      */
/* point on the canvas. Comments mentioning @Doop are routed to the    */
/* resident agent; the rest are notes for the humans in the room.      */
/* ------------------------------------------------------------------ */

const commentLog = new Map<string, ElementComment[]>() // canvasId -> entries (newest first)

export function getComments(canvasId: string): ElementComment[] {
  return commentLog.get(canvasId) ?? []
}

/** Look a comment up by id (it carries its canvasId) for access checks. */
export function findComment(commentId: string): ElementComment | undefined {
  for (const list of commentLog.values()) {
    const c = list.find((x) => x.id === commentId)
    if (c) return c
  }
  return undefined
}

/** Where a new comment sits: on an element inside a frame (by its
 *  `data-doop-id`), on a frame as a whole at a design point, or at a world
 *  point on one page of the canvas. */
type CommentAnchor =
  | {
      frame: Frame
      elementId?: string
      snippet: string
      point?: { x: number; y: number }
      elementOrigin?: { x: number; y: number }
    }
  | { pageId: string; x: number; y: number }

/** What a client knows about the element it is pointing at: the positional
 *  path the live document answered with, the id the element already wears if
 *  any, an excerpt, and the design point of the click. */
export interface FrameAnchorInput {
  selector?: unknown
  elementId?: unknown
  snippet?: unknown
  x?: unknown
  y?: unknown
  elementOrigin?: unknown
}

export const MAX_ELEMENT_SELECTOR_CHARS = 1_000

/* Stamps that are in a frame's HTML in memory but not yet known to be on
   disk, per frame: the write that carries them, while one is out. An id is
   handed out only once its frame write has landed, whichever request made
   it and whether or not that first write failed. */
const unsavedStamps = new Map<string, { ids: Set<string>; write?: Promise<void> }>()

/** Resolves true once `id` is in a stored copy of the frame: at once for an
 *  id that was never pending, else after the write that carries it (a write
 *  already out is waited for; one that failed is retried once by this
 *  caller). False when the frame is gone or the write fails. */
async function stampSaved(frameId: string, id: string): Promise<boolean> {
  let tried = false
  for (;;) {
    const pending = unsavedStamps.get(frameId)
    if (!pending?.ids.has(id)) return true
    if (pending.write) {
      await pending.write
      continue
    }
    const frame = store.getFrame(frameId)
    if (tried || !frame) return false
    tried = true
    /* the row is taken from the frame as it is now: every stamp so far goes in */
    const carried = new Set(pending.ids)
    const write: Promise<void> = persist
      .saveFrameNow(frame)
      .then(
        () => {
          /* deleted while the write was out: the write must not bring it back */
          if (!store.getFrame(frameId)) persist.deleteFrame(frameId)
          for (const stamp of carried) pending.ids.delete(stamp)
          if (!pending.ids.size && unsavedStamps.get(frameId) === pending) unsavedStamps.delete(frameId)
        },
        (err: unknown) => {
          console.error(`[comments] element id stamp on frame ${frameId} not written:`, err)
        },
      )
      .finally(() => {
        if (pending.write === write) pending.write = undefined
      })
    pending.write = write
  }
}

/** Make the element a positional selector names addressable by id: the id
 *  it already carries, or a fresh `data-doop-id` written into the frame's
 *  HTML as an annotation (sign-off stands, no design-history version, no
 *  activity line). Whatever names the id (a comment, a copied link) is
 *  written after this returns, so the frame carrying it is on disk first.
 *  Undefined when the frame is gone, is being streamed into, the selector
 *  does not resolve in the stored HTML, or the stamp cannot be written (it
 *  then stays in memory, unnamed, and goes to disk with a later save). */
export async function ensureElementId(
  frameId: string,
  selector: string,
  by: string,
  /** the live element's excerpt, when known: the stamp is refused if the
   *  saved element at that path is not the one the client saw */
  like?: string,
): Promise<{ id: string; frame: Frame } | undefined> {
  const frame = store.getFrame(frameId)
  if (!frame || isFrameStreaming(frameId)) return undefined
  const stamped = stampElementId(frame.html, selector.slice(0, MAX_ELEMENT_SELECTOR_CHARS), { like })
  if (!stamped) return undefined
  if (stamped.html === frame.html) {
    if (!(await stampSaved(frameId, stamped.id))) return undefined
    /* the frame may have been deleted while the write was awaited */
    const current = store.getFrame(frameId)
    return current ? { id: stamped.id, frame: current } : undefined
  }
  const next = store.updateFrame(frameId, { html: stamped.html }, by, { annotation: true })
  if (!next) return undefined
  const pending = unsavedStamps.get(frameId) ?? { ids: new Set<string>() }
  pending.ids.add(stamped.id)
  unsavedStamps.set(frameId, pending)
  /* a sub-commit: the stamp is an annotation that stands whatever becomes of the request
     (it goes to disk here, before anything names it), and nothing is held across the write */
  checkpoint()
  if (!(await stampSaved(frameId, stamped.id))) return undefined
  /* deleted meanwhile: an update now would put it back on every screen */
  if (!store.getFrame(frameId)) return undefined
  broadcast(next.canvasId, { type: 'frame:updated', frame: next, actor: resolveActor({ name: by, kind: 'user' }) })
  return { id: stamped.id, frame: next }
}

/** An anchor inside a frame, as a client sent it. An element is kept by the
 *  id it carries, else stamped from the positional selector; when neither
 *  works (the element came from a script, or the frame is mid-stream) the
 *  comment lands on the frame at the point instead, so it is never lost. A
 *  client that sends no point (older apps) still gets a frame comment, one
 *  that is listed without a pin. */
async function frameAnchor(frame: Frame, input: FrameAnchorInput, by: string): Promise<CommentAnchor> {
  const point =
    Number.isFinite(input.x) && Number.isFinite(input.y) ? { x: Number(input.x), y: Number(input.y) } : undefined
  const origin = input.elementOrigin
  const elementOrigin =
    point &&
    origin &&
    typeof origin === 'object' &&
    'x' in origin &&
    'y' in origin &&
    Number.isFinite(origin.x) &&
    Number.isFinite(origin.y)
      ? { x: Number(origin.x), y: Number(origin.y) }
      : undefined
  const placement = { ...(point ? { point } : {}), ...(elementOrigin ? { elementOrigin } : {}) }
  const snippet = String(input.snippet ?? '').slice(0, 400)
  const selector = String(input.selector ?? '').trim()
  const onElement = selector !== '' && selector !== FRAME_COMMENT_SELECTOR
  if (
    isElementId(input.elementId) &&
    hasElementId(frame.html, input.elementId) &&
    (await stampSaved(frame.id, input.elementId))
  ) {
    return { frame, elementId: input.elementId, snippet, ...placement }
  }
  if (onElement) {
    /* through the canvas write entry, as the /element-id route stamps */
    const { runCanvasWrite } = await canvasWrites()
    const stamped = await runCanvasWrite(frame.canvasId, {
      type: 'stamp-element-id',
      frameId: frame.id,
      selector,
      by,
      ...(snippet ? { like: snippet } : {}),
    })
    if (stamped) return { frame: stamped.frame, elementId: stamped.id, snippet, ...placement }
  }
  return { frame, snippet: '', ...(point ? { point } : {}) }
}

export async function addElementComment(
  frameId: string,
  input: FrameAnchorInput & { text: string; mentions?: ResolvedMentions },
  from: string,
  fromUserId?: string,
): Promise<ElementComment | undefined> {
  const frame = store.getFrame(frameId)
  if (!frame || !input.text.trim()) return undefined
  const anchor = await frameAnchor(frame, input, from)
  /* a frame deleted while its element was being stamped takes no comment */
  if (!store.getFrame(frameId)) return undefined
  return postComment(frame.canvasId, anchor, input.text, from, fromUserId, 'user', undefined, input.mentions)
}

/** The anchor as it is written onto a comment; what the anchor does not
 *  carry is absent, so a moved comment sheds its old frame, element or page. */
function anchorFields(
  anchor: CommentAnchor,
): Pick<ElementComment, 'frameId' | 'elementId' | 'snippet' | 'pageId' | 'x' | 'y' | 'elementOrigin'> {
  if ('frame' in anchor) {
    return {
      frameId: anchor.frame.id,
      ...(anchor.elementId ? { elementId: anchor.elementId } : {}),
      snippet: anchor.snippet,
      ...anchor.point,
      ...(anchor.elementOrigin ? { elementOrigin: anchor.elementOrigin } : {}),
    }
  }
  return { snippet: '', pageId: anchor.pageId, x: anchor.x, y: anchor.y }
}

/** Comments anchored by a positional CSS path before element ids existed:
 *  stamp each element and keep the comment on it. Runs once after boot, frame
 *  by frame: every stamp for a frame is written and awaited before the
 *  comments naming those ids are, so a crash in between leaves selectors to
 *  retry, never a comment pointing at an id no frame carries. A path that no
 *  longer resolves spends its selector and leaves a lost anchor (frame and
 *  snippet, no pin): HTML only drifts further, so retrying it would not help.
 *  A malformed selector, a frame that will not parse or a failed write is
 *  logged and left for the next boot; one bad row never stops the others.
 *  The comments are in memory and displayed throughout; pins appear as the
 *  stamps land, with the frames broadcast to anyone already in the room. */
export async function backfillElementIds(
  legacy: Map<string, string>,
): Promise<{ stamped: number; lost: number; failed: number }> {
  const byFrame = new Map<string, Array<{ comment: ElementComment; selector: string }>>()
  for (const [commentId, selector] of legacy) {
    const comment = findComment(commentId)
    if (!comment?.frameId || !store.getFrame(comment.frameId)) continue
    const list = byFrame.get(comment.frameId) ?? []
    list.push({ comment, selector })
    byFrame.set(comment.frameId, list)
  }
  const counts = { stamped: 0, lost: 0, failed: 0 }
  const { runCanvasWrite } = await canvasWrites()
  for (const [frameId, rows] of byFrame) {
    const found: Array<{ comment: ElementComment; id: string }> = []
    const lost: ElementComment[] = []
    /* one frame's canvas at a time; the idle sweep gives it back afterwards */
    const loaded = await store.loadFrame(frameId)
    if (!loaded) continue
    const leave = (err?: unknown) => {
      counts.failed += rows.length
      console.error(`[comments] element id backfill: frame ${frameId} not written, left for the next boot:`, err)
    }
    let written: ReturnType<typeof stampElementIds>
    try {
      /* through the canvas write entry, every stamp in one write, as an operation of its own:
         committed when this resolves, and then stored before any comment names the ids */
      written = await runOperation('element id backfill', loaded.canvasId, () =>
        runCanvasWrite(loaded.canvasId, {
          type: 'stamp-element-ids',
          frameId,
          selectors: rows.map((row) => row.selector),
        }),
      )
      if (written?.frame) await persist.saveFrameNow(written.frame)
    } catch (err) {
      leave(err)
      continue
    }
    /* gone, mid-stream or refused: tried again at the next boot */
    if (!written) {
      leave('the frame is gone, being streamed into, or refused the write')
      continue
    }
    rows.forEach(({ comment }, i) => {
      const stamp = written.stamps[i]
      if (stamp && 'id' in stamp) found.push({ comment, id: stamp.id })
      else if (stamp && 'lost' in stamp) lost.push(comment)
      else {
        counts.failed++
        console.error(`[comments] element id backfill: comment ${comment.id} on frame ${frameId}:`, stamp?.error)
      }
    })
    try {
      for (const { comment, id } of found) {
        if (reanchored(comment)) continue
        comment.elementId = id
        await persist.saveCommentNow(comment)
        broadcast(comment.canvasId, { type: 'comment', comment })
        counts.stamped++
      }
      for (const comment of lost) {
        if (reanchored(comment)) continue
        await persist.saveCommentNow(comment)
        counts.lost++
      }
    } catch (err) {
      counts.failed += found.length + lost.length
      console.error(`[comments] element id backfill: frame ${frameId} not written, left for the next boot:`, err)
    }
  }
  return counts
}

/* a thread moved while the backfill awaited a write: the move replaced the
   comment in the log and saved its new anchor (spending the selector), so
   the object the backfill holds is stale and writing it would undo the move */
function reanchored(comment: ElementComment): boolean {
  return findComment(comment.id) !== comment
}

/** The element ids of several positional selectors in one frame (the boot backfill): every
 *  stamp made into the frame's HTML, then one annotation write, shown to the room when its
 *  operation commits, like every write. Per selector, in order: its id, `lost` where the path no
 *  longer resolves, or the error that stopped it. `frame` is the frame as written; absent when
 *  nothing needed writing. Undefined when the frame is gone, is being streamed into, or the
 *  write was refused. Durable once its row is stored: the caller stores it after the commit. */
export function stampElementIds(
  frameId: string,
  selectors: readonly string[],
): { frame?: Frame; stamps: Array<{ id: string } | { lost: true } | { error: unknown }> } | undefined {
  const frame = store.getFrame(frameId)
  if (!frame || isFrameStreaming(frameId)) return undefined
  let html = frame.html
  const stamps = selectors.map((selector) => {
    try {
      const result = stampElementId(html, selector)
      if (!result) return { lost: true as const }
      html = result.html
      return { id: result.id }
    } catch (error) {
      return { error }
    }
  })
  if (html === frame.html) return { stamps }
  const next = store.updateFrame(frameId, { html }, frame.updatedBy, { annotation: true })
  if (!next) return undefined
  /* sent when the write's operation commits (broadcast waits for it) */
  broadcast(next.canvasId, {
    type: 'frame:updated',
    frame: next,
    actor: resolveActor({ name: next.updatedBy, kind: 'user' }),
  })
  return { frame: next, stamps }
}

/** The canvas write entry (server/canvasWrites.ts), which imports this module: reached when a
 *  write is made rather than imported, so neither module ever loads the other half-loaded. */
const canvasWrites = () => import('./canvasWrites.ts')

/** Re-pin a thread where its root pin was dropped: on an element, on a
 *  frame as a whole or on the canvas, on any frame of the same canvas. The
 *  root and its replies move together, since replies inherit the anchor.
 *  Undefined when the comment, the frame or the page is not there. */
export const moveComment = atomic(async function moveComment(
  commentId: string,
  input: CommentAnchorInput,
  by: string,
): Promise<ElementComment | undefined> {
  const found = findComment(commentId)
  if (!found) return undefined
  const root = found.parentId ? findComment(found.parentId) : found
  if (!root) return undefined
  const canvas = store.getCanvas(root.canvasId)
  if (!canvas) return undefined
  let anchor: CommentAnchor
  if ('frameId' in input) {
    const frame = store.getFrame(input.frameId)
    if (!frame || frame.canvasId !== root.canvasId) return undefined
    anchor = await frameAnchor(frame, input, by)
    if (!store.getFrame(frame.id)) return undefined
  } else {
    if (!canvasPages(canvas).some((page) => page.id === input.pageId)) return undefined
    anchor = { pageId: input.pageId, x: input.x, y: input.y }
  }
  const fields = anchorFields(anchor)
  const list = commentLog.get(root.canvasId) ?? []
  let moved = root
  list.forEach((c, i) => {
    if (c.id !== root.id && c.parentId !== root.id) return
    const {
      frameId: _frameId,
      elementId: _elementId,
      elementOrigin: _elementOrigin,
      pageId: _pageId,
      x: _x,
      y: _y,
      ...rest
    } = c
    const next: ElementComment = { ...rest, ...fields }
    list[i] = next
    recordUndo(() => {
      const at = list.indexOf(next)
      if (at !== -1) list[at] = c
    })
    if (c.id === root.id) moved = next
    stored.saveComment(next)
    broadcast(root.canvasId, { type: 'comment', comment: next })
  })
  const frame = 'frame' in anchor ? anchor.frame : undefined
  logActivity(
    root.canvasId,
    resolveActor({ name: by, kind: 'user' }),
    frame ? `moved a comment to “${frame.name}”` : 'moved a comment onto the canvas',
    frame?.id,
  )
  return moved
})

/** A comment pinned to a point on the canvas (world coordinates on one of
 *  its pages) rather than to an element — a note about the layout, a gap
 *  between frames, or a spot where something should go. */
export function addCanvasComment(
  canvasId: string,
  input: { pageId: string; x: number; y: number; text: string; mentions?: ResolvedMentions },
  from: string,
  fromUserId?: string,
): ElementComment | undefined {
  const canvas = store.getCanvas(canvasId)
  if (!canvas || !canvasPages(canvas).some((page) => page.id === input.pageId)) return undefined
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return undefined
  return postComment(
    canvasId,
    { pageId: input.pageId, x: input.x, y: input.y },
    input.text,
    from,
    fromUserId,
    'user',
    undefined,
    input.mentions,
  )
}

/** Reply inside a thread: the reply inherits the root comment's anchor (its
 *  element, or its point on the canvas) so an @mention in it gives the agent
 *  the same anchor the conversation is about. */
export function replyToComment(
  commentId: string,
  text: string,
  from: string,
  fromUserId?: string,
  kind: ActorKind = 'user',
  mentions?: ResolvedMentions,
): ElementComment | undefined {
  const open = openThread(commentId)
  if (!open) return undefined
  const anchor = replyAnchor(open)
  if (!anchor) return undefined
  return postComment(open.root.canvasId, anchor, text, from, fromUserId, kind, open.root.id, mentions)
}

function replyAnchor({ root, frame }: { root: ElementComment; frame?: Frame }): CommentAnchor | undefined {
  if (frame) {
    const point = root.x !== undefined && root.y !== undefined ? { point: { x: root.x, y: root.y } } : {}
    return {
      frame,
      ...(root.elementId ? { elementId: root.elementId } : {}),
      snippet: root.snippet,
      ...point,
      ...(root.elementOrigin ? { elementOrigin: root.elementOrigin } : {}),
    }
  }
  return isCanvasComment(root) ? { pageId: root.pageId, x: root.x, y: root.y } : undefined
}

/** The root a reply to this comment would land under, with its frame when
 *  it is an element comment (a canvas comment has none), or undefined when
 *  the thread is resolved or its frame is gone — checked before any metering
 *  so a rejected reply never costs a resident task. */
export function openThread(commentId: string): { root: ElementComment; frame?: Frame } | undefined {
  const parent = findComment(commentId)
  if (!parent) return undefined
  const root = parent.parentId ? findComment(parent.parentId) : parent
  if (!root || root.resolvedAt) return undefined
  if (isCanvasComment(root)) return { root }
  const frame = root.frameId ? store.getFrame(root.frameId) : undefined
  if (!frame) return undefined
  return { root, frame }
}

function postComment(
  canvasId: string,
  anchor: CommentAnchor,
  text: string,
  from: string,
  fromUserId?: string,
  kind: ActorKind = 'user',
  parentId?: string,
  /** the people the text @mentions, read by the caller (server/canvasPeople.ts) */
  mentions?: ResolvedMentions,
): ElementComment | undefined {
  const clean = text.trim()
  if (!clean) return undefined
  /* @Doop, @brand, @a11y… — whichever resident agent is mentioned picks it
     up; a person's name (`@Brand Smith`) is not an agent's */
  const mentioned = mentionedRole(mentions?.roleText ?? clean, canvasRoster(canvasId))
  const list = commentLog.get(canvasId) ?? []
  /* strictly increasing per canvas: thread order is reconstructed from `at`
     after a restart, so two messages must never share a timestamp */
  const at = Math.max(Date.now(), (list[0]?.at ?? 0) + 1)
  const frame = 'frame' in anchor ? anchor.frame : undefined
  const comment: ElementComment = {
    id: nanoid(8),
    canvasId,
    ...anchorFields(anchor),
    from,
    ...(fromUserId ? { fromUserId } : {}),
    text: clean,
    at,
    ...(mentioned ? { forAgent: true, targetAgent: mentioned.name } : {}),
    ...(parentId ? { parentId } : {}),
  }
  prepend(commentLog, canvasId, comment)
  stored.saveComment(comment)
  broadcast(canvasId, { type: 'comment', comment })
  const excerpt = clean.length > 80 ? clean.slice(0, 77) + '…' : clean
  const where = frame ? `in “${frame.name}”` : 'on the canvas'
  logActivity(
    canvasId,
    resolveActor({ name: from, kind }),
    parentId
      ? `replied to a comment ${where}: “${excerpt}”`
      : frame
        ? `commented on an element in “${frame.name}”: “${excerpt}”`
        : `commented on the canvas: “${excerpt}”`,
    frame?.id,
  )
  if (comment.forAgent) {
    /* @Doop mention: the resident agent picks it up instantly (no-op without
       an API key). Dynamic import: resident depends on this module. */
    kickResident(canvasId)
  }
  emitEvent(canvasId, {
    type: parentId ? 'comment.replied' : 'comment.created',
    comment,
    frame,
    actorKind: kind,
    ...(mentions?.ids.length ? { mentions: mentions.ids } : {}),
  })
  return comment
}

/** The whole conversation a comment belongs to, oldest first. */
export function commentThread(comment: ElementComment): ElementComment[] {
  const rootId = comment.parentId ?? comment.id
  /* the log is newest-first; reverse before the (stable) sort so replies
     posted within the same millisecond keep their arrival order */
  return [...(commentLog.get(comment.canvasId) ?? [])]
    .reverse()
    .filter((c) => c.id === rootId || c.parentId === rootId)
    .sort((a, b) => a.at - b.at)
}

/** Open comments @mentioning this agent, claimed by it. */
/** A comment carries no pick, so it is claimed only by a run on the
 *  Settings default (`runner` '' or unset). */
export function takeAgentCommentsFor(
  canvasId: string,
  agentName: string,
  payer?: string,
  runner?: string,
): ElementComment[] {
  if (runner) return []
  const roster = canvasRoster(canvasId)
  const pending = (commentLog.get(canvasId) ?? []).filter(
    (c) =>
      c.forAgent &&
      !c.claimedBy &&
      !c.failedAt &&
      !c.resolvedAt &&
      (addressee(c.targetAgent, roster) ?? DEFAULT_ROLE_NAME) === agentName &&
      (payer === undefined || (c.fromUserId ?? '') === payer),
  )
  for (const c of pending) {
    edit(c).claimedBy = agentName
    c.claimedAt = Date.now()
    stored.saveComment(c)
    broadcast(canvasId, { type: 'comment', comment: c }) // pins flip to "Doop is on it"
  }
  return pending
}

export function failComment(commentId: string, reason: string): ElementComment | undefined {
  for (const [canvasId, list] of commentLog) {
    const comment = list.find((c) => c.id === commentId)
    if (!comment || comment.resolvedAt) continue
    edit(comment).failedAt = Date.now()
    comment.failureReason = reason
    stored.saveComment(comment)
    broadcast(canvasId, { type: 'comment', comment })
    return comment
  }
  return undefined
}

export function retryComment(commentId: string, by: string): ElementComment | undefined {
  for (const [canvasId, list] of commentLog) {
    const comment = list.find((c) => c.id === commentId)
    if (!comment || comment.resolvedAt) continue
    if (!comment.failedAt) return comment
    edit(comment)
    delete comment.claimedBy
    delete comment.claimedAt
    delete comment.failedAt
    delete comment.failureReason
    stored.saveComment(comment)
    broadcast(canvasId, { type: 'comment', comment })
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), 'retried a comment', comment.frameId)
    kickResident(canvasId)
    return comment
  }
  return undefined
}

/**
 * The agent answered a request with a question: the request is handed back
 * to the person as an ordinary open thread (no claim, no agent status), so
 * their answer — an @mention reply — queues fresh work with the whole
 * conversation, and nothing is resolved behind their back.
 */
export function handBackComment(commentId: string, by: string): ElementComment | undefined {
  for (const [canvasId, list] of commentLog) {
    const comment = list.find((c) => c.id === commentId)
    if (!comment || comment.resolvedAt) continue
    edit(comment)
    delete comment.claimedBy
    delete comment.claimedAt
    delete comment.failedAt
    delete comment.failureReason
    delete comment.forAgent
    delete comment.targetAgent
    stored.saveComment(comment)
    broadcast(canvasId, { type: 'comment', comment })
    logActivity(canvasId, resolveActor({ name: by, kind: 'agent' }), 'asked a question in a comment', comment.frameId)
    return comment
  }
  return undefined
}

export const resolveComment = atomic(function resolveComment(
  commentId: string,
  by: string,
): ElementComment | undefined {
  for (const [canvasId, list] of commentLog) {
    const c = list.find((x) => x.id === commentId)
    if (!c) continue
    if (c.resolvedAt) return c
    /* resolving the root closes its whole thread: an open reply under a
       resolved pin would be invisible yet still queued for an agent */
    const closing = c.parentId ? [c] : list.filter((x) => x.id === c.id || (x.parentId === c.id && !x.resolvedAt))
    for (const item of closing) {
      edit(item).resolvedBy = by
      item.resolvedAt = Date.now()
      stored.saveComment(item)
      broadcast(canvasId, { type: 'comment', comment: item })
      /* a resolved @agent comment was an instruction that got carried out —
         capture it as a decision (plain human-to-human notes are not) */
      if (item.forAgent) {
        captureDecision(canvasId, {
          text: item.text,
          source: 'comment',
          frameId: item.frameId,
          from: item.from,
          agentName: item.claimedBy ?? (by !== item.from ? by : undefined),
        })
      }
    }
    emitEvent(canvasId, {
      type: 'comment.resolved',
      comment: c,
      frame: c.frameId ? store.getFrame(c.frameId) : undefined,
      by,
    })
    return c
  }
  return undefined
})

/** Surface an agent's closing summary in the activity feed. */
export function agentSummary(canvasId: string, actor: Actor, text: string) {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return
  logActivity(canvasId, actor, `finished: “${clean.length > 220 ? clean.slice(0, 217) + '…' : clean}”`)
}

/** Longest reply a card or feedback keeps; a run's closing words are a few
 *  sentences, so this only bounds a runaway answer. */
const MAX_REPLY_CHARS = 4000

/** Keep a run's closing words on the cards and feedback it worked on: the
 *  agent's answer in the Agents tab's chat. A later stage of a pipeline card
 *  replaces its earlier stage's answer. */
export function recordWorkReply(canvasId: string, work: { cardIds: string[]; feedbackIds: string[] }, text: string) {
  const clean = text.trim()
  if (!clean) return
  const reply = clean.length > MAX_REPLY_CHARS ? `${clean.slice(0, MAX_REPLY_CHARS - 1)}…` : clean
  for (const task of taskLog.get(canvasId) ?? []) {
    if (!work.cardIds.includes(task.id)) continue
    edit(task).reply = reply
    stored.saveTask(canvasId, task)
    broadcast(canvasId, { type: 'task', task })
  }
  for (const feedback of feedbackLog.get(canvasId) ?? []) {
    if (!work.feedbackIds.includes(feedback.id)) continue
    edit(feedback).reply = reply
    stored.saveFeedback(feedback)
    broadcast(canvasId, { type: 'feedback', feedback })
  }
}

/** True if the agent has an explicitly announced (non-auto) task open. */
export function hasAnnouncedTask(canvasId: string, actor: Actor): boolean {
  return (taskLog.get(canvasId) ?? []).some((t) => isAgentsTask(t, actor) && !t.endedAt && !t.auto)
}

/** How many frames a task remembers — the Agents panel only ever jumps to the
 *  latest one; the rest are history for a sweeping multi-frame task. */
const TASK_FRAMES_CAP = 20

/** Note that the agent's open tasks touched a frame (most recent last), so a
 *  click on the task in the Agents panel can fly the camera there. A claimed
 *  card and a set_status task can be open side by side — both are the work. */
function trackTaskFrame(canvasId: string, actor: Actor, frameId: string) {
  for (const open of taskLog.get(canvasId) ?? []) {
    if (!isAgentsTask(open, actor) || open.endedAt) continue
    if (open.frameIds?.at(-1) === frameId) continue
    edit(open).frameIds = [...(open.frameIds ?? []).filter((id) => id !== frameId), frameId].slice(-TASK_FRAMES_CAP)
    stored.saveTask(canvasId, open)
    broadcast(canvasId, { type: 'task', task: open })
  }
}

/* Agents that never call set_status still get a task inferred from what
   they are visibly doing, so the Tasks panel is never silently empty. */
function autoTask(canvasId: string, actor: Actor, status: string, frameId: string) {
  const list = taskLog.get(canvasId) ?? []
  if (list.some((t) => isAgentsTask(t, actor) && !t.endedAt)) {
    trackTaskFrame(canvasId, actor, frameId) // any open task wins — it just gains the frame
    return
  }
  const task: AgentTask = {
    id: nanoid(8),
    agentName: actor.name,
    ...(actor.agentKey ? { agentKey: actor.agentKey } : {}),
    owner: actor.owner,
    color: actor.color,
    status,
    startedAt: Date.now(),
    auto: true,
    frameIds: [frameId],
  }
  prepend(taskLog, canvasId, task)
  stored.saveTask(canvasId, task)
  broadcast(canvasId, { type: 'task', task })
}

function endAutoTask(canvasId: string, actor: Actor) {
  const open = (taskLog.get(canvasId) ?? []).find((t) => isAgentsTask(t, actor) && !t.endedAt && t.auto)
  if (open) {
    edit(open).endedAt = Date.now()
    stored.saveTask(canvasId, open)
    broadcast(canvasId, { type: 'task', task: open })
  }
}

/** Close an agent's open tasks, e.g. when its presence expires. Only that
 *  agent's: another one sharing its name keeps working. */
export function endAgentTasks(canvasId: string, agent: Pick<Actor, 'name' | 'agentKey'>) {
  const agentName = agent.name
  for (const t of taskLog.get(canvasId) ?? []) {
    if (isAgentsTask(t, agent) && !t.endedAt) {
      if (t.queuedBy && t.failedAt) continue
      edit(t)
      if (t.queuedBy) {
        /* Interrupted cards pause for a human decision; never auto-retry. */
        t.failedAt = Date.now()
        t.failureReason = `${agentName} disconnected before finishing. Retry when you are ready.`
      } else {
        t.endedAt = Date.now()
      }
      stored.saveTask(canvasId, t)
      broadcast(canvasId, { type: 'task', task: t })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Board cards: humans queue work; agents claim it. Same AgentTask     */
/* object — queuedBy set, agentName empty until claimed.               */
/* ------------------------------------------------------------------ */

/** A card's text is the whole prompt the agent gets — never shorten it for
 *  display here; the board clamps long headings visually. The cap only stops
 *  a pasted document from being stored, broadcast and prompted verbatim. */
export const MAX_CARD_CHARS = 4_000

export function addQueuedCard(
  canvasId: string,
  title: string,
  from: string,
  agents?: unknown,
  attachments?: unknown,
  fromUserId?: string,
  scope?: unknown,
  runner?: unknown,
): AgentTask | undefined {
  const clean = title.trim().slice(0, MAX_CARD_CHARS)
  if (!clean || !store.getCanvas(canvasId)) return undefined
  const pipeline = normalizePipeline(agents, canvasRoster(canvasId))
  const target = parseCardScope(scope, (id) => store.getFrame(id)?.canvasId === canvasId)
  if (!target && scope && typeof scope === 'object' && 'additionalTargets' in scope) return undefined
  const pick = parseRunnerPick(runner)
  /* reference-image frame ids: only frames that actually live on this canvas */
  const refs = (Array.isArray(attachments) ? attachments : [])
    .filter((a): a is string => typeof a === 'string')
    .filter((id, i, arr) => arr.indexOf(id) === i && store.getFrame(id)?.canvasId === canvasId)
    .slice(0, 4)
  const list = taskLog.get(canvasId) ?? []
  const duplicate = list.find(
    (t) =>
      t.queuedBy === from &&
      !t.endedAt &&
      t.status === clean &&
      pipelineOf(t).join(',') === pipeline.join(',') &&
      (t.attachments ?? []).join(',') === refs.join(',') &&
      JSON.stringify(t.scope ?? null) === JSON.stringify(target ?? null) &&
      runnerKey(t.runner) === runnerKey(pick),
  )
  if (duplicate) return duplicate
  const card: AgentTask = {
    id: nanoid(8),
    agentName: '',
    color: colorFor(from),
    status: clean,
    startedAt: Date.now(),
    queuedBy: from,
    ...(fromUserId ? { queuedByUserId: fromUserId } : {}),
    pipeline,
    stage: 0,
    ...(refs.length > 0 ? { attachments: refs } : {}),
    ...(target ? { scope: target } : {}),
    ...(pick ? { runner: pick } : {}),
  }
  enqueueCards(canvasId, [card])
  stored.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(
    canvasId,
    resolveActor({ name: from, kind: 'user' }),
    `queued a card for ${pipeline.map((id) => roleName(id, canvasRoster(canvasId))).join(' → ')}: “${clean}”`,
  )
  /* the resident agents pick queued cards up instantly (no-op without a key) */
  kickResident(canvasId)
  return card
}

/** Publish a board card already committed by a durable integration job. */
export function publishQueuedCard(canvasId: string, card: AgentTask): void {
  const list = taskLog.get(canvasId) ?? []
  if (list.some((task) => task.id === card.id)) return
  enqueueCards(canvasId, [card])
  broadcast(canvasId, { type: 'task', task: card })
}

/** Put new cards at the head of the canvas's task log (the last given ends up first) and
 *  trim it; undone, the log holds what it held before, in the list it already was. */
function enqueueCards(canvasId: string, cards: AgentTask[]) {
  const had = taskLog.has(canvasId)
  const list = taskLog.get(canvasId) ?? []
  const before = [...list]
  for (const card of cards) list.unshift(card)
  taskLog.set(canvasId, trimTaskLog(list))
  recordUndo(() => {
    list.length = 0
    list.push(...before)
    if (!had && taskLog.get(canvasId) === list) taskLog.delete(canvasId)
  })
}

const TASK_LOG_CAP = 100

/** Keep the task log at its cap without losing open work: the oldest FINISHED
 *  tasks go first, so a bulk import can never push a queued, claimed or
 *  failed card off the board. Open cards past the cap are kept as well. */
export function trimTaskLog(list: AgentTask[]): AgentTask[] {
  if (list.length <= TASK_LOG_CAP) return list
  const isOpen = (t: AgentTask) => !!t.queuedBy && !t.endedAt
  let room = TASK_LOG_CAP - list.filter(isOpen).length
  const kept: AgentTask[] = []
  for (const t of list) {
    if (isOpen(t)) kept.push(t)
    else if (room > 0) {
      kept.push(t)
      room--
    }
  }
  list.length = 0
  list.push(...kept)
  return list
}

/** One repo import as board cards: the design-system extraction first (it
 *  becomes the guide the sketches follow), then one sketch card per selected
 *  screen. Structured cards — the resident runner dispatches them straight to
 *  the GitHub sketch runner (server/githubRecon.ts) instead of the chat agent.
 *  A screen already queued or in flight from the same connection is not
 *  queued twice. Returns the cards, oldest first. */
export interface RepoImportInput {
  connectionId: string
  repo: string
  screens: RepoScreenRef[]
  designSystem: boolean
  /** queue for the requester's own MCP agent, not the Doop Agent */
  outside?: boolean
}

/** What an import would queue, after removing screens already waiting or in
 *  flight from the same connection. Pure — the route checks this BEFORE
 *  spending the requester's allowance, so a no-op re-import costs nothing. */
export function planRepoCards(
  canvasId: string,
  input: RepoImportInput,
): { kind: RepoCardKind; title: string; payload: RepoCardPayload }[] {
  if (!store.getCanvas(canvasId)) return []
  const list = taskLog.get(canvasId) ?? []
  const open = list.filter((t) => t.queuedBy && !t.endedAt && t.payload?.connectionId === input.connectionId)
  const importId = nanoid(8)
  const base: RepoCardPayload = {
    connectionId: input.connectionId,
    repo: input.repo,
    importId,
    ...(input.outside ? { outside: true as const } : {}),
  }
  const wanted: { kind: RepoCardKind; title: string; payload: RepoCardPayload }[] = []
  if (input.designSystem && !open.some((t) => t.kind === 'design-system'))
    wanted.push({ kind: 'design-system', title: `Design system of ${input.repo}`, payload: base })
  for (const screen of input.screens) {
    const queued = open.some(
      (t) =>
        t.kind === 'sketch' &&
        t.payload?.screen?.sourcePath === screen.sourcePath &&
        t.payload.screen.kind === screen.kind,
    )
    if (!queued) wanted.push({ kind: 'sketch', title: screen.title, payload: { ...base, screen } })
  }
  return wanted
}

export function addRepoCards(canvasId: string, input: RepoImportInput, from: string, fromUserId: string): AgentTask[] {
  const wanted = planRepoCards(canvasId, input)
  if (!wanted.length) return []
  const actor = resolveActor({ name: from, kind: 'user' })
  const cards: AgentTask[] = []
  /* startedAt orders the queue (oldest first); a shared timestamp would leave
     the order to Map iteration, so each card sits one tick after the last */
  const at = Date.now()
  wanted.forEach((w, i) => {
    const card: AgentTask = {
      id: nanoid(8),
      agentName: '',
      color: colorFor(from),
      status: w.title.slice(0, MAX_CARD_CHARS),
      startedAt: at + i,
      queuedBy: from,
      queuedByUserId: fromUserId,
      pipeline: [DEFAULT_ROLE_ID],
      stage: 0,
      kind: w.kind,
      payload: w.payload,
    }
    stored.saveTask(canvasId, card)
    broadcast(canvasId, { type: 'task', task: card })
    cards.push(card)
  })
  enqueueCards(canvasId, cards)
  if (cards.length) {
    const sketches = cards.filter((c) => c.kind === 'sketch').length
    const what = [
      cards.some((c) => c.kind === 'design-system') ? 'the design system' : '',
      sketches ? `${sketches} ${sketches === 1 ? 'screen' : 'screens'}` : '',
    ]
      .filter(Boolean)
      .join(' and ')
    logActivity(
      canvasId,
      actor,
      `queued ${what} from ${input.repo} for ${input.outside ? 'their own agent' : roleName(DEFAULT_ROLE_ID)}`,
    )
    if (!input.outside) kickResident(canvasId)
  }
  return cards
}

/** A repo card queued for the requester's own MCP agent: no resident claims it. */
export function isOutsideCard(card: AgentTask): boolean {
  return !!card.payload?.outside
}

/** The outside repo cards `userId` queued on a canvas that still wait for an
 *  agent, oldest first: they are that person's, for their own agent alone. */
export function waitingOutsideCards(canvasId: string, userId: string | undefined): AgentTask[] {
  if (!userId) return []
  return (taskLog.get(canvasId) ?? [])
    .filter(
      (t) => t.queuedBy && isOutsideCard(t) && t.queuedByUserId === userId && !t.agentName && !t.failedAt && !t.endedAt,
    )
    .reverse()
}

/** The outside repo card `cardId`, when `agent` (connected by `userId`)
 *  holds it open. */
export function outsideCardOf(
  canvasId: string,
  cardId: string,
  agent: Actor,
  userId: string | undefined,
): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy && isOutsideCard(t))
  if (!card || card.endedAt || card.failedAt || !userId || card.queuedByUserId !== userId) return undefined
  return card.agentName && isAgentsTask(card, agent) ? card : undefined
}

/**
 * An MCP agent connected by `userId` takes the outside repo cards that person
 * queued: the ones it already holds and has not finished, then up to `limit`
 * more from the queue, design systems first (each one grounds the screens of
 * its repo). Oldest first otherwise.
 */
export function takeOutsideRepoCards(
  canvasId: string,
  agent: Actor,
  userId: string | undefined,
  limit: number,
): AgentTask[] {
  if (!userId) return []
  const list = taskLog.get(canvasId) ?? []
  const held = list
    .filter(
      (t) =>
        t.queuedBy &&
        isOutsideCard(t) &&
        t.queuedByUserId === userId &&
        !t.endedAt &&
        !t.failedAt &&
        t.agentName &&
        isAgentsTask(t, agent),
    )
    .reverse()
  const waiting = waitingOutsideCards(canvasId, userId).sort(
    (a, b) => Number(b.kind === 'design-system') - Number(a.kind === 'design-system') || a.startedAt - b.startedAt,
  )
  const claimed = waiting.slice(0, Math.max(0, limit - held.length))
  for (const c of claimed) {
    edit(c).agentName = agent.name
    if (agent.agentKey) c.agentKey = agent.agentKey
    else delete c.agentKey
    c.color = colorFor(agent.name)
    c.claimedAt = Date.now()
    stored.saveTask(canvasId, c)
    broadcast(canvasId, { type: 'task', task: c })
  }
  if (claimed.length)
    logActivity(canvasId, agent, `took ${claimed.length} repo import card${claimed.length === 1 ? '' : 's'}`)
  return [...held, ...claimed]
}

/** `userId` connected a Doop Agent plan and imported again: the cards they
 *  queued that still wait for their own agent go to the Doop Agent instead.
 *  Cards an agent already holds, and other people's, stay. Returns how many moved. */
export function handRepoCardsToDoop(canvasId: string, connectionId: string, userId: string): number {
  const moved = waitingOutsideCards(canvasId, userId).filter((c) => c.payload?.connectionId === connectionId)
  for (const c of moved) {
    const { outside: _outside, ...payload } = c.payload!
    edit(c).payload = payload
    stored.saveTask(canvasId, c)
    broadcast(canvasId, { type: 'task', task: c })
  }
  if (moved.length) kickResident(canvasId)
  return moved.length
}

/** Cards waiting on THIS agent's stage, claimed by it. A card at another
 *  stage is invisible here — that is what keeps a pipeline in order. */
/** `runner` (a `runnerKey`) narrows the claim to cards sent to one
 *  connection; unset takes them all. */
export function takeQueuedCardsFor(canvasId: string, agentName: string, payer?: string, runner?: string): AgentTask[] {
  const roster = canvasRoster(canvasId)
  const pending = (taskLog.get(canvasId) ?? []).filter(
    (t) =>
      t.queuedBy &&
      !t.agentName &&
      !t.failedAt &&
      !t.endedAt &&
      !isOutsideCard(t) &&
      stageAgent(t, roster) === agentName &&
      (payer === undefined || (t.queuedByUserId ?? '') === payer) &&
      (runner === undefined || runnerKey(t.runner) === runner),
  )
  for (const c of pending) {
    edit(c).agentName = agentName
    c.color = colorFor(agentName)
    c.claimedAt = Date.now()
    stored.saveTask(canvasId, c)
    broadcast(canvasId, { type: 'task', task: c })
  }
  return pending
}

/** An agent finished its stage: hand the card to the next agent in the
 *  pipeline, or complete it if that was the last one. */
export function advanceCard(canvasId: string, cardId: string, by: Actor): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  /* a card stopped while its run went on stays stopped */
  if (!card || card.endedAt || card.failedAt) return card
  const pipeline = pipelineOf(card)
  const next = (card.stage ?? 0) + 1
  if (next >= pipeline.length) return completeCard(canvasId, cardId)

  edit(card).stage = next
  card.agentName = ''
  delete card.claimedAt
  delete card.failedAt
  delete card.failureReason
  stored.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, by, `handed “${card.status}” to ${roleName(pipeline[next], canvasRoster(canvasId))}`)
  kickResident(canvasId)
  return card
}

export function completeCard(canvasId: string, cardId: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt) return card
  edit(card).endedAt = Date.now()
  stored.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  emitEvent(canvasId, { type: 'task.completed', task: card })
  return card
}

/** An unsuccessful card stays paused until a human explicitly retries it.
 *  Failing it again before that retry changes nothing — the first reason
 *  stands, and the failure is announced once. */
export function failCard(canvasId: string, cardId: string, reason: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt || card.failedAt) return card
  edit(card).failedAt = Date.now()
  card.failureReason = reason
  stored.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  emitEvent(canvasId, { type: 'task.failed', task: card, reason })
  /* a run whose every card is now failed lets go of its model call at once */
  kickResident(canvasId, 'onCardStopped')
  return card
}

/** A person stops a card, waiting or mid-run. It pauses like any failed card,
 *  so Retry starts it over. */
export function stopCard(canvasId: string, cardId: string, by: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt || card.failedAt) return card
  failCard(canvasId, cardId, `Stopped by ${by}.`)
  logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), `stopped a card: “${card.status}”`)
  return card
}

export function retryCard(canvasId: string, cardId: string, by: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt) return card
  if (!card.failedAt) return card
  edit(card).agentName = ''
  delete card.agentKey
  delete card.claimedAt
  delete card.failedAt
  delete card.failureReason
  stored.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), `retried a card: “${card.status}”`)
  kickResident(canvasId)
  return card
}

/* ------------------------------------------------------------------ */
/* Design history: a frame's HTML history is kept per BURST of edits,  */
/* not per write — a stream's chunks, an agent's tweak right after its  */
/* redesign, a human typing in the Inspector are each one burst. What  */
/* gets snapshotted is the state a burst starts from (where the burst  */
/* before it ended), so an agent's one-shot replace or stream can never */
/* leave itself as the only copy of a design. A full replace always    */
/* opens a burst; a small tweak joins the open one when the same actor */
/* made it within BURST_IDLE_MS. An agent's tweak opens one anyway once */
/* AGENT_VERSION_MS have passed since this frame last filed a version,  */
/* so every edit an agent makes minutes apart can be restored away.    */
/* ------------------------------------------------------------------ */

interface Burst {
  actor: Actor
  /** when this actor last wrote the frame's HTML */
  lastAt: number
  /** when this frame last filed a version (since boot), if it has */
  filedAt?: number
}

const bursts = new Map<string, Burst>() // frameId -> the burst open on it
const BURST_IDLE_MS = 2 * 60_000
/** An agent's tweak files the state it replaced when no version of the frame was filed this
 *  recently. Short enough that edits an agent makes a step at a time stay undoable, long
 *  enough that a run of quick fixes is one version. */
export const AGENT_VERSION_MS = 30_000

/** What an HTML write is to the design history: `replace` always opens a burst and files the
 *  state it replaced; `tweak` (a small edit) joins the same actor's open burst, except that an
 *  agent's files once AGENT_VERSION_MS have passed since the frame last filed; `continue` (a
 *  stream's later chunks and its settling, a component re-rendered into the frame) joins the
 *  open burst by the people's rule alone. */
type HtmlChange = 'replace' | 'tweak' | 'continue'

type PriorState = Pick<Frame, 'id' | 'canvasId' | 'html' | 'width' | 'height' | 'updatedAt' | 'updatedBy'>

/** The store mutates frames in place, so what a write replaces has to be
 *  captured before the write. */
function priorState(f: Frame): PriorState {
  const { id, canvasId, html, width, height, updatedAt, updatedBy } = f
  return { id, canvasId, html, width, height, updatedAt, updatedBy }
}

/** Record that `actor` has just replaced the frame's HTML (`change` says how, `HtmlChange`).
 *  A write that does not join the open burst starts a new one and files the state it
 *  replaced as a version. */
function noteHtmlChange(prior: PriorState, actor: Actor, change: HtmlChange) {
  const open = bursts.get(prior.id)
  const now = Date.now()
  const sameBurst =
    change !== 'replace' &&
    open !== undefined &&
    agentKeyOf(open.actor) === agentKeyOf(actor) &&
    open.actor.kind === actor.kind &&
    now - open.lastAt < BURST_IDLE_MS
  const agentStep =
    change === 'tweak' &&
    actor.kind === 'agent' &&
    (open?.filedAt === undefined || now - open.filedAt >= AGENT_VERSION_MS)
  const joins = sameBurst && !agentStep
  const files = !joins && !!prior.html
  setKey(bursts, prior.id, { actor, lastAt: now, filedAt: files ? now : open?.filedAt })
  if (!files) return
  /* the open burst wrote this state; without one (first write since boot)
     the frame's own stamp is the best attribution there is, even though a
     move or rename since may have refreshed it */
  stored.saveFrameVersion({
    id: nanoid(10),
    frameId: prior.id,
    canvasId: prior.canvasId,
    html: prior.html,
    width: prior.width,
    height: prior.height,
    savedAt: open?.lastAt ?? prior.updatedAt,
    savedBy: open?.actor.name ?? prior.updatedBy,
    savedByKind: open?.actor.kind,
    htmlBytes: prior.html.length,
  })
}

export type RestoredFrame = {
  frame: Frame
  /** the complete state the restore replaced — a client mid-reveal only
   *  holds a partial copy, so this is what its undo must put back */
  replaced: Pick<Frame, 'html' | 'width' | 'height'>
}

/** Put a frame back to one of its recorded versions (HTML and size; the name
 *  and position stay). null = no such version on this frame. The state being
 *  replaced is filed as a version first, so a restore is itself reversible. */
export const restoreFrameVersion = atomic(async function restoreFrameVersion(
  frameId: string,
  versionId: string,
  actor: Actor,
): Promise<RestoredFrame | null | undefined> {
  const version = await persist.getFrameVersion(frameId, versionId)
  if (!version) return null
  const before = store.getFrame(frameId)
  if (!before) return undefined
  const replaced = { html: before.html, width: before.width, height: before.height }
  /* a version is stored as a frame's row is, its instances as references: rendered from the
     components as they are now, then written like any other document */
  const html = store.wakeHtml(before.canvasId, version.html, frameId)
  if (before.html === html && before.width === version.width && before.height === version.height)
    return { frame: before, replaced }
  /* prepared first: a refusal (the work budget) must find the frame's stream as it was */
  const prepared = prepareWrite(before.canvasId, frameId, html, before.html, actor.name)
  /* whoever restores takes over: any live stream or playback ends */
  finishStream(frameId, false)
  finishReveal(frameId)
  const prior = priorState(before)
  const patch = { html: prepared.html, width: version.width, height: version.height }
  const frame = store.updateFrame(frameId, patch, actor.name)
  if (!frame) return undefined
  noteHtmlChange(prior, actor, 'replace')
  broadcast(frame.canvasId, { type: 'frame:updated', frame, actor })
  if (prepared.changed.length) propagateFromFrameWrite(frame.canvasId, prepared.changed, actor, frameId)
  logActivity(frame.canvasId, actor, `restored “${frame.name}” to an earlier version by ${version.savedBy}`, frame.id)
  touch(frame.canvasId, actor, frame.id)
  return { frame, replaced }
})

/* ------------------------------------------------------------------ */
/* Live rendering of agent writes.                                     */
/*                                                                     */
/* Streams (append_frame_html): every chunk broadcasts the moment it   */
/* arrives — viewers track the agent's real progress with no artificial*/
/* pacing. Stream state only carries the "designing…" badge, the       */
/* escape latch, and a timeout for agents that never send done=true.   */
/*                                                                     */
/* One-shot writes (set_frame_html, agent create_frame with html) play */
/* back as a short typewriter reveal so a paste reads as designing     */
/* rather than blinking in — drained against a fixed deadline so       */
/* playback time never grows with document size.                       */
/* ------------------------------------------------------------------ */

interface StreamState {
  actor: Actor
  /** the opening chunk was HTML-escaped: decode every chunk of this stream */
  escaped: boolean
  lastActivity: number
  /** the frame's HTML before the opening chunk replaced it: what a later chunk
   *  may carry over (server/inlineData.ts compares against it) */
  base: string
  /** the end of the agent's stream as it sent it, before components expanded: what the
   *  next chunk is joined to, so base64 split across chunks is seen whole */
  tail: string
}

/* enough for a data: URI's prefix split across two chunks, and for a block of base64 text sent
   in pieces: a run is refused once it reaches EMBEDDED_MIN_LENGTH (server/inlineData.ts), so one
   still growing at the end of the stream is shorter than that and is held here whole */
const STREAM_TAIL_CHARS = Math.max(256, EMBEDDED_MIN_LENGTH)

const streams = new Map<string, StreamState>() // frameId -> state

/** The HTML a frame had before its live stream began, or undefined when none is open. */
export function streamBase(frameId: string): string | undefined {
  return streams.get(frameId)?.base
}

/** The end of the last chunk an open stream received, as the agent wrote it. */
export function streamTail(frameId: string): string | undefined {
  return streams.get(frameId)?.tail
}

interface RevealState {
  /** started by an operation that has not committed yet: viewers have not heard of this
   *  write, so the playback does not tick until they have */
  held?: boolean
  actor: Actor
  /** how many chars of the frame's html are currently revealed to viewers */
  shown: number
  /** when the playback should have fully drained */
  deadline: number
}

const reveals = new Map<string, RevealState>() // frameId -> state

const TICK_MS = 80
const REVEAL_MIN_MS = 2500 // even a tiny one-shot plays for a beat
const REVEAL_MAX_MS = 5000 // even a huge one-shot lands within 5s
const REVEAL_CHARS_PER_MS = 8
const STREAM_IDLE_MS = 30_000

function revealDuration(chars: number): number {
  return Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, chars / REVEAL_CHARS_PER_MS))
}

/** Make partially-revealed HTML paint sensibly. */
export function healPartialHtml(html: string): string {
  // drop a trailing half-written tag: "<div cla"
  const lastOpen = html.lastIndexOf('<')
  if (lastOpen > html.lastIndexOf('>')) html = html.slice(0, lastOpen)
  // drop an unclosed <script> entirely — never run half-written JS
  const scriptAt = lastIndexOfAscii(html, '<script')
  if (scriptAt !== -1 && indexOfAscii(html, '</script', scriptAt) === -1) html = html.slice(0, scriptAt)
  // close an unclosed <style> so everything after it renders
  const styleAt = lastIndexOfAscii(html, '<style')
  if (styleAt !== -1 && indexOfAscii(html, '</style', styleAt) === -1) html += '</style>'
  return html
}

/** What viewers have of a frame mid-playback: the first `shown` chars, healed to paint. */
function revealedHtml(frame: Frame, shown: number): string {
  return shown >= frame.html.length ? frame.html : healPartialHtml(frame.html.slice(0, shown))
}

/** The frame as viewers have it, for a broadcast that does not change its design (a
 *  rename, resize, restack or sign-off): mid-playback the part revealed so far, or the
 *  finished design would flash in before the playback goes on from where it was; mid-stream
 *  what arrived, healed like every chunk, so a script cut off mid-way never runs. */
function frameForViewers(frame: Frame): Frame {
  const playing = reveals.get(frame.id)
  if (playing) return { ...frame, html: revealedHtml(frame, playing.shown) }
  return streams.has(frame.id) ? { ...frame, html: healPartialHtml(frame.html) } : frame
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/** Where two documents diverge, and how much they share at the start plus
 *  the end. An edit in one spot (a find/replace, typing in one element)
 *  leaves nearly everything shared however early in the document it sits;
 *  only a rewrite scores low. */
function sharedSpan(a: string, b: string): { prefix: number; shared: number } {
  const prefix = commonPrefixLen(a, b)
  const room = Math.min(a.length, b.length) - prefix
  let suffix = 0
  while (suffix < room && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  return { prefix, shared: prefix + suffix }
}

function startReveal(frame: Frame, actor: Actor, shown: number) {
  const reveal: RevealState = {
    held: inTransaction(),
    actor,
    shown,
    deadline: Date.now() + revealDuration(frame.html.length - shown),
  }
  setKey(reveals, frame.id, reveal)
  afterCommit(() => {
    reveal.held = false
  })
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId: frame.id, active: true, actor })
}

function finishReveal(frameId: string) {
  const r = reveals.get(frameId)
  if (!r) return
  dropKey(reveals, frameId)
  const frame = store.getFrame(frameId)
  if (!frame) return
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: false, actor: r.actor })
  endAutoTask(frame.canvasId, r.actor)
}

function finishStream(frameId: string, logDone: boolean) {
  const s = streams.get(frameId)
  if (!s) return
  dropKey(streams, frameId)
  dropKey(streamIssues, frameId)
  /* background work that waited for this stream (a detach-all) takes its turn now */
  afterCommit(() => propagation.resumeFrame(frameId))
  const current = store.getFrame(frameId)
  if (!current) return
  /* a stream that ends without its done chunk (the agent went idle, or a
     replace cut it off) still gets the faces of the library fonts it uses;
     a finished one already has them, and this is then a no-op */
  let renamed = current.html
  for (const { rename, marks } of pendingRenames.get(frameId) ?? [])
    renamed = advanceInstanceMarks(applyRename(renamed, rename), marks)
  dropKey(pendingRenames, frameId)
  const html = storedHtml(current.canvasId, withCanvasStyles(current.canvasId, renamed))
  /* compare the HTML, not the objects: updateFrame edits the frame in place */
  const htmlChanged = !sameStored(current.canvasId, html, current.html)
  const frame = htmlChanged ? store.updateFrame(frameId, { html }, s.actor.name)! : current
  /* the store keeps what arrived; viewers get it healed, like every chunk,
     so a script cut off mid-way never runs in their frames */
  if (htmlChanged)
    broadcast(frame.canvasId, {
      type: 'frame:updated',
      frame: { ...frame, html: healPartialHtml(frame.html) },
      actor: s.actor,
    })
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: false, actor: s.actor })
  if (logDone) logActivity(frame.canvasId, s.actor, `finished designing “${frame.name}”`, frameId)
  endAutoTask(frame.canvasId, s.actor)
}

setInterval(() => {
  const now = Date.now()
  for (const [frameId, r] of reveals) {
    if (r.held) continue
    const frame = store.getFrame(frameId)
    if (!frame) {
      reveals.delete(frameId)
      continue
    }
    /* its page left memory mid-playback: whoever reads it next gets it whole */
    if (!htmlLoaded(frame)) {
      finishReveal(frameId)
      continue
    }
    const total = frame.html.length
    const remaining = total - r.shown

    if (remaining <= 0) {
      /* fully revealed: emit the exact html and close */
      broadcast(frame.canvasId, { type: 'frame:updated', frame, actor: r.actor })
      finishReveal(frameId)
      continue
    }

    /* drain the rest evenly so the playback lands exactly at the deadline */
    const ticksLeft = Math.max(1, Math.ceil((r.deadline - now) / TICK_MS))
    r.shown = Math.min(total, r.shown + Math.ceil(remaining / ticksLeft))
    broadcast(frame.canvasId, {
      type: 'frame:updated',
      frame: { ...frame, html: revealedHtml(frame, r.shown) },
      actor: r.actor,
    })
  }
  settleIdle(now)
}, TICK_MS)

/* What settles idle streams on each tick: the server's write entry installs it
   (`wireCanvasWrites`, server/canvasWrites.ts, called at boot), so that settling runs through
   the entry like every other write. Unwired, idle streams cannot settle, and that is said, once,
   rather than left quiet. */
let idleSettler: ((now: number) => void) | undefined
let unwiredSaid = false

function settleIdle(now: number) {
  if (idleSettler) return idleSettler(now)
  if (unwiredSaid || !idleStreams(now).length) return
  unwiredSaid = true
  console.error('[streams] idle streams cannot settle: wireCanvasWrites() was not called in this process')
}

/** Settle idle streams with `settle` on every tick. */
export function settleIdleStreamsWith(settle: (now: number) => void) {
  idleSettler = settle
}

/** One stream nobody has sent to for `STREAM_IDLE_MS`, as it stood when it was found idle. */
export type IdleStream = {
  frameId: string
  /** undefined for a frame that is gone, whose stream settling only closes */
  canvasId: string | undefined
  /** when it last received a chunk: it is settled only while that is still so */
  lastActivity: number
}

/** The streams nobody has sent to for `STREAM_IDLE_MS`: an agent that died mid-stream never
 *  sends the last chunk. The server settles each through the canvas write entry
 *  (`settleIdleStreams`, server/canvasWrites.ts). */
export function idleStreams(now = Date.now()): IdleStream[] {
  return [...streams]
    .filter(([, s]) => now - s.lastActivity > STREAM_IDLE_MS)
    .map(([frameId, s]) => ({ frameId, canvasId: store.getFrame(frameId)?.canvasId, lastActivity: s.lastActivity }))
}

/** Settle an idle stream: its frame's whole-document pass (a component change skipped while
 *  it streamed, the stylesheets, a main written in it) and its close, as one piece of work,
 *  so a refusal part of the way leaves the frame, its components and the room as they were.
 *  Only the stream that was found idle: one that has received a chunk since, or been begun
 *  again, is left open (false). */
export function settleStream(frameId: string, lastActivity: number): boolean {
  const s = streams.get(frameId)
  if (!s || s.lastActivity !== lastActivity) return false
  settleIdleStream(frameId, s)
  return true
}

/** Close a stream without settling it: what a stream whose settling was refused gets, so it
 *  does not stay open. The frame's next write settles it. Only the stream that was found idle,
 *  as `settleStream`. */
export function closeStream(frameId: string, lastActivity: number): boolean {
  const s = streams.get(frameId)
  if (!s || s.lastActivity !== lastActivity) return false
  finishStream(frameId, false)
  return true
}

/** The settling pass of a stream nobody closed, and its close: one operation, so a refusal
 *  part of the way leaves the frame, its components and the room as they were. */
function settleIdleStream(frameId: string, s: StreamState) {
  const before = store.getFrame(frameId)
  const prepared = before ? prepareWrite(before.canvasId, before.id, before.html, before.html, s.actor.name) : undefined
  if (before && prepared && !sameStored(before.canvasId, prepared.html, before.html)) {
    const prior = priorState(before)
    const frame = store.updateFrame(frameId, { html: prepared.html }, s.actor.name)!
    noteHtmlChange(prior, s.actor, 'continue')
    /* viewers get it healed, like every chunk, so a script cut off mid-way never runs */
    broadcast(frame.canvasId, {
      type: 'frame:updated',
      frame: { ...frame, html: healPartialHtml(frame.html) },
      actor: s.actor,
    })
  }
  finishStream(frameId, false)
  if (before && prepared?.changed.length) propagateFromFrameWrite(before.canvasId, prepared.changed, s.actor, frameId)
}

/** A deleted frame held a component's main: the component points at another
 *  frame carrying the marker if there is one, else at no main, so the catalog
 *  never hands out a frame that is gone. */
function releaseMains(canvasId: string, frameId: string, actor: Actor) {
  for (const def of store.getComponents(canvasId)) {
    if (def.mainFrameId !== frameId) continue
    const marker = `${COMPONENT_ATTR}="${def.id}"`
    const elsewhere = store.getCanvas(canvasId)?.frames.find((frame) => frame.html.includes(marker))
    const released = { ...def, mainFrameId: elsewhere?.id ?? null, updatedAt: Date.now(), updatedBy: actor.name }
    store.saveComponent(canvasId, released)
    broadcastComponent(canvasId, released, actor)
  }
}

/* ------------------------------------------------------------------ */
/* Components: every frame write passes through prepareFrameHtml, and  */
/* a main that changed reaches every frame that uses it.               */
/* ------------------------------------------------------------------ */

const componentIssues = new Map<string, ComponentIssue[]>()
/** What a stream's chunks had to say about the uses they expanded, held for its done chunk. */
const streamIssues = new Map<string, ComponentIssue[]>()

/** What the last write to this frame had to say about its components; reading clears it. */
export function takeComponentIssues(frameId: string): ComponentIssue[] {
  const issues = componentIssues.get(frameId) ?? []
  dropKey(componentIssues, frameId)
  return issues
}

/** What the last write to this frame had to say about its components, left for whoever takes them. */
export function peekComponentIssues(frameId: string): readonly ComponentIssue[] {
  return componentIssues.get(frameId) ?? []
}

/** Something found out about a frame's last write after it landed: heard with the rest. */
export function addComponentIssue(frameId: string, issue: ComponentIssue) {
  setKey(componentIssues, frameId, [...(componentIssues.get(frameId) ?? []), issue])
}

function prepareWrite(
  canvasId: string,
  frameId: string,
  html: string,
  priorHtml: string,
  by: string,
  { carried = [], refuseUnclosed = false }: { carried?: ComponentIssue[]; refuseUnclosed?: boolean } = {},
) {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return { html, changed: [] as ComponentDef[] }
  const prepared = prepareFrameHtml(canvas, frameId, html, by, priorHtml, { refuseUnclosed })
  const issues = dedupeIssues([...carried, ...prepared.issues])
  if (issues.length) setKey(componentIssues, frameId, issues)
  else dropKey(componentIssues, frameId)
  /* no new revision, so no propagation either: only "Go to main" needs to hear of it */
  for (const def of prepared.moved) broadcastComponent(canvasId, def, resolveActor({ name: by, kind: 'user' }))
  announceAdopted(canvasId, prepared.adopted, resolveActor({ name: by, kind: 'user' }), true)
  /* faces after the components: an expanded <doop-use> may name a library family. The
     font scan reads the composed document (a component's rules, a font token's value);
     what is stored is its source (server/frameCompose.ts) */
  return { ...prepared, html: storedHtml(canvasId, withCanvasFaces(canvasId, prepared.html)) }
}

/** Components a canvas just took up from its workspace library: the room gets
 *  the definitions, and the canvas the library's tokens they name and it lacks
 *  (an existing token of the same name is left alone). Inside a frame write the
 *  token pass waits for that write to land, since adding tokens restyles frames. */
export function announceAdopted(canvasId: string, adopted: ComponentDef[], actor: Actor, withinWrite = false) {
  if (!adopted.length) return
  for (const def of adopted) broadcastComponent(canvasId, def, actor)
  const names = adopted.map((def) => `“${def.name}”`).join(', ')
  logComponent(canvasId, actor, `added ${names} from the workspace library`)
  if (!withinWrite) return carryLibraryTokens(canvasId, adopted, actor)
  /* once the write has landed and been sent, as a write of its own: through the canvas write
     entry, which installs the carrier (`carryAdoptedTokensWith`) */
  const carry = () => carryAdopted(canvasId, adopted, actor)
  if (inTransaction()) postCommit(carry)
  else queueMicrotask(carry)
}

/* What carries the tokens of components a frame write took up, once that write has landed: the
   server's write entry installs it (`wireCanvasWrites`, server/canvasWrites.ts, called at boot),
   so that the carry runs through the entry like every other write. Unwired, the carry runs here
   as it did before the entry, and that it bypassed the entry is said, once. */
let adoptedTokenCarrier: ((canvasId: string, componentIds: string[], actor: Actor) => void) | undefined
let carryUnwiredSaid = false

function carryAdopted(canvasId: string, adopted: ComponentDef[], actor: Actor) {
  if (adoptedTokenCarrier)
    return adoptedTokenCarrier(
      canvasId,
      adopted.map((def) => def.id),
      actor,
    )
  /* unwired: carried here, as before the entry, rather than lost */
  if (!carryUnwiredSaid && libraryTokensMissing(canvasId, adopted).length) {
    carryUnwiredSaid = true
    console.error(
      '[library] carrying adopted components’ tokens outside the canvas write entry: wireCanvasWrites() was not called',
    )
  }
  carryLibraryTokens(canvasId, adopted, actor)
}

/** Carry the tokens of components a frame write took up with `carry`, once that write lands. */
export function carryAdoptedTokensWith(carry: (canvasId: string, componentIds: string[], actor: Actor) => void) {
  adoptedTokenCarrier = carry
}

/** Create the library's tokens these linked components name and the canvas
 *  lacks: on first use, and again when a pulled update starts naming new ones. */
export function carryLibraryTokens(canvasId: string, adopted: ComponentDef[], actor: Actor) {
  const missing = libraryTokensMissing(canvasId, adopted)
  if (!missing.length || !store.getCanvas(canvasId)) return []
  const inputs = aliasesLast(missing).map(({ name, type, value, themes, description }) => ({
    name,
    type,
    value,
    ...(themes ? { themes } : {}),
    ...(description ? { description } : {}),
  }))
  return createTokens(canvasId, inputs, actor) ?? []
}

/** The library's tokens these linked components name and the canvas lacks, by name. */
function libraryTokensMissing(canvasId: string, adopted: ComponentDef[]): DesignToken[] {
  const have = new Set(store.getTokens(canvasId).map((token) => token.name))
  const missing = new Map<string, DesignToken>()
  for (const def of adopted) {
    if (!def.source) continue
    const used = tokensUsedBy(`${def.template}\n${def.css}`, store.getTokens(def.source.canvasId))
    for (const token of used) if (!have.has(token.name)) missing.set(token.name, token)
  }
  return [...missing.values()]
}

/** Tokens ordered so each comes after the ones its values read: an alias is
 *  refused while what it points at does not exist yet. */
function aliasesLast(tokens: DesignToken[]): DesignToken[] {
  const placed = new Set<string>()
  const ordered: DesignToken[] = []
  const names = new Set(tokens.map((token) => token.name))
  const reads = (token: DesignToken) =>
    [token.value, ...Object.values(token.themes ?? {})].flatMap(referencedTokens).filter((name) => names.has(name))
  let waiting = tokens
  while (waiting.length) {
    const ready = waiting.filter((token) => reads(token).every((name) => placed.has(name)))
    /* a cycle cannot be ordered: hand the rest over and let each be refused on its own */
    const next = ready.length ? ready : waiting
    for (const token of next) {
      placed.add(token.name)
      ordered.push(token)
    }
    waiting = waiting.filter((token) => !placed.has(token.name))
  }
  return ordered
}

/** A component's own line in the activity feed. */
/** A component that is no longer on the canvas at all (an import taken back): not a soft delete. */
export function broadcastComponentGone(canvasId: string, id: string, actor: Actor) {
  broadcast(canvasId, { type: 'component', id, component: null, actor })
}

export function logComponent(canvasId: string, actor: Actor, line: string) {
  logActivity(canvasId, actor, line)
  touch(canvasId, actor)
}

export function broadcastComponent(canvasId: string, component: ComponentDef, actor: Actor) {
  broadcast(canvasId, { type: 'component', id: component.id, component: wireComponent(component), actor })
}

/** A library published or withdrew something: every canvas of its workspace hears,
 *  the library canvas included (its own panel shows what is still unpublished). */
export function broadcastLibrary(library: Pick<Canvas, 'id' | 'workspaceId'>, actor: Actor) {
  for (const canvas of store.allCanvases()) {
    if (canvas.id === library.id || (library.workspaceId && canvas.workspaceId === library.workspaceId))
      broadcast(canvas.id, { type: 'library', actor })
  }
}

/** A canvas moved between a workspace and its owner's personal space (or got
 *  an owner): its team is now another scope's, so its room hears the new one. */
export function announceTeam(canvasId: string) {
  const canvas = store.getCanvas(canvasId)
  if (canvas) broadcast(canvas.id, { type: 'team', team: teamOfCanvas(canvas) })
}

/** A workspace's (or a person's own) custom agents changed: every canvas
 *  that takes its agents from there gets the new list, so its mention picker
 *  and its automation steps offer what the team now has. */
export function broadcastCustomAgents(scope: { workspaceId: string } | { ownerId: string }) {
  for (const canvas of store.allCanvases()) {
    const hears =
      'workspaceId' in scope
        ? canvas.workspaceId === scope.workspaceId
        : !canvas.workspaceId && canvas.ownerId === scope.ownerId
    if (hears) broadcast(canvas.id, { type: 'team', team: teamOfCanvas(canvas) })
  }
}

export type PropagationReport = propagation.DrainReport

/** Propagation an operation still open has asked for: it enters the queue at the commit. */
const propagationAsked = new Map<string, true>()

/** Is this component waiting to be carried to frames of the canvas: in the queue, or asked
 *  for by the operation in progress and queued when it commits? */
export function propagationPending(canvasId: string, componentId: string): boolean {
  return propagationAsked.has(`${canvasId}:${componentId}`) || propagation.isPending(canvasId, 'propagate', componentId)
}

/** A frame write that changed a main. Every other frame using it that is in memory is
 *  rendered again in the background (server/propagation.ts); one that is not is rendered
 *  from the component when its page is read. With DOOP_DEFER_COMPONENT_PROPAGATION the
 *  frames in memory catch up on their own next write, or the next read of their page. */
function propagateFromFrameWrite(canvasId: string, changed: ComponentDef[], actor: Actor, originFrameId: string) {
  if (env.DOOP_DEFER_COMPONENT_PROPAGATION) {
    for (const def of changed) broadcastComponent(canvasId, def, actor)
    return
  }
  queuePropagation(canvasId, changed, actor, originFrameId)
}

/** A main changed: tell the room now, and queue the frames in memory to be rendered again,
 *  one per tick (every frame, on a canvas whose frames live on an actor). Returns at once;
 *  nothing is read or rewritten here. `originFrameId` is the frame whose write this came
 *  from, which already has the change. */
export function queuePropagation(canvasId: string, changed: ComponentDef[], actor: Actor, originFrameId?: string) {
  for (const def of changed) broadcastComponent(canvasId, def, actor)
  /* nothing follows a deleted component: its instances keep the markup they have */
  const followed = changed.filter((def) => !isDeleted(def)).map((def) => def.id)
  const canvas = store.getCanvas(canvasId)
  const whole = propagationScope(canvasId) === 'all'
  const others = canvas?.frames.some((frame) => frame.id !== originFrameId && (whole || htmlLoaded(frame))) ?? false
  const asked = others ? followed.map((id) => `${canvasId}:${id}`) : []
  for (const key of asked) setKey(propagationAsked, key, true)
  /* queued with the commit: a refused write has asked for nothing */
  afterCommit(() => {
    for (const key of asked) propagationAsked.delete(key)
    propagation.enqueue('propagate', canvasId, followed, actor, { exceptFrameId: originFrameId })
  })
}

/** Which frames follow a changed main through the queue: the ones in memory, since a frame
 *  at rest holds references and is rendered from its components when read
 *  (server/frameRest.ts). */
function propagationScope(_canvasId: string): 'all' | 'loaded' {
  return 'loaded'
}

/** One frame's turn in the queue. Where what the frame stores is unchanged (its instances are
 *  references, and the component is what moved) it is rendered again in memory and the room
 *  shown the new rendering: no row, no version, and `updatedAt` stays, so a save in flight
 *  is not refused for it. Otherwise (an instance stored written out, a main built from
 *  what changed, a canvas on an actor, compact storage switched off) it is an ordinary
 *  write: history is filed and the room sees frame:updated. Sign-off stands either way,
 *  since the frame itself was not edited. A frame mid-stream catches up when its stream ends. */
export function propagateIntoFrame(
  canvasId: string,
  frameId: string,
  componentIds: string[],
  actor: Actor,
): propagation.FrameOutcome {
  const canvas = store.getCanvas(canvasId)
  const frame = store.getFrame(frameId)
  if (!canvas || !frame || frame.canvasId !== canvasId) return {}
  /* left memory since it was queued: rendered from its components when its page is next read */
  if (!htmlLoaded(frame)) return {}
  /* a one-shot reveal is only playback of what is already stored, so it updates like any frame */
  const followed = componentIds.filter((id) => !isDeleted(canvas.components?.find((def) => def.id === id)))
  if (streams.has(frame.id) || !followed.some((id) => referencesComponent(frame.html, id))) return {}
  const stamp = frame.updatedAt
  const prepared = prepareFrameHtml(canvas, frame.id, frame.html, actor.name, frame.html)
  /* a main in this frame that is built from what changed: its own instances are next */
  if (prepared.changed.length) queuePropagation(canvasId, prepared.changed, actor)
  /* the ordinary write's font pass too: a main that took up a library family
     brings its face along to every frame it reaches */
  const html = storedHtml(canvasId, withCanvasFaces(canvasId, prepared.html))
  const latest = store.getFrame(frameId)
  if (!latest) return {}
  /* written underneath the preparation: what was prepared is of an older frame */
  if (latest.updatedAt !== stamp) return { requeue: true }
  /* a change to the component's rules alone leaves the frame's source as it is (instances
     are marked with the revision their markup last changed at, `renderRev`): no row, no
     version, no message. The room restyles from the `component` message */
  if (sameStored(canvasId, html, latest.html)) return {}
  /* the comparison out of budget, or tripping on markup: the ordinary write below needs none */
  const sameSource = storesCompactly(canvas) && sameAtRestOrNot(html, latest.html, canvas.components ?? [])
  if (sameSource) {
    const rendered = store.rerenderFrame(latest.id, html)
    if (!rendered) return {}
    /* no row is written, so the write's own asset bookkeeping does not run: the images the
       frame shows are what agents are told it holds */
    afterCommit(() => persist.refreshAssetRefs(rendered))
    broadcast(canvasId, { type: 'frame:updated', frame: rendered, actor, rerender: true })
    return { touched: { id: rendered.id, name: rendered.name, approvalLost: false } }
  }
  const prior = priorState(latest)
  /* a component it uses changed, not the frame: sign-off stands (decided 2026-11-12) */
  const updated = store.updateFrame(latest.id, { html }, actor.name, { annotation: true })
  if (!updated) return {}
  noteHtmlChange(prior, actor, 'continue')
  broadcast(canvasId, { type: 'frame:updated', frame: updated, actor })
  return { touched: { id: updated.id, name: updated.name, approvalLost: false } }
}

function propagationDrained(canvasId: string, report: PropagationReport, actor: Actor) {
  if (!report.frames.length) return
  const names = report.components.flatMap((id) => {
    const def = store.getComponents(canvasId).find((candidate) => candidate.id === id)
    return def ? [`“${def.name}”`] : []
  })
  const lost = report.frames.filter((frame) => frame.approvalLost).length
  const count = report.frames.length
  logActivity(
    canvasId,
    actor,
    `updated ${names.join(', ')} in ${count} frame${count === 1 ? '' : 's'}${
      lost ? `; ${lost} approved frame${lost === 1 ? '' : 's'} now need${lost === 1 ? 's' : ''} review` : ''
    }`,
  )
  touch(canvasId, actor)
}

/** `sameAtRest`, false when it cannot say: the frame is then written like any other. */
function sameAtRestOrNot(a: string, b: string, defs: readonly ComponentDef[]): boolean {
  try {
    return sameAtRest(a, b, defs)
  } catch (error) {
    if (!(error instanceof WorkBudgetError)) console.error('[frames] comparing a frame at rest failed', error)
    return false
  }
}

propagation.registerFrameTask('propagate', {
  scope: propagationScope,
  frame: propagateIntoFrame,
  drained: propagationDrained,
})

/**
 * Give hollow definitions their markup back from their mains, as the next write of each main
 * would: rows that lost it when an older write landed last, before writes to a component row
 * were queued (2026-11-11). One canvas at a time, after boot; nothing to do once every
 * definition is whole. Instances need no update (they were rendered from what the main
 * holds), and the main's frame is written only when the pass marked it up (part keys), as an
 * annotation that leaves sign-off standing.
 */
export async function healHollowComponents(): Promise<{
  healed: number
  noMain: number
  failed: number
}> {
  const counts = { healed: 0, noMain: 0, failed: 0 }
  const hollowOn = (canvas: Canvas) =>
    (canvas.components ?? []).filter((def) => isHollow(def) && !isDeleted(def) && !def.source?.library)
  for (const listed of store.allCanvases()) {
    const waiting = hollowOn(listed).length
    if (!waiting) continue
    try {
      await store.withCanvas(listed.id, async (canvas) => {
        if (canvas) healCanvas(canvas, counts)
      })
    } catch (err) {
      /* this canvas could not be read: the rest still get theirs, and the next boot tries again */
      counts.failed += waiting
      console.error(`[components] healing hollow definitions on ${listed.id}: the canvas did not load`, err)
    }
  }
  return counts
}

function healCanvas(canvas: Canvas, counts: { healed: number; noMain: number; failed: number }) {
  const byFrame = new Map<Frame, Set<string>>()
  for (const def of canvas.components ?? []) {
    if (!isHollow(def) || isDeleted(def) || def.source?.library) continue
    const main = canvas.frames.find((frame) => frame.html.includes(`${COMPONENT_ATTR}="${def.id}"`))
    if (!main) {
      counts.noMain++
      continue
    }
    byFrame.set(main, (byFrame.get(main) ?? new Set()).add(def.id))
  }
  for (const [frame, ids] of byFrame) {
    try {
      transaction(() => healFromMain(canvas, frame, ids))
    } catch (err) {
      console.error(`[components] healing ${[...ids].join(', ')} from frame ${frame.id} failed:`, err)
    }
    for (const id of ids) {
      if (isHollow(store.getComponents(canvas.id).find((def) => def.id === id))) counts.failed++
      else counts.healed++
    }
  }
}

/** The definitions only: the frame is written just where a main needed part keys, as an
 *  annotation, since nothing in it looks different. */
function healFromMain(canvas: Canvas, frame: Frame, ids: ReadonlySet<string>) {
  const actor = resolveActor({ name: frame.updatedBy, kind: 'user' })
  const { html, saved } = rederiveFromMains(canvas, frame.id, ids, actor.name)
  for (const def of saved) broadcastComponent(canvas.id, def, actor)
  if (html === frame.html) return
  const next = store.updateFrame(frame.id, { html }, frame.updatedBy, { annotation: true })
  if (next) broadcast(canvas.id, { type: 'frame:updated', frame: next, actor })
}

export function appendFrameHtml(
  frameId: string,
  chunk: string,
  actor: Actor,
  opts: { start?: boolean; done?: boolean } = {},
): Frame | undefined {
  try {
    return appendChunk(frameId, chunk, actor, opts)
  } catch (error) {
    /* a last chunk refused for a <doop-use> it leaves open: the stream stays open for it to come
       again, and that counts as the agent at work, so the idle sweep does not settle the stream
       meanwhile. Set past the chunk's undo, and not journaled, so the refusal's undo keeps it */
    const stream = error instanceof WriteRefusedError ? streams.get(frameId) : undefined
    if (stream) stream.lastActivity = Date.now()
    throw error
  }
}

const appendChunk = atomic(function appendChunk(
  frameId: string,
  chunk: string,
  actor: Actor,
  opts: { start?: boolean; done?: boolean },
): Frame | undefined {
  const before = store.getFrame(frameId)
  if (!before) return undefined

  const starting = opts.start || !streams.has(frameId)
  /* read now: the store updates `before` in place below */
  const base = before.html
  /* an agent that escapes its opening chunk escapes the whole stream, so latch
     the verdict there: a chunk mid-design can hold a legitimate `&lt;` (a code
     sample) and must never be sniffed on its own */
  const escaped = starting ? looksEscapedHtml(chunk) : (streams.get(frameId)?.escaped ?? false)
  const piece = escaped ? decodeEscapedHtml(chunk) : chunk
  const canvas = store.getCanvas(before.canvasId)
  /* the chunk's own pass can take up a library component, and the last chunk's whole-frame
     pass below can still be refused (the work budget): the write boundary undoes it then */
  const chunked = canvas
    ? prepareChunk(canvas, piece, opts.start ? '' : before.html, actor.name)
    : { html: piece, issues: [], adopted: [] }
  /* a tag left open in an override is whole already: no later chunk closes it, and waiting for the
     done chunk would leave this one saved, so the chunk is refused now */
  if (actor.kind === 'agent') refuseUnclosedUses(chunked.issues.filter((issue) => issue.inOverride))
  const expanded = chunked.html
  const carried = [...(starting ? [] : (streamIssues.get(frameId) ?? [])), ...chunked.issues]
  /* the last chunk settles the whole document: a <doop-use> split across
     chunks, the component stylesheets, a main written in the stream, the
     faces of the library fonts it names. Until then each chunk gets the
     canvas's tokens and fonts, so a mid-stream screenshot shows them. A
     token renamed mid-stream waits for the stream to close (pendingRenames):
     until then the block stays as written, under the names the frame uses. */
  const joined = opts.start ? expanded : before.html + expanded
  const prepared = opts.done
    ? prepareWrite(before.canvasId, before.id, joined, before.html, actor.name, {
        carried,
        refuseUnclosed: actor.kind === 'agent',
      })
    : {
        html: pendingRenames.has(frameId)
          ? joined
          : storedHtml(before.canvasId, withCanvasFacesMidStream(before.canvasId, joined)),
        changed: [] as ComponentDef[],
      }
  const html = prepared.html
  if (opts.done) dropKey(streamIssues, frameId)
  else setKey(streamIssues, frameId, carried)
  const prior = priorState(before)
  const frame = store.updateFrame(frameId, { html }, actor.name)!
  /* the opening chunk replaces the design; every later one extends this burst */
  noteHtmlChange(prior, actor, starting ? 'replace' : 'continue')
  announceAdopted(before.canvasId, chunked.adopted, actor, true)

  if (starting) {
    finishReveal(frameId) /* a live stream overrides any one-shot playback in flight */
    setKey(streams, frameId, { actor, escaped, lastActivity: Date.now(), base, tail: '' })
    broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: true, actor })
    logActivity(frame.canvasId, actor, `is designing “${frame.name}” live…`, frameId)
    autoTask(frame.canvasId, actor, `Designing “${frame.name}”`, frameId)
  }
  const s = edit(streams.get(frameId)!)
  s.lastActivity = Date.now()
  s.escaped = escaped
  s.tail = (s.tail + piece).slice(-STREAM_TAIL_CHARS)

  /* the chunk renders the moment it arrives — viewers see the agent's real progress */
  broadcast(frame.canvasId, {
    type: 'frame:updated',
    /* hotlinks too: a stream's top may not have settled yet, and a pending rename skips the faces */
    frame: opts.done ? frame : { ...frame, html: withHostedIcons(healPartialHtml(frame.html)) },
    actor,
  })
  if (opts.done) {
    finishStream(frameId, true)
    if (prepared.changed.length) propagateFromFrameWrite(frame.canvasId, prepared.changed, actor, frameId)
  }

  touch(frame.canvasId, actor, frameId)
  return frame
})

/* ------------------------------------------------------------------ */

export const setCanvasPages = atomic(function setCanvasPages(
  canvasId: string,
  pages: import('../shared/types.ts').CanvasPageInfo[],
  actor: Actor,
) {
  const saved = store.setPages(canvasId, pages)
  const next = saved?.pages ?? pages
  broadcast(canvasId, { type: 'canvas:pages', pages: next, actor })
  for (const guide of saved?.dropped ?? []) broadcast(canvasId, { type: 'guide', id: guide.id, guide: null, actor })
  return next
})

/** Add one page at the end of the canvas, named `name`, with a fresh id; peers
 *  get the page list. Returns the new page and the whole list. */
export function createCanvasPage(canvasId: string, name: string, actor: Actor) {
  const canvas = store.canvases.get(canvasId)
  if (!canvas) return undefined
  const pages = canvasPages(canvas)
  if (pages.length >= MAX_PAGES) throw new PageLimitError()
  const page = { id: nanoid(10), name }
  return { page, pages: setCanvasPages(canvasId, [...pages, page], actor) }
}

/** Point a page's prototype flow at a frame (or clear it); peers get the page list. */
export function setFlowStart(canvasId: string, pageId: string, frameId: string | null, actor: Actor) {
  const pages = store.setFlowStart(canvasId, pageId, frameId)
  if (pages) broadcast(canvasId, { type: 'canvas:pages', pages, actor })
  return pages
}

/** Paint a page's canvas a colour of its own (or clear it); peers get the page list. */
export function setPageBackground(canvasId: string, pageId: string, background: string | null, actor: Actor) {
  const pages = store.setPageBackground(canvasId, pageId, background)
  if (pages) broadcast(canvasId, { type: 'canvas:pages', pages, actor })
  return pages
}

/** Add or move a ruler guide; peers see it at once. Guides are view
 *  furniture, not design content, so the canvas stays as recently edited
 *  as it was and no activity is logged. */
export function setGuide(canvasId: string, guide: CanvasGuide, actor: Actor) {
  const saved = store.setGuide(canvasId, guide)
  if (saved) broadcast(canvasId, { type: 'guide', id: saved.id, guide: saved, actor })
  return saved
}

export function deleteGuide(canvasId: string, guideId: string, actor: Actor) {
  if (store.deleteGuide(canvasId, guideId)) broadcast(canvasId, { type: 'guide', id: guideId, guide: null, actor })
}

/** Copy a page with its frames; peers get the page list and each new frame. */
export async function duplicatePage(canvasId: string, pageId: string, actor: Actor) {
  const copy = await store.duplicatePage(canvasId, pageId, actor.name)
  if (!copy) return undefined
  broadcast(canvasId, { type: 'canvas:pages', pages: copy.pages, actor })
  for (const guide of copy.guides) broadcast(canvasId, { type: 'guide', id: guide.id, guide, actor })
  for (const frame of copy.frames) {
    broadcast(canvasId, { type: 'frame:created', frame, actor })
    emitEvent(canvasId, { type: 'frame.created', frame, actor })
  }
  logActivity(canvasId, actor, `duplicated page “${copy.source.name}” as “${copy.page.name}”`)
  touch(canvasId, actor)
  return copy
}

export const createFrame = atomic(function createFrame(
  canvasId: string,
  input: {
    name: string
    pageId?: string
    x?: number
    y?: number
    width?: number
    height?: number
    html?: string
    demo?: boolean
    hidden?: boolean
    locked?: boolean
    z?: number
    rotation?: number
  },
  actor: Actor,
): Frame | undefined {
  if (input.html !== undefined) {
    /* no id yet: a main marker arriving in a new frame is a copy of that main */
    const prepared = prepareWrite(canvasId, '', repairEscapedHtml(input.html), '', actor.name, {
      refuseUnclosed: actor.kind === 'agent',
    })
    input = { ...input, html: prepared.html }
  }
  const frame = store.createFrame(canvasId, input, actor.name)
  if (!frame) return undefined
  const createIssues = takeComponentIssues('')
  if (createIssues.length) setKey(componentIssues, frame.id, createIssues)
  setKey(bursts, frame.id, { actor, lastAt: frame.createdAt })
  if (actor.kind === 'agent' && frame.html.length > 0) {
    /* agent one-shot creation still plays back as a reveal */
    broadcast(canvasId, { type: 'frame:created', frame: { ...frame, html: '' }, actor })
    startReveal(frame, actor, 0)
    autoTask(canvasId, actor, `Designing “${frame.name}”`, frame.id)
  } else {
    broadcast(canvasId, { type: 'frame:created', frame, actor })
  }
  logActivity(canvasId, actor, `created frame “${frame.name}”`, frame.id)
  touch(canvasId, actor, frame.id)
  emitEvent(canvasId, { type: 'frame.created', frame, actor })
  return frame
})

/** Whether this design write is refused, rather than saved with a note, when it leaves a
 *  `<doop-use>` open: an agent's whole write. A frame mid-stream holds its stream's waiting tags:
 *  the streaming agent's own edit of it is not whole (its next chunks close them), another
 *  agent's is refused outright unless it replaces the design (set_frame_html). */
function refusesUnclosed(frameId: string, actor: Actor, replace: boolean): boolean {
  if (actor.kind !== 'agent') return false
  const stream = streams.get(frameId)
  if (!stream || replace) return true
  if (stream.actor.name === actor.name) return false
  throw new WriteRefusedError(
    `Refused, nothing was written: ${stream.actor.name} is streaming this frame. Wait for its stream to finish, or replace the whole design with set_frame_html.`,
  )
}

/** `replace` marks a deliberate whole-document write (set_frame_html): it
 *  always opens a history burst, even when the new document keeps most of
 *  the old one's wrapper — only the reveal-or-morph choice stays similarity
 *  based. Without it a write is judged by how much it changed. */
export const updateFrame = atomic(function updateFrame(
  frameId: string,
  patch: Partial<
    Pick<Frame, 'name' | 'pageId' | 'x' | 'y' | 'width' | 'height' | 'html' | 'hidden' | 'locked' | 'z' | 'rotation'>
  >,
  actor: Actor,
  opts: { replace?: boolean } = {},
): Frame | undefined {
  const before = store.getFrame(frameId)
  if (!before) return undefined
  const prevHtml = before.html
  let changedComponents: ComponentDef[] = []
  if (patch.html !== undefined) {
    const prepared = prepareWrite(before.canvasId, frameId, repairEscapedHtml(patch.html), prevHtml, actor.name, {
      refuseUnclosed: refusesUnclosed(frameId, actor, opts.replace === true),
    })
    patch = { ...patch, html: prepared.html }
    changedComponents = prepared.changed
  }
  const prevName = before.name
  const prevHidden = !!before.hidden
  const prevLocked = !!before.locked
  const prior = { ...priorState(before), html: prevHtml }
  const frame = store.updateFrame(frameId, patch, actor.name)
  if (!frame) return undefined

  const htmlChanged = patch.html !== undefined && patch.html !== prevHtml
  const { prefix, shared } = htmlChanged ? sharedSpan(prevHtml, frame.html) : { prefix: 0, shared: 0 }
  /* mostly-unchanged replace (small tweak): the client morphs the live DOM
     in place, so a reveal would only add churn — and the design history
     files one version per burst of tweaks, not one per keystroke */
  const smallTweak = htmlChanged && shared >= frame.html.length * 0.5 && shared >= prevHtml.length * 0.5
  if (htmlChanged) noteHtmlChange(prior, actor, smallTweak && !opts.replace ? 'tweak' : 'replace')
  if (htmlChanged && actor.kind === 'agent') {
    finishStream(frameId, false) /* a full replace ends an open append stream */
    const openReveal = reveals.get(frameId)
    if (openReveal) {
      /* new content mid-playback: rewind to the divergence and re-arm the deadline */
      edit(openReveal).actor = actor
      openReveal.shown = Math.min(openReveal.shown, prefix)
      openReveal.deadline = Date.now() + revealDuration(frame.html.length - openReveal.shown)
      trackTaskFrame(frame.canvasId, actor, frameId)
    } else if (smallTweak) {
      broadcast(frame.canvasId, { type: 'frame:updated', frame, actor })
      logActivity(frame.canvasId, actor, `tweaked the design of “${frame.name}”`, frame.id)
      autoTask(frame.canvasId, actor, `Tweaking “${frame.name}”`, frameId)
    } else {
      startReveal(frame, actor, prefix)
      logActivity(frame.canvasId, actor, `updated the design of “${frame.name}”`, frame.id)
      autoTask(frame.canvasId, actor, `Redesigning “${frame.name}”`, frameId)
    }
  } else {
    if (htmlChanged) {
      /* a human takes over: cancel any live stream or playback */
      finishStream(frameId, false)
      finishReveal(frameId)
    }
    broadcast(frame.canvasId, { type: 'frame:updated', frame: htmlChanged ? frame : frameForViewers(frame), actor })
    if (htmlChanged) {
      logActivity(frame.canvasId, actor, `updated the design of “${frame.name}”`, frame.id)
    } else if (patch.name !== undefined && patch.name !== prevName) {
      logActivity(frame.canvasId, actor, `renamed “${prevName}” to “${frame.name}”`, frame.id)
    } else if (patch.hidden !== undefined && !!patch.hidden !== prevHidden) {
      logActivity(frame.canvasId, actor, `${frame.hidden ? 'hid' : 'showed'} frame “${frame.name}”`, frame.id)
    }
  }
  /* a lock change is its own line, whatever else the same update carried */
  if (patch.locked !== undefined && !!patch.locked !== prevLocked) {
    logActivity(frame.canvasId, actor, `${frame.locked ? 'locked' : 'unlocked'} “${frame.name}”`, frame.id)
  }

  if (changedComponents.length) propagateFromFrameWrite(frame.canvasId, changedComponents, actor, frameId)
  touch(frame.canvasId, actor, frame.id)
  return frame
})

/** Several frames' places in the stack at once (the Layers panel renumbering
 *  a page, or undoing that): every frame is checked before any is written,
 *  so the order changes whole or not at all. Undefined when a frame is
 *  gone or on another canvas. Not a design edit: no activity line. */
export const restackFrames = atomic(function restackFrames(
  canvasId: string,
  writes: StackWrite[],
  actor: Actor,
): Frame[] | undefined {
  if (writes.some((w) => store.getFrame(w.id)?.canvasId !== canvasId)) return undefined
  const frames = writes.map((w) => store.updateFrame(w.id, { z: w.z }, actor.name)!)
  for (const frame of frames) broadcast(canvasId, { type: 'frame:updated', frame: frameForViewers(frame), actor })
  touch(canvasId, actor, frames[0]?.id)
  return frames
})

/** Sign-off is a human action, separate from ordinary frame editing. An agent may set it
 *  for the person it works for: the approval stays theirs (`approvedBy`), with the agent
 *  recorded as `approvedVia` and as the actor of the broadcast and activity line. */
export const setFrameApproval = atomic(function setFrameApproval(
  frameId: string,
  ready: boolean,
  user: { id: string; name: string },
  agent?: Actor,
): Frame | undefined {
  const current = store.getFrame(frameId)
  if (!current) return undefined
  if (ready && current.approval?.status === 'ready_for_dev') return current
  const actor = agent ?? resolveActor({ name: user.name, kind: 'user' })
  const approval = ready
    ? {
        status: 'ready_for_dev' as const,
        approvedBy: user.name,
        approvedByUserId: user.id,
        approvedAt: Math.max(Date.now(), current.updatedAt + 1),
        approvedFrameUpdatedAt: current.updatedAt,
        ...(agent ? { approvedVia: agent.name } : {}),
      }
    : null
  const frame = store.updateFrame(frameId, { approval }, actor.name)!
  broadcast(frame.canvasId, { type: 'frame:updated', frame: frameForViewers(frame), actor })
  logActivity(
    frame.canvasId,
    actor,
    ready
      ? `marked “${frame.name}” ready for dev${agent ? ` for ${user.name}` : ''}`
      : `moved “${frame.name}” back to draft`,
    frameId,
  )
  return frame
})

/** An agent's approval request, shared by the MCP tool and the resident agent. */
export function agentSetFrameApproval(
  frameId: string,
  status: 'ready_for_dev' | 'draft',
  user: { id: string; name: string },
  agent: Actor,
): { ok: true; frame: Frame } | { ok: false; error: string } {
  const current = store.getFrame(frameId)
  if (!current) return { ok: false, error: `no frame with id ${frameId}` }
  if (status === 'ready_for_dev' && isFrameStreaming(frameId))
    return { ok: false, error: 'the design is still streaming — wait for it to finish before approving it' }
  const frame = setFrameApproval(frameId, status === 'ready_for_dev', user, agent)
  return frame ? { ok: true, frame } : { ok: false, error: `no frame with id ${frameId}` }
}

/** An agent is appending to this frame right now. A one-shot reveal does not count: it is
 *  only playback of what is already stored, so background work may rewrite the frame. */
export function isFrameMidStream(frameId: string): boolean {
  return streams.has(frameId)
}

export function isFrameStreaming(frameId: string): boolean {
  return streams.has(frameId) || reveals.has(frameId)
}

/** Whether any frame on the canvas has a stream or playback open, which
 *  keeps the canvas's frame HTML in memory (store.evictIdle). */
export function isCanvasStreaming(canvasId: string): boolean {
  for (const frameId of [...streams.keys(), ...reveals.keys()]) {
    if (store.getFrame(frameId)?.canvasId === canvasId) return true
  }
  return false
}

export const deleteFrame = atomic(function deleteFrame(frameId: string, actor: Actor): Frame | undefined {
  /* close any live stream or playback while the frame still exists,
     so their auto “Designing…” tasks end with it */
  finishStream(frameId, false)
  finishReveal(frameId)
  const frame = store.deleteFrame(frameId)
  if (!frame) return undefined
  dropKey(unsavedStamps, frameId)
  dropKey(bursts, frameId)
  afterCommit(() => thumbs.purge(frameId))
  broadcast(frame.canvasId, { type: 'frame:deleted', frameId, actor })
  releaseMains(frame.canvasId, frameId, actor)
  logActivity(frame.canvasId, actor, `deleted frame “${frame.name}”`, frame.id)
  touch(frame.canvasId, actor, null)
  return frame
})

/** Remove a canvas with everything attached to it; viewers are told to leave. */
export const deleteCanvas = atomic(function deleteCanvas(canvasId: string): boolean {
  const c = store.deleteCanvas(canvasId)
  forgetLibrary(canvasId)
  if (!c) return false
  for (const f of c.frames) {
    afterCommit(() => thumbs.purge(f.id))
    dropKey(bursts, f.id)
  }
  broadcast(canvasId, { type: 'canvas:deleted' })
  dropKey(taskLog, canvasId)
  dropKey(feedbackLog, canvasId)
  dropKey(commentLog, canvasId)
  dropKey(activityLog, canvasId)
  dropKey(decisionLog, canvasId)
  dropKey(proposalLog, canvasId)
  return true
})

export function renameCanvas(canvasId: string, name: string, actor: Actor) {
  /* the same name changes nothing, so nobody is told it did */
  const current = store.getCanvas(canvasId)
  if (current?.name === name) return current
  const canvas = store.renameCanvas(canvasId, name)
  if (!canvas) return undefined
  broadcast(canvasId, { type: 'canvas:renamed', name, actor })
  logActivity(canvasId, actor, `renamed the canvas to “${name}”`)
  return canvas
}

/* ------------------------------------------------------------------ */
/* Design guidelines: named markdown docs on a canvas (brand rules,    */
/* style recipes). Written mostly for agents; humans read/edit them    */
/* in the Guidelines panel.                                            */
/* ------------------------------------------------------------------ */

export const MAX_GUIDELINE_CHARS = 24_000
export const MAX_GUIDELINE_DOCS = 20
export const GUIDELINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MAX_GUIDELINE_TITLE_CHARS = 80

/** Display name of a design guide: the pretty title, else the prettified slug. */
export function guidelineTitle(doc: Pick<GuidelineDoc, 'name' | 'title'>): string {
  return doc.title ?? doc.name.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

/** First heading or non-empty line — the one-liner shown before an agent
 *  decides whether to fetch the full doc. */
export function guidelineSummary(doc: GuidelineDoc): string {
  for (const raw of doc.markdown.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line) return line.length > 120 ? line.slice(0, 117) + '…' : line
  }
  return ''
}

/** Upsert (or, with empty markdown, delete) a design doc. Returns the doc,
 *  null for a deletion, undefined when the canvas is missing; throws on
 *  invalid input with a message meant for the caller's error channel. */
export const setGuideline = atomic(function setGuideline(
  canvasId: string,
  name: string,
  markdown: string,
  actor: Actor,
  pos?: { x: number; y: number },
  title?: string,
): GuidelineDoc | null | undefined {
  const slug = name.trim().toLowerCase()
  if (!GUIDELINE_NAME_RE.test(slug))
    throw new Error(`invalid doc name “${name}” — use a lowercase slug like "feature-image" (a-z, 0-9, hyphens)`)
  const clean = markdown.replace(/\r\n/g, '\n').trim()
  if (clean.length > MAX_GUIDELINE_CHARS)
    throw new Error(`doc is ${clean.length} chars — the limit is ${MAX_GUIDELINE_CHARS}`)
  const cleanTitle =
    title === undefined ? undefined : title.replace(/\s+/g, ' ').trim().slice(0, MAX_GUIDELINE_TITLE_CHARS)

  if (!clean) {
    const existing = store.getGuidelines(canvasId).find((d) => d.name === slug)
    if (!store.deleteGuideline(canvasId, slug)) return store.getCanvas(canvasId) ? null : undefined
    stored.saveGuidelineVersion(canvasId, slug, '', actor.name, Date.now())
    broadcast(canvasId, { type: 'guidelines', name: slug, doc: null, actor })
    logActivity(canvasId, actor, `deleted the design guide “${existing ? guidelineTitle(existing) : slug}”`)
    touch(canvasId, actor)
    return null
  }

  const existing = store.getGuidelines(canvasId)
  if (!existing.some((d) => d.name === slug) && existing.length >= MAX_GUIDELINE_DOCS)
    throw new Error(`this canvas already has ${MAX_GUIDELINE_DOCS} design guides — delete one first`)
  const doc = store.setGuideline(canvasId, slug, clean, actor.name, pos, cleanTitle)
  if (!doc) return undefined
  stored.saveGuidelineVersion(canvasId, slug, clean, actor.name, doc.updatedAt)
  broadcast(canvasId, { type: 'guidelines', name: slug, doc, actor })
  logActivity(canvasId, actor, `updated the design guide “${guidelineTitle(doc)}”`)
  touch(canvasId, actor)
  return doc
})

/** Patch design-guide metadata (card position, display title) without touching
 *  the content: no version snapshot, position changes make no activity noise. */
export function patchGuideline(
  canvasId: string,
  name: string,
  patch: { x?: number; y?: number; title?: string },
  actor: Actor,
): boolean {
  const clean: { x?: number; y?: number; title?: string } = {}
  if (patch.x !== undefined || patch.y !== undefined) {
    if (!Number.isFinite(patch.x) || !Number.isFinite(patch.y)) return false
    clean.x = patch.x
    clean.y = patch.y
  }
  if (patch.title !== undefined)
    clean.title = patch.title.replace(/\s+/g, ' ').trim().slice(0, MAX_GUIDELINE_TITLE_CHARS)
  if (Object.keys(clean).length === 0) return false
  const doc = store.patchGuideline(canvasId, name.trim().toLowerCase(), clean)
  if (!doc) return false
  broadcast(canvasId, { type: 'guidelines', name: doc.name, doc, actor })
  if (clean.title !== undefined) logActivity(canvasId, actor, `renamed a design guide to “${guidelineTitle(doc)}”`)
  return true
}

/* Per-process memory of which agents have read a canvas's design docs —
   worst case after a restart is one extra nudge, same trade-off as the
   task log's announce tracking. */
const guidelinesSeen = new Set<string>()

export function markGuidelinesSeen(canvasId: string, agentKey: string) {
  guidelinesSeen.add(`${canvasId}:${agentKey}`)
}

export function hasSeenGuidelines(canvasId: string, agentKey: string): boolean {
  return guidelinesSeen.has(`${canvasId}:${agentKey}`)
}

/* ------------------------------------------------------------------ */
/* Design tokens: a canvas's named design values (shared/designTokens) */
/* — CSS custom properties frames use as var(--name). A change rewrites */
/* the managed block in every frame that names the token.              */
/* ------------------------------------------------------------------ */

function tokenError(name: string, message: string): TokenResult {
  return { name, result: 'error', message }
}

/** Why a value cannot be written, or null when it can: the literal is one
 *  clean declaration, an alias names a token that exists (in the canvas or
 *  earlier in the same batch) and does not loop back. */
function valueProblem(
  tokens: readonly DesignToken[],
  name: string,
  value: string,
  themes: Record<string, string> = {},
): string | null {
  for (const candidate of [value, ...Object.values(themes)]) {
    const target = aliasOf(candidate)
    if (!target) continue
    if (target === name) return 'a token cannot alias itself'
    if (!tokens.some((t) => t.name === target)) return `aliases ${target}, which does not exist — create it first`
  }
  const probe: DesignToken[] = [
    ...tokens.filter((t) => t.name !== name),
    { name, type: 'color', value, themes, order: 0, updatedAt: 0, updatedBy: '' },
  ]
  /* a chain is followed per theme, each token under its value there */
  const every = new Set<string | undefined>([undefined])
  for (const token of probe) for (const theme of Object.keys(token.themes ?? {})) every.add(theme)
  for (const theme of every) {
    if (resolveToken(probe, name, theme) === null)
      return theme ? `aliasing would loop in ${theme}` : 'aliasing would loop'
  }
  return null
}

/** The theme values of an input, normalized: null when one is unusable or
 *  the theme name is not one, undefined when none were given. A null entry
 *  (an edit) removes that theme's value. */
function cleanThemes(
  value: unknown,
): { themes: Record<string, string>; removed: string[] } | undefined | { error: string } {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: 'themes must be an object' }
  const themes: Record<string, string> = {}
  const removed: string[] = []
  for (const [theme, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isThemeName(theme)) return { error: `invalid theme name “${theme}” — use a lowercase slug like "dark"` }
    if (raw === null) {
      removed.push(theme)
      continue
    }
    const text = normalizeTokenValue(raw)
    if (text === null) return { error: `invalid value for theme ${theme} — one CSS value, no semicolons or braces` }
    themes[theme] = text
  }
  return { themes, removed }
}

/** Declare any theme a token names that the canvas does not have yet. */
function declareThemes(canvasId: string, themes: Record<string, string>, by: string): string | null {
  const known = store.getTokenThemes(canvasId)
  const fresh = Object.keys(themes).filter((theme) => !known.includes(theme))
  if (!fresh.length) return null
  if (known.length + fresh.length > MAX_TOKEN_THEMES) return `a canvas has at most ${MAX_TOKEN_THEMES} token themes`
  store.setTokenThemes(canvasId, [...known, ...fresh], by)
  return null
}

function cleanDescription(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > MAX_TOKEN_DESCRIPTION ? null : text
}

/** Names of the tokens a frame uses, directly: what a token edit must restyle. */
export function tokenUsage(canvasId: string): Map<string, number> {
  const counts = new Map<string, number>()
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return counts
  const tokens = canvas.tokens ?? []
  for (const token of tokens) counts.set(token.name, 0)
  const { components } = resourcesOf(canvas)
  for (const frame of canvas.frames) {
    /* as the frame renders: what its components' rules name counts, and so does a token
       another one it names is an alias of */
    const rendered = syncComponentHead(frame.html, componentsUsedBy(frame.html, components))
    for (const token of tokensUsedBy(rendered, tokens)) counts.set(token.name, (counts.get(token.name) ?? 0) + 1)
  }
  return counts
}

/** Rewrite every frame whose managed token block no longer matches the
 *  canvas's tokens (and, on a rename, the references to the old name). An
 *  annotation write: nothing a reviewer signed off on moved, so sign-off
 *  stands and no version is filed. Returns how many frames changed. */
/** Renames a frame with an open append stream still has to take, with the instance marks
 *  they moved: applied when the stream closes, done chunk or idle. */
const pendingRenames = new Map<string, { rename: TokenRename; marks: readonly MarkAdvance[] }[]>()

/** A rename followed into the canvas's own component definitions (server/tokenRenames.ts):
 *  each revision saved and told to the room, as any revision is. The instance marks it moved. */
function renameInCanvasComponents(canvasId: string, rename: TokenRename, actor: Actor): MarkAdvance[] {
  return renameInComponents(
    store.getComponents(canvasId),
    rename,
    (def) => bumpRevision(def, actor.name),
    (def) => {
      store.saveComponent(canvasId, def)
      const saved = store.getComponents(canvasId).find((candidate) => candidate.id === def.id) ?? def
      broadcastComponent(canvasId, saved, actor)
      return saved
    },
  )
}

function restyleTokenFrames(
  canvasId: string,
  actor: Actor,
  rename?: TokenRename,
  marks: readonly MarkAdvance[] = [],
): number {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return 0
  let changed = 0
  for (const frame of [...canvas.frames]) {
    /* an open append stream gets its block, and any rename, with its done chunk */
    if (streams.has(frame.id)) {
      if (rename) setKey(pendingRenames, frame.id, [...(pendingRenames.get(frame.id) ?? []), { rename, marks }])
      continue
    }
    let html = frame.html
    if (rename) html = advanceInstanceMarks(applyRename(html, rename), marks)
    html = storedHtml(canvasId, withCanvasStyles(canvasId, html))
    /* lean storage: a value is not in the frame, so only a rename, a theme attribute or
       a font face that comes or goes with the change is a reason to write it */
    if (sameStored(canvasId, html, frame.html)) continue
    const prevHtml = frame.html
    const updated = store.updateFrame(frame.id, { html }, actor.name, { annotation: true })
    if (!updated) continue
    afterCommit(() => thumbs.purge(frame.id))
    const openReveal = reveals.get(frame.id)
    if (openReveal) {
      /* mid-playback: rewind to where the documents diverge, as a rewrite does */
      edit(openReveal).shown = Math.min(openReveal.shown, sharedSpan(prevHtml, updated.html).prefix)
      openReveal.deadline = Date.now() + revealDuration(updated.html.length - openReveal.shown)
    } else broadcast(canvasId, { type: 'frame:updated', frame: updated, actor })
    changed++
  }
  return changed
}

function tokenSummary(results: TokenResult[], verb: string): string {
  const names = results.filter((r) => r.result !== 'error').map((r) => r.name)
  if (!names.length) return ''
  return names.length <= 3
    ? `${verb} the design token${names.length > 1 ? 's' : ''} ${names.join(', ')}`
    : `${verb} ${names.length} design tokens`
}

/** Add tokens; one result per entry, errors in-band so a batch with one bad
 *  entry still lands the rest. Returns undefined when the canvas is missing. */
export const createTokens = atomic(function createTokens(
  canvasId: string,
  inputs: unknown[],
  actor: Actor,
): TokenResult[] | undefined {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) return undefined
  const results: TokenResult[] = []
  const accepted: {
    name: string
    type: TokenType
    value: string
    themes?: Record<string, string>
    description?: string
  }[] = []
  const pending: DesignToken[] = [...(canvas.tokens ?? [])]
  for (const raw of inputs) {
    const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const name = normalizeTokenName(input.name)
    if (!isTokenName(name)) {
      results.push(tokenError(name || '?', `invalid name “${name}” — letters, digits, hyphens and underscores only`))
      continue
    }
    if (!isTokenType(input.type)) {
      results.push(tokenError(name, `unknown token type “${String(input.type)}”`))
      continue
    }
    const value = normalizeTokenValue(input.value)
    if (value === null) {
      results.push(tokenError(name, 'invalid value — one CSS value, no semicolons or braces'))
      continue
    }
    const description = cleanDescription(input.description)
    if (description === null) {
      results.push(tokenError(name, `description must be text under ${MAX_TOKEN_DESCRIPTION} characters`))
      continue
    }
    if (pending.some((t) => t.name === name)) {
      results.push(tokenError(name, 'a token with this name already exists — change it with set_tokens'))
      continue
    }
    if (pending.length >= MAX_TOKENS) {
      results.push(tokenError(name, `this canvas already has ${MAX_TOKENS} tokens`))
      continue
    }
    const cleaned = cleanThemes(input.themes)
    if (cleaned && 'error' in cleaned) {
      results.push(tokenError(name, cleaned.error))
      continue
    }
    const themes = cleaned?.themes ?? {}
    const problem = valueProblem(pending, name, value, themes)
    if (problem) {
      results.push(tokenError(name, problem))
      continue
    }
    const declared = declareThemes(canvasId, themes, actor.name)
    if (declared) {
      results.push(tokenError(name, declared))
      continue
    }
    const token: DesignToken = { name, type: input.type, value, order: pending.length + 1, updatedAt: 0, updatedBy: '' }
    pending.push(token)
    accepted.push({
      name,
      type: input.type,
      value,
      ...(Object.keys(themes).length ? { themes } : {}),
      ...(description ? { description } : {}),
    })
    results.push({ name, result: 'created' })
  }
  if (accepted.length) {
    store.setTokens(canvasId, accepted, actor.name)
    /* frames that already name the token (a recreate, an agent that wrote
       var() first) start resolving it now */
    const restyled = restyleTokenFrames(canvasId, actor)
    broadcast(canvasId, {
      type: 'tokens',
      tokens: store.getTokens(canvasId),
      themes: store.getTokenThemes(canvasId),
      actor,
    })
    const summary = tokenSummary(results, 'added')
    logActivity(
      canvasId,
      actor,
      restyled ? `${summary} (${restyled} frame${restyled === 1 ? '' : 's'} restyled)` : summary,
    )
    touch(canvasId, actor)
  }
  return results
})

/** Change, rename or delete tokens by name, in order; one result per entry.
 *  Every frame naming a changed token is restyled before this returns. */
export const setTokens = atomic(function setTokens(
  canvasId: string,
  edits: TokenEdit[],
  actor: Actor,
): TokenResult[] | undefined {
  if (!store.getCanvas(canvasId)) return undefined
  const results: TokenResult[] = []
  const renames: TokenRename[] = []
  let touched = 0
  for (const edit of edits) {
    const tokens = store.getTokens(canvasId)
    const name = normalizeTokenName(edit.name)
    const token = tokens.find((t) => t.name === name)
    if (!token) {
      results.push(tokenError(name || '?', `no token named “${name}”`))
      continue
    }
    if (edit.delete) {
      const dependant = tokens.find(
        (t) => aliasOf(t.value) === name || Object.values(t.themes ?? {}).some((v) => aliasOf(v) === name),
      )
      if (dependant) {
        results.push(tokenError(name, `${dependant.name} aliases it — change that token first`))
        continue
      }
      store.deleteToken(canvasId, name)
      results.push({ name, result: 'deleted' })
      touched++
      continue
    }
    const type = edit.type === undefined ? token.type : edit.type
    if (!isTokenType(type)) {
      results.push(tokenError(name, `unknown token type “${String(edit.type)}”`))
      continue
    }
    const value = edit.value === undefined ? token.value : normalizeTokenValue(edit.value)
    if (value === null) {
      results.push(tokenError(name, 'invalid value — one CSS value, no semicolons or braces'))
      continue
    }
    const description = cleanDescription(edit.description)
    if (description === null) {
      results.push(tokenError(name, `description must be text under ${MAX_TOKEN_DESCRIPTION} characters`))
      continue
    }
    const cleaned = cleanThemes(edit.themes)
    if (cleaned && 'error' in cleaned) {
      results.push(tokenError(name, cleaned.error))
      continue
    }
    const themes = { ...(token.themes ?? {}), ...(cleaned?.themes ?? {}) }
    for (const theme of cleaned?.removed ?? []) delete themes[theme]
    const problem = valueProblem(tokens, name, value, themes)
    if (problem) {
      results.push(tokenError(name, problem))
      continue
    }
    /* every check before any write: a refused edit changes nothing */
    let newName = name
    if (edit.newName !== undefined && normalizeTokenName(edit.newName) !== name) {
      newName = normalizeTokenName(edit.newName)
      if (!isTokenName(newName)) {
        results.push(tokenError(name, `invalid name “${newName}” — letters, digits, hyphens and underscores only`))
        continue
      }
      if (tokens.some((t) => t.name === newName)) {
        results.push(tokenError(name, `a token named ${newName} already exists`))
        continue
      }
    }
    const declared = declareThemes(canvasId, themes, actor.name)
    if (declared) {
      results.push(tokenError(name, declared))
      continue
    }
    if (newName !== name) {
      store.renameToken(canvasId, name, newName, actor.name)
      /* every var() reference to the old name in another token's values
         follows it, whole-value aliases and references inside expressions alike */
      const referencing = store
        .getTokens(canvasId)
        .filter((t) => [t.value, ...Object.values(t.themes ?? {})].some((v) => usesToken(v, name)))
        .map((t) => ({
          name: t.name,
          type: t.type,
          value: renameTokenRefs(t.value, name, newName),
          themes: Object.fromEntries(
            Object.entries(t.themes ?? {}).map(([theme, v]) => [theme, renameTokenRefs(v, name, newName)]),
          ),
          description: t.description,
        }))
      if (referencing.length) store.setTokens(canvasId, referencing, actor.name)
      renames.push({ kind: 'token', from: name, to: newName })
    }
    store.setTokens(
      canvasId,
      [
        {
          name: newName,
          type,
          value,
          themes,
          description: description === undefined ? token.description : description,
          ...(typeof edit.order === 'number' && Number.isFinite(edit.order) ? { order: edit.order } : {}),
        },
      ],
      actor.name,
    )
    results.push({ name: newName, result: 'updated' })
    touched++
  }
  if (touched) {
    let restyled = 0
    for (const rename of renames)
      restyled += restyleTokenFrames(canvasId, actor, rename, renameInCanvasComponents(canvasId, rename, actor))
    restyled += restyleTokenFrames(canvasId, actor)
    broadcast(canvasId, {
      type: 'tokens',
      tokens: store.getTokens(canvasId),
      themes: store.getTokenThemes(canvasId),
      actor,
    })
    const summary = tokenSummary(results, 'changed')
    logActivity(
      canvasId,
      actor,
      restyled ? `${summary} (${restyled} frame${restyled === 1 ? '' : 's'} restyled)` : summary,
    )
    touch(canvasId, actor)
  }
  return results
})

/** Replace the canvas's token themes (order included): a theme that leaves
 *  takes its values with it, and every frame is restyled. Throws on bad
 *  input with a message for the caller's error channel. */
/** A theme list (or its renames) that `setTokenThemes` refuses as asked: the caller's answer
 *  is "invalid themes" with this message. Anything else it throws is not a refusal of the list. */
export class TokenThemesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenThemesError'
  }
}

export const setTokenThemes = atomic(function setTokenThemes(
  canvasId: string,
  themes: unknown,
  actor: Actor,
  renames: unknown = [],
): string[] | undefined {
  if (!store.getCanvas(canvasId)) return undefined
  if (!Array.isArray(themes)) throw new TokenThemesError('themes must be an array of names')
  if (!Array.isArray(renames)) throw new TokenThemesError('renames must be an array of { from, to }')
  /* every check runs against a simulated list before anything is written,
     so a bad request changes nothing */
  const before = store.getTokenThemes(canvasId)
  let simulated = [...before]
  const moves: { from: string; to: string }[] = []
  for (const raw of renames) {
    const entry = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const from = typeof entry.from === 'string' ? entry.from.trim().toLowerCase() : ''
    const to = typeof entry.to === 'string' ? entry.to.trim().toLowerCase() : ''
    if (!isThemeName(to))
      throw new TokenThemesError(`invalid theme name “${String(entry.to)}” — use a lowercase slug like "dark"`)
    if (from === to) continue
    if (!simulated.includes(from)) throw new TokenThemesError(`no theme named “${from}”`)
    if (simulated.includes(to)) throw new TokenThemesError(`a theme named “${to}” already exists`)
    simulated = simulated.map((theme) => (theme === from ? to : theme))
    moves.push({ from, to })
  }
  const names: string[] = []
  for (const raw of themes) {
    const theme = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!isThemeName(theme))
      throw new TokenThemesError(`invalid theme name “${String(raw)}” — use a lowercase slug like "dark"`)
    if (!names.includes(theme)) names.push(theme)
  }
  if (names.length > MAX_TOKEN_THEMES)
    throw new TokenThemesError(`a canvas has at most ${MAX_TOKEN_THEMES} token themes`)
  const same = simulated.length === names.length && simulated.every((theme, i) => theme === names[i])
  if (same && !moves.length) return names

  let restyled = 0
  for (const move of moves) {
    store.renameTokenTheme(canvasId, move.from, move.to, actor.name)
    const rename: TokenRename = { kind: 'theme', ...move }
    restyled += restyleTokenFrames(canvasId, actor, rename, renameInCanvasComponents(canvasId, rename, actor))
  }
  if (!same) store.setTokenThemes(canvasId, names, actor.name)
  restyled += restyleTokenFrames(canvasId, actor)
  broadcast(canvasId, { type: 'tokens', tokens: store.getTokens(canvasId), themes: names, actor })
  logActivity(
    canvasId,
    actor,
    `set the token themes to ${names.length ? names.join(', ') : 'none'}${restyled ? ` (${restyled} frame${restyled === 1 ? '' : 's'} restyled)` : ''}`,
  )
  touch(canvasId, actor)
  return names
})

/* ------------------------------------------------------------------ */
/* Design memory: pinned reference frames (exemplars), captured        */
/* decisions (addressed feedback), and distiller proposals (rule edits */
/* a human accepts into a guide or dismisses). The guides above are    */
/* the distilled layer; this is everything upstream of them.           */
/* ------------------------------------------------------------------ */

export const MAX_REFERENCES = 12

const decisionLog = new Map<string, DesignDecision[]>() // canvasId -> newest first
const proposalLog = new Map<string, MemoryProposal[]>() // canvasId -> newest first

export function getDecisions(canvasId: string): DesignDecision[] {
  return decisionLog.get(canvasId) ?? []
}

export function getProposals(canvasId: string): MemoryProposal[] {
  return proposalLog.get(canvasId) ?? []
}

/** Record a settled design decision and poke the distiller. Deterministic and
 *  silent in the activity feed — the client toasts "Saved to Memory" instead. */
function captureDecision(
  canvasId: string,
  input: { text: string; source: DesignDecision['source']; frameId?: string; from: string; agentName?: string },
): DesignDecision {
  const decision: DesignDecision = {
    id: nanoid(8),
    text: input.text,
    source: input.source,
    ...(input.frameId ? { frameId: input.frameId } : {}),
    from: input.from,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    at: Date.now(),
  }
  prepend(decisionLog, canvasId, decision)
  stored.saveDecision(canvasId, decision)
  broadcast(canvasId, { type: 'decision', decision })
  /* generalize the raw words into a preference, then maybe propose a rule
     (both no-ops without an API key). Dynamic import: distill depends on
     this module. */
  afterCommit(() =>
    detached(() => {
      import('./distill.ts').then((d) => d.onDecision(canvasId, decision.id)).catch(() => {})
    }),
  )
  return decision
}

/** The summarizer generalized a decision — attach it and re-broadcast
 *  (clients upsert by id, so open panels and toasts update in place). */
export function setDecisionSummary(canvasId: string, id: string, summary: string) {
  const decision = getDecisions(canvasId).find((d) => d.id === id)
  if (!decision) return
  edit(decision).summary = summary
  stored.saveDecision(canvasId, decision)
  broadcast(canvasId, { type: 'decision', decision })
}

/** A connected agent reports a design decision its human made in conversation
 *  (the save_decision MCP tool) — the only party that hears that channel is
 *  the agent, so it is the reporter. Throws on bad input; returns undefined
 *  when the canvas is missing, null when it was a duplicate re-report. */
export function recordChatDecision(canvasId: string, text: string, actor: Actor): DesignDecision | null | undefined {
  if (!store.getCanvas(canvasId)) return undefined
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('decision text is empty')
  if (clean.length > MAX_DECISION_CHARS)
    throw new Error(
      `decision is ${clean.length} chars — save one decision and its rationale per call, at most ${MAX_DECISION_CHARS} characters; split longer feedback into separate calls by topic`,
    )
  /* agents re-tell things; the same words land in Memory once */
  if (getDecisions(canvasId).some((d) => d.text === clean)) return null
  return captureDecision(canvasId, {
    text: clean,
    source: 'chat',
    from: actor.owner ?? actor.name,
    agentName: actor.name,
  })
}

/** Pin a frame to Memory as a style reference. Throws with a caller-facing
 *  message on limits; returns undefined when canvas/frame are missing. */
export function pinReference(canvasId: string, frameId: string, actor: Actor): MemoryReference | undefined {
  const frame = store.getFrame(frameId)
  if (!frame || frame.canvasId !== canvasId) return undefined
  const existing = store.getReferences(canvasId)
  if (existing.some((r) => r.frameId === frameId && r.html === frame.html)) {
    throw new Error('this frame is already pinned to Memory in its current state')
  }
  if (existing.length >= MAX_REFERENCES)
    throw new Error(`Memory already holds ${MAX_REFERENCES} references — unpin one first`)
  const ref = store.addReference(canvasId, frame, actor.name)
  if (!ref) return undefined
  broadcast(canvasId, { type: 'reference', id: ref.id, reference: ref, actor })
  logActivity(canvasId, actor, `pinned “${frame.name}” to Memory as a style reference`, frameId)
  return ref
}

export function unpinReference(canvasId: string, id: string, actor: Actor): boolean {
  const ref = store.deleteReference(canvasId, id)
  if (!ref) return false
  broadcast(canvasId, { type: 'reference', id, reference: null, actor })
  logActivity(canvasId, actor, `unpinned the reference “${ref.title}” from Memory`)
  return true
}

/** Decisions the distiller has not consumed yet. */
export function undistilledDecisions(canvasId: string): DesignDecision[] {
  return getDecisions(canvasId).filter((d) => !d.distilledAt)
}

/** Mark decisions consumed by a distiller run — even a run that produced no
 *  proposal, so the same set is never re-analyzed forever. */
export function markDecisionsDistilled(canvasId: string, ids: string[]) {
  const now = Date.now()
  for (const d of getDecisions(canvasId)) {
    if (ids.includes(d.id)) {
      edit(d).distilledAt = now
      stored.saveDecision(canvasId, d)
    }
  }
}

/** The distiller proposed a rule: store it pending and show it to the room. */
export function addProposal(
  canvasId: string,
  input: { guideName: string; guideTitle?: string; rule: string; rationale: string; basedOn: string[] },
): MemoryProposal {
  const proposal: MemoryProposal = {
    id: nanoid(8),
    guideName: input.guideName,
    ...(input.guideTitle ? { guideTitle: input.guideTitle } : {}),
    rule: input.rule,
    rationale: input.rationale,
    basedOn: input.basedOn,
    at: Date.now(),
    status: 'pending',
  }
  prepend(proposalLog, canvasId, proposal)
  stored.saveProposal(canvasId, proposal)
  broadcast(canvasId, { type: 'proposal', proposal })
  return proposal
}

/** A human accepted (rule lands in the guide, versioned like any edit) or
 *  dismissed a proposal. */
export const resolveProposal = atomic(function resolveProposal(
  canvasId: string,
  proposalId: string,
  accept: boolean,
  actor: Actor,
): MemoryProposal | undefined {
  const proposal = getProposals(canvasId).find((p) => p.id === proposalId)
  if (!proposal || proposal.status !== 'pending') return proposal
  if (accept) {
    const guide = store.getGuidelines(canvasId).find((d) => d.name === proposal.guideName)
    const markdown = guide
      ? `${guide.markdown}\n\n${proposal.rule}`
      : `# ${proposal.guideTitle ?? guidelineTitle({ name: proposal.guideName })}\n\n${proposal.rule}`
    setGuideline(canvasId, proposal.guideName, markdown, actor, undefined, guide ? undefined : proposal.guideTitle)
  }
  edit(proposal).status = accept ? 'accepted' : 'dismissed'
  proposal.resolvedBy = actor.name
  proposal.resolvedAt = Date.now()
  stored.saveProposal(canvasId, proposal)
  broadcast(canvasId, { type: 'proposal', proposal })
  if (accept) logActivity(canvasId, actor, `accepted a Memory rule into “${proposal.guideName}”`)
  return proposal
})
