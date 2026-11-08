import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { Router } from 'express'
import { z } from 'zod'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import { env } from './env.ts'
import type { CanvasEvent } from './events.ts'
import { getAsset, isDescribableImage } from './assets.ts'
import { accountDescriber, serverDescriber, type AgentModel } from './agentModel.ts'
import { getAccounts } from './modelAccounts.ts'
import { getStoredDefault } from './agentDefaults.ts'
import { getImageDescriptionMode, saveImageDescriptionMode } from './imageDescriptionPrefs.ts'
import { store } from './store.ts'
import { isImageDescriptionMode, type DescriberStatus } from '../shared/imageDescriptions.ts'
import type { ServerMessage } from '../shared/types.ts'

/**
 * Image descriptions (.context/specs/image-descriptions.md): every raster
 * image stored for a canvas is described ONCE by a small vision model, and
 * the paragraph lands on its assets row, from where get_canvas, get_frame
 * and the resident kickoff read it. The upload never waits: `asset.stored`
 * queues the id, a worker drains the queue a few at a time, and boot
 * re-queues whatever an earlier process left undescribed.
 *
 * Whose model: uploader first, canvas owner second, server last. Off on
 * either user stops analysis. A server-only uploader bypasses both accounts.
 * The selected payer/provider is saved before work starts and stays fixed
 * across retries, including restarts; runtime errors never change who pays.
 */

export const MAX_DESCRIBE_ATTEMPTS = 3
export const DESCRIBE_TIMEOUT_MS = 20_000
/** the long edge the model sees: a 5 MB retina screenshot buys no better paragraph */
export const DESCRIBE_LONG_EDGE_PX = 1500
const MAX_DESCRIPTION_CHARS = 1200

const PROMPT = `You describe one image for a designer who cannot see it, in under 120 words of plain prose. Say what kind of image it is (an app or website screenshot, a photo, a logo, a chart, a sketch, an illustration); for a screenshot, the product or page it shows, its layout and main regions, every heading and the key copy as written, and the palette; for a photo, the subject, setting and mood; for a logo or chart, what it depicts. No preamble, no bullet points, no guesses about what is outside the image.`

/* ---------------------------------------------------------------- */
/* which model                                                       */
/* ---------------------------------------------------------------- */

export type Describer =
  | { model: AgentModel; payerId: string | null; status: DescriberStatus & { label: string } }
  | { model: null; status: DescriberStatus & { label: null } }

type SelectedPayer = Pick<typeof t.assets.$inferSelect, 'describePayerId' | 'describeProvider'>

/** Resolve upload billing, or reload exactly the payer selected on an earlier attempt. */
export async function describerFor(
  uploaderId: string | undefined,
  ownerId?: string,
  selected?: SelectedPayer,
): Promise<Describer> {
  const uploaderMode = uploaderId ? await getImageDescriptionMode(uploaderId) : 'account'
  const ownerMode = ownerId === uploaderId ? uploaderMode : ownerId ? await getImageDescriptionMode(ownerId) : 'account'
  if (uploaderMode === 'off' || ownerMode === 'off') return { model: null, status: { label: null, reason: 'off' } }

  if (selected?.describeProvider) {
    if (selected.describePayerId) {
      const payerId = selected.describePayerId
      // Consent may be withdrawn while a retry is waiting. Never choose a new payer.
      if (uploaderMode === 'server' || (await getImageDescriptionMode(payerId)) !== 'account')
        return { model: null, status: { label: null, reason: 'off' } }
      const account = (await getAccounts(payerId)).find(
        (account) => account.enabled && account.kind === selected.describeProvider,
      )
      const model = account ? accountDescriber(account) : null
      return model
        ? { model, payerId, status: { label: model.label } }
        : { model: null, status: { label: null, reason: 'no-model' } }
    }
    const provider = selected.describeProvider
    const model = provider === 'anthropic' || provider === 'azure' ? serverDescriber(provider) : null
    return model
      ? { model, payerId: null, status: { label: model.label } }
      : { model: null, status: { label: null, reason: 'no-model' } }
  }

  let textOnly = false
  if (uploaderMode === 'account') {
    for (const payerId of new Set([uploaderId, ...(ownerMode === 'account' ? [ownerId] : [])])) {
      if (!payerId) continue
      // A failed account lookup is a retryable error, not permission to bill someone else.
      const accounts = (await getAccounts(payerId)).filter((account) => account.enabled)
      const preferred = await getStoredDefault(payerId)
      const ordered = [
        ...accounts.filter((account) => account.kind === preferred),
        ...accounts.filter((account) => account.kind !== preferred),
      ]
      for (const account of ordered) {
        const model = accountDescriber(account)
        if (model) return { model, payerId, status: { label: model.label } }
        textOnly = true
      }
    }
  }
  const model = serverDescriber()
  if (model) return { model, payerId: null, status: { label: model.label } }
  return { model: null, status: { label: null, reason: textOnly ? 'text-only' : 'no-model' } }
}

/* ---------------------------------------------------------------- */
/* one description                                                   */
/* ---------------------------------------------------------------- */

/** Shrink the image to what a description needs and hand it to the model. */
export async function describeImage(
  model: AgentModel,
  bytes: Buffer,
  signal: AbortSignal = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
): Promise<string> {
  signal.throwIfAborted()
  const jpeg = await withinSignal(
    () =>
      sharp(bytes, { animated: false })
        .resize({
          width: DESCRIBE_LONG_EDGE_PX,
          height: DESCRIBE_LONG_EDGE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 80 })
        .toBuffer(),
    signal,
  )
  signal.throwIfAborted()
  /* the signal reaches the model request, but not every step before it (a
     ChatGPT token refresh, say) — so the whole turn is raced against it, and
     the worker's slot comes back on time whatever stalled */
  const result = await withinSignal(
    () =>
      model.run({
        system: [{ text: PROMPT }],
        tools: [],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
              { type: 'text', text: 'Describe this image.' },
            ],
          },
        ],
        maxTokens: 400,
        signal,
      }),
    signal,
  )
  const text = result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
  if (!text) throw new Error('the model returned no description')
  return text.slice(0, MAX_DESCRIPTION_CHARS)
}

/** Bound every operation by the job deadline, without starting work after expiry.
 * A query already sent may still settle later; always consume its rejection. */
function withinSignal<T>(work: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return work()
      })
      .then(
        (result) => {
          cleanup()
          resolve(result)
        },
        (error: unknown) => {
          cleanup()
          reject(error)
        },
      )
  })
}

/* ---------------------------------------------------------------- */
/* the queue                                                         */
/* ---------------------------------------------------------------- */

type Broadcast = (canvasId: string, msg: ServerMessage) => void
let broadcast: Broadcast = () => {}

const queue: string[] = []
const queued = new Set<string>()
let inFlight = 0
/** a failed asset waits here for its next attempt */
const retries = new Map<string, ReturnType<typeof setTimeout>>()
const idleWaiters: (() => void)[] = []
/** Keep the retry cap even when the database cannot record a failure. A later
 * successful lookup flushes this count before any more model work. */
const failureCounts = new Map<string, number>()

/** a day's budget per canvas, counted in memory (resets with the process) */
const spent = new Map<string, { day: string; count: number }>()

function withinBudget(canvasId: string): boolean {
  const day = new Date().toISOString().slice(0, 10)
  const entry = spent.get(canvasId)
  const count = entry?.day === day ? entry.count : 0
  if (count >= env.DESCRIBE_PER_CANVAS_PER_DAY) return false
  spent.set(canvasId, { day, count: count + 1 })
  return true
}

export function enqueueDescription(assetId: string): void {
  if (queued.has(assetId)) return
  queued.add(assetId)
  queue.push(assetId)
  drain()
}

function drain(): void {
  while (inFlight < env.DESCRIBE_CONCURRENCY && queue.length > 0) {
    const assetId = queue.shift()!
    inFlight++
    describeAsset(assetId)
      .then((result) => {
        if (result === 'failed') scheduleRetry(assetId)
      })
      .catch((err: unknown) => console.error(`[describe] ${assetId} failed`, err))
      .finally(() => {
        queued.delete(assetId)
        inFlight--
        drain()
      })
  }
  if (queue.length === 0 && inFlight === 0) for (const wake of idleWaiters.splice(0)) wake()
}

/** A failed attempt comes back after DESCRIBE_RETRY_MS, while attempts remain. */
function scheduleRetry(assetId: string): void {
  if (retries.has(assetId)) return
  const timer = setTimeout(() => {
    retries.delete(assetId)
    enqueueDescription(assetId)
  }, env.DESCRIBE_RETRY_MS)
  timer.unref?.()
  retries.set(assetId, timer)
}

/** Resolves when the queue is empty and nothing is in flight (a retry
 *  waiting on its timer is not in flight) — for tests and shutdown. */
export function describeIdle(): Promise<void> {
  if (queue.length === 0 && inFlight === 0) return Promise.resolve()
  return new Promise((resolve) => void idleWaiters.push(resolve))
}

export type DescribeOutcome =
  /** the paragraph is on the row */
  | 'described'
  /** nothing to do: already described, no model, over budget, not an image */
  | 'skipped'
  /** this attempt failed and another remains */
  | 'failed'
  /** this attempt failed and it was the last */
  | 'exhausted'

/** Describe one stored asset: skipped when already described, out of
 *  attempts, over budget, not an image, or its owner has it off. */
export async function describeAsset(
  assetId: string,
  signal: AbortSignal = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
): Promise<DescribeOutcome> {
  let attempts = failureCounts.get(assetId) ?? 0
  try {
    const [row] = await withinSignal(() => db.select().from(t.assets).where(eq(t.assets.id, assetId)), signal)
    if (!row || !row.canvasId || row.description !== null || !isDescribableImage(row.mime)) {
      failureCounts.delete(assetId)
      return 'skipped'
    }
    attempts = Math.max(attempts, row.describeAttempts)
    if (attempts > row.describeAttempts) {
      await withinSignal(
        () =>
          db
            .update(t.assets)
            .set({ describeAttempts: sql`greatest(${t.assets.describeAttempts}, ${attempts})` })
            .where(eq(t.assets.id, assetId)),
        signal,
      )
    }
    failureCounts.delete(assetId)
    if (attempts >= MAX_DESCRIBE_ATTEMPTS) return 'skipped'
    const canvas = store.getCanvas(row.canvasId)
    if (!canvas) return 'skipped'
    // assets.ownerId is the authenticated uploader, not the canvas owner.
    const resolved = await withinSignal(() => describerFor(row.ownerId ?? undefined, canvas.ownerId, row), signal)
    if (!resolved.model) {
      if (resolved.status.reason !== 'off')
        console.log(`[describe] ${assetId} left undescribed: ${resolved.status.reason}`)
      return 'skipped'
    }
    const { model, payerId } = resolved
    if (!withinBudget(row.canvasId)) {
      console.log(`[describe] canvas ${row.canvasId} is over today's budget of ${env.DESCRIBE_PER_CANVAS_PER_DAY}`)
      return 'skipped'
    }
    // Persist before any storage/model work, so even a failed read pins the payer.
    if (!row.describeProvider) {
      await withinSignal(
        () =>
          db
            .update(t.assets)
            .set({ describePayerId: payerId, describeProvider: model.provider })
            .where(eq(t.assets.id, assetId)),
        signal,
      )
    }
    const asset = await withinSignal(() => getAsset(assetId, signal), signal)
    if (!asset) return 'skipped'
    signal.throwIfAborted()
    if (!store.getCanvas(row.canvasId)) return 'skipped'
    const description = await describeImage(model, asset.buf, signal)
    signal.throwIfAborted()
    if (!store.getCanvas(row.canvasId)) return 'skipped'
    await withinSignal(
      () =>
        db
          .update(t.assets)
          .set({ description, describedAt: Date.now(), describedBy: model.label })
          .where(eq(t.assets.id, assetId)),
      signal,
    )
    signal.throwIfAborted()
    broadcast(row.canvasId, { type: 'asset:described', assetId, description })
    return 'described'
  } catch (err) {
    attempts++
    failureCounts.set(assetId, attempts)
    // The deadline covers failure bookkeeping too. If it expired, retain the
    // count in memory instead of starting a write that could hold the slot.
    if (!signal.aborted) {
      try {
        const [saved] = await withinSignal(
          () =>
            db
              .update(t.assets)
              .set({ describeAttempts: sql`greatest(${t.assets.describeAttempts}, ${attempts})` })
              .where(eq(t.assets.id, assetId))
              .returning({ attempts: t.assets.describeAttempts }),
          signal,
        )
        attempts = Math.max(attempts, saved?.attempts ?? 0)
        if (!saved || attempts >= MAX_DESCRIBE_ATTEMPTS) failureCounts.delete(assetId)
        else failureCounts.set(assetId, attempts)
      } catch (writeError) {
        console.error(`[describe] ${assetId} could not save failure count; retaining it until retry`, writeError)
      }
    }
    const last = attempts >= MAX_DESCRIBE_ATTEMPTS
    console.error(
      `[describe] ${assetId} attempt ${attempts} of ${MAX_DESCRIBE_ATTEMPTS} failed${last ? '; giving up' : ''}`,
      err,
    )
    return last ? 'exhausted' : 'failed'
  }
}

/** Queue what an earlier process left undescribed. Rows from before
 *  descriptions existed were marked out of attempts by migration 0049, so
 *  this never bills an owner for their history. */
export async function enqueuePending(): Promise<number> {
  const rows = await db
    .select({ id: t.assets.id })
    .from(t.assets)
    .where(and(isNull(t.assets.description), lt(t.assets.describeAttempts, MAX_DESCRIBE_ATTEMPTS)))
  for (const row of rows) enqueueDescription(row.id)
  return rows.length
}

export function onCanvasEvent(_canvasId: string, event: CanvasEvent): void {
  if (event.type === 'asset.stored') enqueueDescription(event.asset.id)
}

/** Wire the room broadcast and queue the backlog; called once at boot.
 *  Resolves once the backlog is queued (not described). */
export function startImageDescriptions(b: Broadcast): Promise<void> {
  broadcast = b
  return enqueuePending()
    .then((n) => void (n && console.log(`[describe] ${n} image(s) queued from an earlier run`)))
    .catch((err: unknown) => console.error('[describe] could not read the backlog', err))
}

/* ---------------------------------------------------------------- */
/* the setting                                                       */
/* ---------------------------------------------------------------- */

export const imageDescriptionsRouter = Router()

async function preference(userId: string) {
  const mode = await getImageDescriptionMode(userId)
  const { status } = await describerFor(userId)
  return { mode, describer: status }
}

imageDescriptionsRouter.get('/', (req, res, next) => {
  preference(req.user!.id)
    .then((body) => res.json(body))
    .catch(next)
})

const modeSchema = z.object({ mode: z.string().refine(isImageDescriptionMode, 'Unknown mode') })

imageDescriptionsRouter.put('/', (req, res, next) => {
  const parsed = modeSchema.safeParse(req.body)
  if (!parsed.success || !isImageDescriptionMode(parsed.data.mode)) {
    res.status(400).json({ error: 'Invalid image description mode' })
    return
  }
  const mode = parsed.data.mode
  const userId = req.user!.id
  saveImageDescriptionMode(userId, mode)
    .then(() => preference(userId))
    .then((body) => res.json(body))
    .catch(next)
})
