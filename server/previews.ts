import { store } from './store.ts'
import type { Frame } from '../shared/types.ts'
import * as thumbs from './thumbs.ts'
import {
  assertRenderRead,
  assertPrivateRenderBytes,
  frameContentKey,
  type PrivateRenderScope,
} from './privateResources.ts'

/** Private derived bytes. Every waiter reauthorizes independently, including cache hits. */
const imgCache = new Map<string, { buf: Promise<Buffer>; at: number; bytes: number }>()
const IMG_CACHE_MS = 5 * 60_000
const IMG_CACHE_MAX = 200
const IMG_CACHE_BYTES = 64 * 1024 * 1024

export interface ImageRequest {
  ext: 'png' | 'jpg'
  /** output density, already parsed and fitted (shared/exportScale.ts) */
  scale: number
  quality: number
  preview: boolean
  scope: PrivateRenderScope
}

export type ImageResult = { status: 'ok'; buf: Buffer }

export async function getImage(input: Frame, req: ImageRequest): Promise<ImageResult> {
  await assertRenderRead(req.scope, input)
  const frame = await store.renderSource(input)
  await assertRenderRead(req.scope, frame)
  if (req.scope.kind !== 'frame') throw new Error('a preview requires a stored frame')
  const preview = req.preview && req.ext === 'jpg'
  const key = imageKey(frame, req.ext, req.scale, req.ext === 'jpg' ? req.quality : '', preview)
  const cached = imgCache.get(key)
  if (cached && Date.now() - cached.at >= IMG_CACHE_MS) imgCache.delete(key)
  let pending = imgCache.get(key)?.buf
  if (!pending) {
    pending = (async () => {
      const stored = preview ? await thumbs.getStored(frame, req.scope) : null
      let buf: Buffer
      if (stored) buf = stored
      else if (preview) buf = await thumbs.create(frame, req.scope)
      else {
        const { renderFrame } = await loadScreenshot()
        buf = await renderFrame(frame, req.scope, req.scale, {
          type: req.ext === 'jpg' ? 'jpeg' : 'png',
          quality: req.quality,
        })
      }
      assertPrivateRenderBytes(buf)
      await assertRenderRead(req.scope, frame)
      return buf
    })()
    remember(key, pending)
  }
  const buf = await pending
  await assertRenderRead(req.scope, frame)
  return { status: 'ok', buf }
}

function imageKey(frame: Frame, ext: 'png' | 'jpg', scale: number, quality: number | '', preview: boolean): string {
  return `${frameContentKey(frame)}:${ext}:${scale}:${quality}:${preview ? 'p' : ''}`
}

/** A private MCP render may prime the same cache; URL readers still need their own session. */
export async function primeImage(input: Frame, scope: PrivateRenderScope, scale: number, png: Buffer): Promise<void> {
  const frame = { ...input }
  assertPrivateRenderBytes(png)
  await assertRenderRead(scope, frame)
  if (scope.kind !== 'frame') throw new Error('a preview requires a stored frame')
  remember(imageKey(frame, 'png', scale, '', false), Promise.resolve(png))
}

function trimCache() {
  let bytes = [...imgCache.values()].reduce((sum, entry) => sum + entry.bytes, 0)
  for (const [key, entry] of imgCache) {
    if (imgCache.size <= IMG_CACHE_MAX && bytes <= IMG_CACHE_BYTES) break
    imgCache.delete(key)
    bytes -= entry.bytes
  }
}

function remember(key: string, pending: Promise<Buffer>) {
  const entry = { buf: pending, at: Date.now(), bytes: 0 }
  imgCache.set(key, entry)
  trimCache()
  pending.then(
    (buf) => {
      if (imgCache.get(key) === entry) {
        entry.bytes = buf.length
        trimCache()
      }
    },
    () => {
      if (imgCache.get(key) === entry) imgCache.delete(key)
    },
  )
}

let screenshot: Promise<typeof import('./screenshot.ts')> | undefined
const loadScreenshot = () => (screenshot ??= import('./screenshot.ts'))
