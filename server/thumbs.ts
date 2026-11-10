import { createHash } from 'node:crypto'
import type { Frame } from '../shared/types.ts'
import * as storage from './storage.ts'
import {
  assertRenderRead,
  assertPrivateRenderBytes,
  frameContentKey,
  type PrivateRenderScope,
} from './privateResources.ts'
import { renderAdmission } from './renderAdmission.ts'

export const PREVIEW_MAX_HEIGHT = 1200
const keyFor = (frameId: string) => `thumb/${frameId}.jpg`
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const written = new Map<string, { content: string; bytes: string }>()
const pending = new Map<string, { frameId: string; promise: Promise<Buffer> }>()
const dead = new Set<string>()
/** Covers held rendered buffers and slow persistence, in addition to Chromium's own queue. */
const acquirePipeline = renderAdmission(3)
let screenshot: Promise<typeof import('./screenshot.ts')> | undefined
const loadScreenshot = () => (screenshot ??= import('./screenshot.ts'))

export async function create(input: Frame, scope: PrivateRenderScope): Promise<Buffer> {
  const frame = { ...input }
  await assertRenderRead(scope, frame)
  if (scope.kind !== 'frame' || dead.has(frame.id)) throw new Error('thumbnail is unavailable')
  const content = frameContentKey(frame)
  const identity = `${content}:jpeg:640:70:${PREVIEW_MAX_HEIGHT}`
  let task = pending.get(identity)?.promise
  if (!task) {
    task = (async () => {
      const release = await acquirePipeline()
      try {
        await assertRenderRead(scope, frame)
        const { renderFrame } = await loadScreenshot()
        const buf = await renderFrame(frame, scope, Math.min(1, 640 / frame.width), {
          type: 'jpeg',
          quality: 70,
          maxHeight: PREVIEW_MAX_HEIGHT,
        })
        assertPrivateRenderBytes(buf)
        await assertRenderRead(scope, frame)
        if (dead.has(frame.id)) throw new Error('thumbnail is unavailable')
        const provenance = { content, bytes: digest(buf) }
        let persisted = false
        try {
          await storage.putObject(keyFor(frame.id), buf, 'image/jpeg')
          persisted = true
        } catch {
          console.error('[thumb] persistence unavailable')
        }
        try {
          await assertRenderRead(scope, frame)
          if (dead.has(frame.id)) throw new Error('thumbnail is unavailable')
        } catch (error) {
          written.delete(frame.id)
          if (persisted) await storage.deleteObject(keyFor(frame.id)).catch(() => {})
          throw error
        }
        if (persisted) written.set(frame.id, provenance)
        return buf
      } finally {
        release()
      }
    })()
    const entry = { frameId: frame.id, promise: task }
    pending.set(identity, entry)
    task.then(
      () => {
        if (pending.get(identity) === entry) pending.delete(identity)
      },
      () => {
        if (pending.get(identity) === entry) pending.delete(identity)
      },
    )
  }
  const buf = await task
  await assertRenderRead(scope, frame)
  return buf
}

/** Unknown/stale provenance is a miss before storage IO, including after restart. */
export async function getStored(input: Frame, scope: PrivateRenderScope): Promise<Buffer | null> {
  const frame = { ...input }
  await assertRenderRead(scope, frame)
  if (scope.kind !== 'frame' || dead.has(frame.id)) return null
  const known = written.get(frame.id)
  if (!known || known.content !== frameContentKey(frame)) return null
  let buf: Buffer | null
  try {
    buf = await storage.getObject(keyFor(frame.id))
  } catch {
    console.error('[thumb] storage unavailable')
    return null
  }
  await assertRenderRead(scope, frame)
  if (!buf || digest(buf) !== known.bytes || written.get(frame.id) !== known || dead.has(frame.id)) return null
  assertPrivateRenderBytes(buf)
  return buf
}

export function purge(frameId: string): void {
  dead.add(frameId)
  written.delete(frameId)
  for (const [key, entry] of pending) if (entry.frameId === frameId) pending.delete(key)
  storage.deleteObject(keyFor(frameId)).catch(() => {})
}
