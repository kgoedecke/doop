import { PREVIEW_MAX_HEIGHT, type Frame } from '../shared/types.ts'
import { withRenderSlot } from './renderLimit.ts'
import * as storage from './storage.ts'

/**
 * Persisted dashboard previews: `thumb/<frameId>.jpg` in byte storage,
 * stale-while-revalidate on top.
 *
 * The stored object survives redeploys — which wipe the in-process image
 * cache — so a dashboard never shows blank tiles waiting on Chromium: a
 * possibly-stale thumbnail is served instantly and refreshed in the
 * background. The key is deliberately unversioned; freshness lives in the
 * in-memory `written` map (frameId → the frame.updatedAt the stored thumb
 * was rendered from). After a restart freshness is simply unknown, which
 * degrades to one background re-render per previewed frame — never to a
 * blank tile.
 */

/** frame.updatedAt the stored thumb was rendered from; absent = unknown */
const written = new Map<string, number>()
/** in-flight render+persist per frame — concurrent callers share it */
const pending = new Map<string, Promise<Buffer>>()
/** background revalidation throttle: an agent saving every few seconds
 *  must not turn each dashboard poll into a Chromium render */
const lastAttempt = new Map<string, number>()
const MIN_REVALIDATE_MS = 30_000
/** frames purged mid-render — a pending create must not re-persist them */
const dead = new Set<string>()

const keyFor = (frameId: string) => `thumb/${frameId}.jpg`

/* lazy like every other screenshot.ts consumer (dev never pays for
   puppeteer-core until the first render), but single-flight */
let screenshot: Promise<typeof import('./screenshot.ts')> | undefined
const loadScreenshot = () => (screenshot ??= import('./screenshot.ts'))

/** The preview render: card-sized, clipped, cheap — matches what /i/?preview
 *  serves, because this IS what /i/?preview serves. */
function render(frame: Frame): Promise<Buffer> {
  return withRenderSlot(async () => {
    const { renderFrame } = await loadScreenshot()
    return renderFrame(frame, Math.min(1, 640 / frame.width), {
      type: 'jpeg',
      quality: 70,
      maxHeight: PREVIEW_MAX_HEIGHT,
    })
  })
}

/** Render now, persist, and return the bytes. Deduped per frame; rejects on
 *  render failure (the caller decides what a failed render means). */
export function create(frame: Frame): Promise<Buffer> {
  const inflight = pending.get(frame.id)
  if (inflight) return inflight
  lastAttempt.set(frame.id, Date.now())
  const p = render(frame).then(async (buf) => {
    /* persist is best-effort: a bucket hiccup must not fail the response
       that only needed the bytes */
    try {
      if (!dead.has(frame.id)) {
        await storage.putObject(keyFor(frame.id), buf, 'image/jpeg')
        written.set(frame.id, frame.updatedAt)
        /* purge may have run during the put — its delete can land before
           our write finishes, so re-check and clean up our own orphan */
        if (dead.has(frame.id)) await storage.deleteObject(keyFor(frame.id))
      }
    } catch (e) {
      console.error(`thumb persist failed for ${frame.id}:`, e)
    }
    return buf
  })
  pending.set(frame.id, p)
  p.catch(() => {}).finally(() => pending.delete(frame.id))
  return p
}

/** The stored thumbnail, if there is one. When it is stale — or its
 *  freshness is unknown after a restart — a background re-render is kicked
 *  off (throttled, deduped, errors logged and swallowed) and the stored
 *  bytes are returned anyway: stale beats blank. Returns null when nothing
 *  is stored yet. */
export async function getStored(frame: Frame): Promise<Buffer | null> {
  let buf: Buffer | null
  try {
    buf = await storage.getObject(keyFor(frame.id))
  } catch (e) {
    console.error(`thumb read failed for ${frame.id}:`, e)
    return null
  }
  if (!buf) {
    /* the map claimed fresh but the object is gone (manual purge, new
       bucket) — forget, so the caller falls through to a live render */
    written.delete(frame.id)
    return null
  }
  const fresh = written.get(frame.id) === frame.updatedAt
  const throttled = Date.now() - (lastAttempt.get(frame.id) ?? 0) < MIN_REVALIDATE_MS
  if (!fresh && !throttled && !pending.has(frame.id))
    create(frame).catch((e) => console.error(`thumb revalidate failed for ${frame.id}:`, e))
  return buf
}

/** Frame (or its whole canvas) is gone — drop the derived object too, so the
 *  thumb folder holds only live frames. Best-effort fire-and-forget. */
export function purge(frameId: string): void {
  dead.add(frameId)
  written.delete(frameId)
  lastAttempt.delete(frameId)
  storage.deleteObject(keyFor(frameId)).catch(() => {})
}
