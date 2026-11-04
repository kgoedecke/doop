import { and, eq, isNull, lt } from 'drizzle-orm'
import sharp from 'sharp'
import { Router } from 'express'
import { z } from 'zod'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import { env } from './env.ts'
import type { CanvasEvent } from './events.ts'
import { getAsset, isDescribableImage } from './assets.ts'
import { accountDescriber, serverDescriber, type AgentModel } from './agentModel.ts'
import { getAccount } from './modelAccounts.ts'
import { getImageDescriptionMode, saveImageDescriptionMode } from './imageDescriptionPrefs.ts'
import { store } from './store.ts'
import { isImageDescriptionMode, type DescriberStatus, type ImageDescriptionMode } from '../shared/imageDescriptions.ts'
import type { ServerMessage } from '../shared/types.ts'

/**
 * Image descriptions (.context/specs/image-descriptions.md): every raster
 * image stored for a canvas is described ONCE by a small vision model, and
 * the paragraph lands on its assets row, from where get_canvas, get_frame
 * and the resident kickoff read it. The upload never waits: `asset.stored`
 * queues the id, a worker drains the queue a few at a time, and boot
 * re-queues whatever an earlier process left undescribed.
 *
 * Whose model: the canvas owner's preference (off / their connected account
 * / this server's tier). The owner pays, as for automations and resident
 * runs on their canvas. A text-only account, a harness-only pick (local
 * Claude, the Gemini pilot) or a missing account falls through to the server
 * tier; with no key anywhere the image stays undescribed and nothing retries.
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
  | { model: AgentModel; status: DescriberStatus & { label: string } }
  | { model: null; status: DescriberStatus & { label: null } }

/** The model that would describe the next image on this user's canvases. */
export async function describerFor(ownerId: string | undefined): Promise<Describer> {
  const mode: ImageDescriptionMode = ownerId ? await getImageDescriptionMode(ownerId) : 'account'
  return describerForMode(ownerId, mode)
}

async function describerForMode(ownerId: string | undefined, mode: ImageDescriptionMode): Promise<Describer> {
  if (mode === 'off') return { model: null, status: { label: null, reason: 'off' } }
  let textOnly = false
  if (mode === 'account' && ownerId) {
    const account = await getAccount(ownerId).catch((err: unknown) => {
      console.error('[describe] could not read the connected model account', err)
      return null
    })
    if (account) {
      const own = accountDescriber(account)
      if (own) return { model: own, status: { label: own.label } }
      textOnly = true
    }
  }
  const server = serverDescriber()
  if (server) return { model: server, status: { label: server.label } }
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
  const jpeg = await sharp(bytes, { animated: false })
    .resize({ width: DESCRIBE_LONG_EDGE_PX, height: DESCRIBE_LONG_EDGE_PX, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 80 })
    .toBuffer()
  const result = await model.run({
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
  })
  const text = result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
  if (!text) throw new Error('the model returned no description')
  return text.slice(0, MAX_DESCRIPTION_CHARS)
}

/* ---------------------------------------------------------------- */
/* the queue                                                         */
/* ---------------------------------------------------------------- */

type Broadcast = (canvasId: string, msg: ServerMessage) => void
let broadcast: Broadcast = () => {}

const queue: string[] = []
const queued = new Set<string>()
let inFlight = 0

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
      .catch((err: unknown) => console.error(`[describe] ${assetId} failed`, err))
      .finally(() => {
        queued.delete(assetId)
        inFlight--
        drain()
      })
  }
}

/** Resolves when the queue is empty and nothing is in flight — for tests and shutdown. */
export function describeIdle(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (queue.length === 0 && inFlight === 0 ? resolve() : setTimeout(check, 10))
    check()
  })
}

/** Describe one stored asset: skipped when already described, out of
 *  attempts, over budget, not an image, or its owner has it off. */
export async function describeAsset(assetId: string): Promise<'described' | 'skipped' | 'failed'> {
  const [row] = await db.select().from(t.assets).where(eq(t.assets.id, assetId))
  if (!row || !row.canvasId || row.description !== null || row.describeAttempts >= MAX_DESCRIBE_ATTEMPTS)
    return 'skipped'
  if (!isDescribableImage(row.mime)) return 'skipped'
  const canvas = store.getCanvas(row.canvasId)
  const { model, status } = await describerFor(canvas?.ownerId ?? row.ownerId ?? undefined)
  if (!model) {
    if (status.reason !== 'off') console.log(`[describe] ${assetId} left undescribed: ${status.reason}`)
    return 'skipped'
  }
  if (!withinBudget(row.canvasId)) {
    console.log(`[describe] canvas ${row.canvasId} is over today's budget of ${env.DESCRIBE_PER_CANVAS_PER_DAY}`)
    return 'skipped'
  }
  const asset = await getAsset(assetId)
  if (!asset) return 'skipped'
  try {
    const description = await describeImage(model, asset.buf)
    await db
      .update(t.assets)
      .set({ description, describedAt: Date.now(), describedBy: model.label })
      .where(eq(t.assets.id, assetId))
    broadcast(row.canvasId, { type: 'asset:described', assetId, description })
    return 'described'
  } catch (err) {
    await db
      .update(t.assets)
      .set({ describeAttempts: row.describeAttempts + 1 })
      .where(eq(t.assets.id, assetId))
    console.error(`[describe] ${assetId} attempt ${row.describeAttempts + 1} failed`, err)
    return 'failed'
  }
}

/** Queue what an earlier process left undescribed. */
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
  const { status } = await describerForMode(userId, mode)
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
