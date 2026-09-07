import type { ExportScale, ExportRect } from '../shared/frameExport.ts'
import type { Frame } from '../shared/types.ts'
import * as thumbs from './thumbs.ts'

/**
 * Everything behind GET /i/<frameId>.<ext> except HTTP: the in-process
 * image cache, the render rate limit, and the dispatch between the three
 * ways an image can be produced (persisted thumbnail, preview render,
 * full-size render). The route stays thin — params, auth callback,
 * headers — and this module stays testable without a server.
 *
 * Freshness model, one layer per lifetime:
 *  - imgCache: per-process, ~minutes. Holds the render *promise*, not the
 *    buffer, so concurrent requests for the same key share one render.
 *    May serve a just-revalidated thumb's previous bytes for up to
 *    IMG_CACHE_MS — accepted, previews only claim minutes-freshness.
 *  - thumbs (previews only): persisted across deploys, stale-while-
 *    revalidate. See thumbs.ts.
 *  - a full-size render is never persisted; it exists for og:image embeds
 *    and downloads, and is only ever cached here.
 */

const imgCache = new Map<string, { buf: Promise<Buffer>; updatedAt: number; at: number }>()
const IMG_CACHE_MS = 5 * 60_000
const IMG_CACHE_MAX = 200

/* Renders boot Chromium pages; cached serves and persisted-thumb serves are
   cheap and never metered. The budget is per IP because its purpose is
   anonymous hotlink abuse — authenticated users bypass it (verified by the
   caller, and only checked when the budget is actually exhausted). */
const renderHits = new Map<string, number[]>()
const RENDERS_PER_MIN = 12

export interface ImageRequest {
  ext: 'png' | 'jpg'
  scale: ExportScale
  crop?: ExportRect
  quality: number
  /** dashboard-card variant: small, clipped, jpeg, persisted. Only
   *  meaningful for jpg — a png?preview would serve jpeg bytes under an
   *  image/png content-type, so the flag is ignored there. */
  preview: boolean
  ip: string
  /** consulted only when the render budget is exhausted */
  isAuthenticated: () => Promise<boolean>
}

export type ImageResult = { status: 'ok'; buf: Buffer } | { status: 'rate-limited' }

/** May reject when the render itself fails — the caller owns the 500. */
export async function getImage(frame: Frame, req: ImageRequest): Promise<ImageResult> {
  const preview = req.preview && req.ext === 'jpg' && !req.crop
  const cropKey = req.crop ? [req.crop.x, req.crop.y, req.crop.width, req.crop.height].join(',') : ''
  const key = `${cropKey}:${frame.id}:${req.ext}:${req.scale}:${req.ext === 'jpg' ? req.quality : ''}:${preview ? 'p' : ''}`
  const cached = imgCache.get(key)
  let pending =
    cached && cached.updatedAt === frame.updatedAt && Date.now() - cached.at < IMG_CACHE_MS ? cached.buf : null

  /* previews first try the persisted thumbnail: survives redeploys, serves
     instantly even when stale (thumbs revalidates in the background), and
     costs no Chromium boot — so it isn't metered either */
  if (!pending && preview) {
    const stored = await thumbs.getStored(frame)
    if (stored) {
      pending = Promise.resolve(stored)
      remember(key, pending, frame.updatedAt)
    }
  }

  if (!pending) {
    if (!(await consumeRenderBudget(req.ip, req.isAuthenticated))) return { status: 'rate-limited' }
    pending = preview
      ? /* renders AND persists — the next cold start serves from storage */
        thumbs.create(frame)
      : loadScreenshot().then(({ renderFrame }) =>
          renderFrame(frame, req.scale, {
            type: req.ext === 'jpg' ? 'jpeg' : 'png',
            quality: req.quality,
            ...(req.crop ? { clip: req.crop } : {}),
          }),
        )
    remember(key, pending, frame.updatedAt)
  }

  return { status: 'ok', buf: await pending }
}

function remember(key: string, pending: Promise<Buffer>, updatedAt: number) {
  imgCache.set(key, { buf: pending, updatedAt, at: Date.now() })
  /* a failed render must not be served for IMG_CACHE_MS — drop it so the
     next request retries */
  pending.catch(() => {
    if (imgCache.get(key)?.buf === pending) imgCache.delete(key)
  })
  if (imgCache.size > IMG_CACHE_MAX) {
    const oldest = [...imgCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) imgCache.delete(oldest[0])
  }
}

async function consumeRenderBudget(ip: string, isAuthenticated: () => Promise<boolean>): Promise<boolean> {
  const now = Date.now()
  const hits = (renderHits.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= RENDERS_PER_MIN) return isAuthenticated()
  hits.push(now)
  renderHits.set(ip, hits)
  return true
}

/* lazy so dev never pays for puppeteer-core until the first render;
   single-flight because concurrent import() of one module can serialize */
let screenshot: Promise<typeof import('./screenshot.ts')> | undefined
const loadScreenshot = () => (screenshot ??= import('./screenshot.ts'))
