import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db, type Db } from '../db/index.ts'
import { canvases, tasks, slackInstallations, slackSessions } from '../db/schema.ts'
import { store } from '../store.ts'
import * as actions from '../actions.ts'
import { consumeResidentTask, refundResidentTask } from '../allowance.ts'
import { pickModel } from '../agentModel.ts'
import { DEFAULT_ROLE_ID } from '../../shared/agents.ts'
import type { AgentTask, Canvas } from '../../shared/types.ts'
import { publicOrigin, type Installation } from './oauth.ts'
import { postedMessage, postToResponseUrl, slackApi, SlackError } from './client.ts'
import { buildPrompt, plainText, titleFor } from './prompt.ts'

type Session = typeof slackSessions.$inferSelect
const terminal = ['complete', 'failed', 'canceled']
const active = ['pending', 'preparing', 'running']
const MAX_CONCURRENT = 3
const RUN_TIMEOUT_MS = 60 * 60_000
const workInFlight = new Set<string>()
const SLACK_COLOR = '#4A154B'
const NO_BRIEF = 'Mention @Doop with a design brief, for example “@Doop design a pricing page for a note-taking app”.'

/** A mention or slash command, after the webhook verified its signature. */
export interface Inbound {
  /** Slack's event_id, or the slash command's trigger_id — the dedupe key */
  id: string
  teamId: string
  channelId: string
  /** the thread to answer in; a slash command has none until Doop posts */
  threadTs?: string
  requesterId: string
  text: string
  responseUrl?: string
}

/** Persist the request as a durable inbox row. Redeliveries hit the primary key and are no-ops. */
export async function receiveRequest(inbound: Inbound): Promise<void> {
  // Sharing the installation lock with disconnect means no row lands after a cancellation sweep.
  await db.transaction(async (tx) => {
    const [installation] = await tx
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, inbound.teamId))
      .for('share')
    if (!installation || inbound.requesterId === installation.botUserId) return
    const brief = plainText(inbound.text, installation.botUserId)
    const priorCanvas = inbound.threadTs
      ? await threadCanvas(tx, inbound.teamId, inbound.channelId, inbound.threadTs)
      : null
    const now = Date.now()
    await tx
      .insert(slackSessions)
      .values({
        id: inbound.id,
        teamId: inbound.teamId,
        userId: installation.userId,
        channelId: inbound.channelId,
        threadTs: inbound.threadTs ?? null,
        requesterId: inbound.requesterId,
        responseUrl: inbound.responseUrl ?? null,
        title: titleFor(brief),
        prompt: buildPrompt(brief, `Slack member ${inbound.requesterId}`),
        canvasId: priorCanvas,
        followUp: !!priorCanvas,
        // An empty brief needs no "on it" message, only the hint.
        status: brief ? 'pending' : 'failed',
        error: brief ? null : NO_BRIEF,
        acknowledged: !brief,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
  })
}

/** The canvas an earlier request in this thread was designed on, if any. */
async function threadCanvas(
  tx: Pick<Db, 'select'>,
  teamId: string,
  channelId: string,
  threadTs: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ canvasId: slackSessions.canvasId })
    .from(slackSessions)
    .where(
      and(
        eq(slackSessions.teamId, teamId),
        eq(slackSessions.channelId, channelId),
        eq(slackSessions.threadTs, threadTs),
        isNotNull(slackSessions.canvasId),
      ),
    )
    .orderBy(slackSessions.createdAt)
    .limit(1)
  return row?.canvasId ?? null
}

const canvasUrl = (id: string) => `${publicOrigin()}/c/${id}`
const openLink = (id: string) => `<${canvasUrl(id)}|Open design in Doop>`

/** The last surviving frame this card edited. Never another frame on the
 *  canvas: the channel is not a canvas member, so only the card's own work
 *  may reach it. */
function resultFrameId(session: Session): string | undefined {
  if (!session.canvasId || !session.taskId) return undefined
  const card = actions.getTasks(session.canvasId).find((task) => task.id === session.taskId)
  return [...(card?.frameIds ?? [])].reverse().find((id) => !!store.getFrame(id))
}

type Message = { text: string; blocks?: Record<string, unknown>[] }

/** Post into the session's thread, or through the slash command's response_url
 *  when Doop is not in that channel. Resolves to the message ts when it has one. */
async function post(installation: Installation, session: Session, message: Message): Promise<string | undefined> {
  const viaResponseUrl = async () => {
    if (!session.responseUrl) throw new SlackError('Invite @Doop to this channel so it can reply.', 409)
    await postToResponseUrl(session.responseUrl, { response_type: 'in_channel', ...message })
    return undefined
  }
  if (!session.threadTs && !session.ackTs && session.responseUrl && session.acknowledged) return viaResponseUrl()
  try {
    const posted = await slackApi(
      installation.botToken,
      'chat.postMessage',
      {
        channel: session.channelId,
        ...(session.threadTs ? { thread_ts: session.threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
        ...message,
      },
      postedMessage,
    )
    return posted.ts
  } catch (error) {
    if (error instanceof SlackError && error.code === 'invalid_blocks' && message.blocks) {
      return post(installation, session, { text: message.text })
    }
    if (
      error instanceof SlackError &&
      (error.code === 'not_in_channel' || error.code === 'channel_not_found') &&
      session.responseUrl
    ) {
      return viaResponseUrl()
    }
    throw error
  }
}

/** Updating the acknowledgment in place is idempotent, so retries never pile
 *  up messages. A deleted acknowledgment gets a fresh reply instead. */
async function updateAck(installation: Installation, session: Session, text: string): Promise<void> {
  if (session.ackTs) {
    try {
      await slackApi(
        installation.botToken,
        'chat.update',
        { channel: session.channelId, ts: session.ackTs, text },
        z.object({ ts: z.string() }),
      )
      return
    } catch (error) {
      if (!(error instanceof SlackError) || error.code !== 'message_not_found') throw error
    }
  }
  await post(installation, session, { text })
}

function resultMessage(session: Session): Message {
  const link = session.canvasId ? openLink(session.canvasId) : ''
  if (session.status !== 'complete') return { text: `${session.error || 'The design was stopped.'} ${link}`.trim() }
  const frameId = resultFrameId(session)
  const text = `Doop finished the design. ${link}`
  const blocks: Record<string, unknown>[] = [{ type: 'section', text: { type: 'mrkdwn', text } }]
  if (frameId) {
    blocks.push({ type: 'image', image_url: `${publicOrigin()}/i/${frameId}.png`, alt_text: 'The finished design' })
  }
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'The canvas belongs to the Doop installer; they can invite collaborators or enable link sharing. Mention @Doop in this thread to ask for changes.',
      },
    ],
  })
  return { text, blocks }
}

async function dispatch(session: Session) {
  const claimed = await db.transaction(async (tx) => {
    const [installation] = await tx
      .select()
      .from(slackInstallations)
      .where(and(eq(slackInstallations.teamId, session.teamId), eq(slackInstallations.userId, session.userId)))
      .for('update')
    if (!installation) return undefined
    const running = await tx
      .select({ id: slackSessions.id })
      .from(slackSessions)
      .where(and(eq(slackSessions.userId, session.userId), inArray(slackSessions.status, ['preparing', 'running'])))
    if (running.length >= MAX_CONCURRENT) return undefined
    const [row] = await tx
      .update(slackSessions)
      .set({ status: 'preparing', updatedAt: Date.now() })
      .where(and(eq(slackSessions.id, session.id), eq(slackSessions.status, 'pending')))
      .returning()
    return row
  })
  if (!claimed) return
  let gate: Awaited<ReturnType<typeof consumeResidentTask>> | undefined
  let committed = false
  try {
    if (!(await pickModel(session.userId)))
      throw new Error('Connect a model account in Doop Settings, then mention @Doop again.')
    gate = await consumeResidentTask(session.userId)
    if (!gate.ok)
      throw new Error(
        'Connect a model account in Doop Settings or restore your task allowance, then mention @Doop again.',
      )
    const now = Date.now()
    const existing = session.followUp && session.canvasId ? store.getCanvas(session.canvasId) : undefined
    if (session.followUp && (!existing || existing.ownerId !== session.userId))
      throw new Error('The design canvas for this thread is gone. Start a new request with @Doop.')
    const canvas: Canvas = existing ?? {
      id: nanoid(10),
      name: session.title,
      ownerId: session.userId,
      createdAt: now,
      updatedAt: now,
      frames: [],
    }
    const card: AgentTask = {
      id: nanoid(8),
      agentName: '',
      color: SLACK_COLOR,
      status: session.prompt,
      startedAt: now,
      queuedBy: 'Slack',
      queuedByUserId: session.userId,
      pipeline: [DEFAULT_ROLE_ID],
      stage: 0,
    }
    // The canvas, task and session mapping become durable together, before waking the agent.
    committed = await db.transaction(async (tx) => {
      const [installation] = await tx
        .select()
        .from(slackInstallations)
        .where(and(eq(slackInstallations.teamId, session.teamId), eq(slackInstallations.userId, session.userId)))
        .for('update')
      if (!installation) return false
      const updated = await tx
        .update(slackSessions)
        .set({ status: 'running', canvasId: canvas.id, taskId: card.id, updatedAt: now })
        .where(and(eq(slackSessions.id, session.id), eq(slackSessions.status, 'preparing')))
        .returning()
      if (!updated.length) return false
      if (!existing) {
        await tx.insert(canvases).values({
          id: canvas.id,
          name: canvas.name,
          ownerId: session.userId,
          createdAt: now,
          updatedAt: now,
        })
      }
      await tx.insert(tasks).values({
        id: card.id,
        agentName: card.agentName,
        color: card.color,
        status: card.status,
        startedAt: card.startedAt,
        queuedBy: card.queuedBy,
        queuedByUserId: card.queuedByUserId,
        stage: card.stage,
        canvasId: canvas.id,
        pipeline: DEFAULT_ROLE_ID,
      })
      return true
    })
    if (!committed) return
    if (!existing) store.init([canvas])
    actions.publishQueuedCard(canvas.id, card)
    const [latest] = await db.select().from(slackSessions).where(eq(slackSessions.id, session.id))
    if (latest?.status !== 'running') {
      actions.failCard(canvas.id, card.id, 'The Slack design request was stopped.')
      return
    }
    const { onFeedback } = await import('../resident.ts')
    onFeedback(canvas.id)
  } catch (error) {
    await db
      .update(slackSessions)
      .set({
        status: 'failed',
        error:
          error instanceof SlackError
            ? error.message
            : error instanceof Error && /^(Connect|The design canvas)/.test(error.message)
              ? error.message
              : 'Doop could not start the design. Check your model account in Doop Settings and mention @Doop again.',
        updatedAt: Date.now(),
      })
      .where(and(eq(slackSessions.id, session.id), eq(slackSessions.status, 'preparing')))
  } finally {
    if (gate?.ok && !committed) await refundResidentTask(gate, session.userId)
  }
}

async function processSession(session: Session) {
  if (workInFlight.has(session.id)) return
  workInFlight.add(session.id)
  try {
    const [installation] = await db
      .select()
      .from(slackInstallations)
      .where(and(eq(slackInstallations.teamId, session.teamId), eq(slackInstallations.userId, session.userId)))
    if (!installation) {
      // Orphaned by a disconnect: nothing can answer it, so stop selecting it.
      await db
        .update(slackSessions)
        .set({ status: 'canceled', error: 'The Slack agent was disconnected.', reported: true, updatedAt: Date.now() })
        .where(and(eq(slackSessions.id, session.id), inArray(slackSessions.status, active)))
      return
    }
    if (!session.acknowledged && !terminal.includes(session.status)) {
      const ackTs = await post(installation, session, {
        text: session.followUp
          ? 'Doop is on it — working on your changes on the same canvas.'
          : 'Doop is on it — designing from your brief. The canvas link follows in a moment.',
      })
      await db
        .update(slackSessions)
        .set({ acknowledged: true, ackTs: ackTs ?? null, threadTs: session.threadTs ?? ackTs ?? null })
        .where(eq(slackSessions.id, session.id))
    }
    const [latest] = await db.select().from(slackSessions).where(eq(slackSessions.id, session.id))
    if (!latest) return
    session = latest
    if (session.status === 'pending') {
      await dispatch(session)
      return
    }
    if (session.status === 'running' && session.canvasId && session.taskId) {
      const card = actions.getTasks(session.canvasId).find((task) => task.id === session.taskId)
      const finished =
        !!card?.failedAt ||
        !!card?.endedAt ||
        !store.getCanvas(session.canvasId) ||
        Date.now() - session.createdAt > RUN_TIMEOUT_MS
      // The result carries the link itself, so a finished card never waits on the link update.
      if (!session.linked && !finished) {
        await updateAck(installation, session, `Doop is on it — ${openLink(session.canvasId)}`)
        await db.update(slackSessions).set({ linked: true }).where(eq(slackSessions.id, session.id))
      }
      if (finished) {
        const success = !!card?.endedAt && !card.failedAt
        session = {
          ...session,
          status: success ? 'complete' : 'failed',
          error: success ? null : 'The design did not finish. Open the canvas to inspect the work and retry in Doop.',
        }
        if (!success && card && !card.failedAt && !card.endedAt) {
          actions.failCard(session.canvasId!, card.id, 'Slack design request timed out.')
        }
        const updated = await db
          .update(slackSessions)
          .set({ status: session.status, error: session.error, updatedAt: Date.now() })
          .where(and(eq(slackSessions.id, session.id), eq(slackSessions.status, 'running')))
          .returning()
        if (!updated.length) return
      } else {
        return
      }
    }
    if (terminal.includes(session.status) && !session.reported) {
      await post(installation, session, resultMessage(session))
      await db.update(slackSessions).set({ reported: true }).where(eq(slackSessions.id, session.id))
    }
  } finally {
    workInFlight.delete(session.id)
  }
}

/** Keep cancellation durable with the cards, including across an immediate restart. */
async function cancelStoredSessions(tx: Pick<Db, 'update'>, teamId: string, reason: string) {
  const rows = await tx
    .update(slackSessions)
    .set({ status: 'canceled', error: reason, nextAttemptAt: 0, updatedAt: Date.now() })
    .where(and(eq(slackSessions.teamId, teamId), inArray(slackSessions.status, active)))
    .returning()
  const ids = rows.flatMap((row) => (row.taskId ? [row.taskId] : []))
  if (ids.length)
    await tx
      .update(tasks)
      .set({ failedAt: Date.now(), failureReason: reason })
      .where(and(inArray(tasks.id, ids), isNull(tasks.endedAt)))
  return rows
}

function stopPublishedCards(rows: Session[], reason: string) {
  for (const session of rows) {
    if (session.canvasId && session.taskId) actions.failCard(session.canvasId, session.taskId, reason)
  }
}

/** Remove the installation for a Doop user, cancelling its queued work. */
export async function disconnectAgent(userId: string) {
  const reason = 'The Slack agent was disconnected.'
  // Taking the same installation lock as dispatch prevents post-disconnect queueing.
  const rows = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(slackInstallations).where(eq(slackInstallations.userId, userId)).for('update')
    if (!row) return []
    const stopped = await cancelStoredSessions(tx, row.teamId, reason)
    await tx.update(slackSessions).set({ reported: true }).where(eq(slackSessions.teamId, row.teamId))
    await tx.delete(slackInstallations).where(eq(slackInstallations.teamId, row.teamId))
    return stopped
  })
  stopPublishedCards(rows, reason)
}

/** Slack told us the app was uninstalled or its tokens revoked. */
export async function disconnectTeam(teamId: string) {
  const [row] = await db.select().from(slackInstallations).where(eq(slackInstallations.teamId, teamId))
  if (row) await disconnectAgent(row.userId)
}

/** Durable inbox/outbox: retries notifications, never automatically re-runs a failed design. */
export async function tickSlack() {
  await db
    .update(slackSessions)
    .set({
      status: 'failed',
      error: 'Doop restarted before the design was queued. Mention @Doop again.',
      updatedAt: Date.now(),
    })
    .where(and(eq(slackSessions.status, 'preparing'), lt(slackSessions.updatedAt, Date.now() - 120_000)))
  const rows = await selectDue()
  for (const row of rows) {
    await processSession(row).catch(async () => {
      // Back off on provider failures without ever replaying the design job.
      await db
        .update(slackSessions)
        .set({ nextAttemptAt: Date.now() + 60_000 })
        .where(eq(slackSessions.id, row.id))
      console.warn('[slack] session update deferred', row.id)
    })
  }
}

/** Work in flight or awaiting delivery, plus at most MAX_CONCURRENT pending
 *  requests per installer: one workspace's backlog cannot crowd out another's. */
async function selectDue(): Promise<Session[]> {
  const now = Date.now()
  const ranked = db.$with('ranked').as(
    db
      .select({
        id: slackSessions.id,
        rank: sql<number>`row_number() over (partition by ${slackSessions.userId} order by ${slackSessions.createdAt})`.as(
          'rank',
        ),
      })
      .from(slackSessions)
      .where(and(eq(slackSessions.status, 'pending'), lte(slackSessions.nextAttemptAt, now))),
  )
  const pending = db.with(ranked).select({ id: ranked.id }).from(ranked).where(lte(ranked.rank, MAX_CONCURRENT))
  return db
    .select()
    .from(slackSessions)
    .where(
      and(
        lte(slackSessions.nextAttemptAt, now),
        or(
          inArray(slackSessions.status, ['preparing', 'running']),
          and(inArray(slackSessions.status, terminal), eq(slackSessions.reported, false)),
          inArray(slackSessions.id, pending),
        ),
      ),
    )
    .orderBy(slackSessions.createdAt)
    .limit(100)
}

let timer: NodeJS.Timeout | undefined
export function wakeSlack() {
  void tickSlack().catch(() => console.warn('[slack] worker tick failed'))
}
export function startSlackWorker() {
  if (timer) return
  wakeSlack()
  timer = setInterval(wakeSlack, 5000)
  timer.unref()
}
