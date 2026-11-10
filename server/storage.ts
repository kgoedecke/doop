import { env } from './env.ts'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import type { S3Client } from '@aws-sdk/client-s3'

/**
 * Byte storage for uploaded assets. With bucket credentials configured the
 * bytes live in S3-compatible object storage — the env names match what a
 * Railway Bucket injects via variable references (BUCKET, ACCESS_KEY_ID,
 * SECRET_ACCESS_KEY, ENDPOINT, REGION); R2 or S3 work with the same names.
 * Without them (local development) bytes land under ./data/assets, next to
 * PGlite. Either way the assets table is the source of truth for what exists.
 */

const BUCKET = env.BUCKET
const DISK_DIR = path.join(process.cwd(), 'data', 'assets')

export const storageMode: 'bucket' | 'disk' = BUCKET ? 'bucket' : 'disk'

/* keys are `<nanoid>.<ext>`, optionally under the `thumb/` prefix (derived
   frame previews — a folder of their own so they can be purged or lifecycle-
   ruled without touching user uploads) or the `bg/` prefix (the curated
   background library, server/backgrounds.ts). Anything else is a bug, and in
   disk mode the check doubles as the path-traversal guard: known literal
   prefixes, no dots or slashes in the name. */
function assertKey(key: string) {
  if (!/^(thumb\/|bg\/)?[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(key)) throw new Error(`malformed storage key: ${key}`)
}

let s3: S3Client | undefined

/** One deadline includes bucket response headers and the complete streamed body. */
export const STORAGE_TIMEOUT_MS = 30_000

async function boundedStorage<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('stored object operation timed out')), STORAGE_TIMEOUT_MS)
  timer.unref()
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function client(): Promise<S3Client> {
  if (!s3) {
    /* loaded on demand so dev without a bucket never pays for the SDK */
    const { S3Client } = await import('@aws-sdk/client-s3')
    s3 = new S3Client({
      region: env.REGION,
      endpoint: env.ENDPOINT,
      credentials:
        env.ACCESS_KEY_ID && env.SECRET_ACCESS_KEY
          ? { accessKeyId: env.ACCESS_KEY_ID, secretAccessKey: env.SECRET_ACCESS_KEY }
          : undefined,
    })
  }
  return s3
}

export async function putObject(key: string, body: Buffer, mime: string): Promise<void> {
  assertKey(key)
  if (BUCKET) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    await boundedStorage(async (signal) =>
      (await client()).send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: mime }), {
        abortSignal: signal,
      }),
    )
    return
  }
  await fs.mkdir(path.dirname(path.join(DISK_DIR, key)), { recursive: true })
  await fs.writeFile(path.join(DISK_DIR, key), body)
}

export async function deleteObject(key: string): Promise<void> {
  assertKey(key)
  if (BUCKET) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    await boundedStorage(async (signal) =>
      (await client()).send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }), { abortSignal: signal }),
    )
    return
  }
  await fs.rm(path.join(DISK_DIR, key), { force: true })
}

export const MAX_STORED_READ_BYTES = 10 * 1024 * 1024

async function collect(chunks: AsyncIterable<Uint8Array>, maximum: number): Promise<Buffer> {
  const parts: Uint8Array[] = []
  let size = 0
  for await (const chunk of chunks) {
    size += chunk.byteLength
    if (size > maximum) throw new Error('stored object exceeds its read budget')
    parts.push(chunk)
  }
  return Buffer.concat(parts, size)
}

async function* webChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) return
      yield value
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

export async function getObject(key: string, maximum = MAX_STORED_READ_BYTES): Promise<Buffer | null> {
  assertKey(key)
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > MAX_STORED_READ_BYTES)
    throw new Error('invalid stored object read budget')
  if (BUCKET) {
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3')
      return await boundedStorage(async (signal) => {
        const out = await (
          await client()
        ).send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
          abortSignal: signal,
        })
        if (!out.Body) throw new Error('stored object body is missing')
        if (out.ContentLength !== undefined && out.ContentLength > maximum) {
          await out.Body.transformToWebStream().cancel()
          throw new Error('stored object exceeds its read budget')
        }
        return collect(webChunks(out.Body.transformToWebStream(), signal), maximum)
      })
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null
      throw e
    }
  }
  try {
    return await collect(
      createReadStream(path.join(DISK_DIR, key), { highWaterMark: Math.min(maximum + 1, 64 * 1024) }),
      maximum,
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
