import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Client } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'
import { startPrivateStorageFixture } from './privateStorageFixture.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=',
  'base64',
)
let bucket: Awaited<ReturnType<typeof startPrivateStorageFixture>> | undefined
let native: Awaited<ReturnType<typeof startPrivateServer>> | undefined
let sdk: S3Client
let a: Client
let b: Client
let asset: string

beforeAll(async () => {
  bucket = await startPrivateStorageFixture()
  sdk = new S3Client(bucket.sdk)
  native = await startPrivateServer(bucket.env)
  a = await new Client(native.server).signUp('bucket-a@test.dev', 'Bucket A')
  b = await new Client(native.server).signUp('bucket-b@test.dev', 'Bucket B')
  const canvas = await (await a.post('/api/canvases', { name: 'Private bucket bytes' })).json()
  const uploaded = await a.req(`/api/canvases/${canvas.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG),
  })
  expect(uploaded.status).toBe(200)
  asset = new URL((await uploaded.json()).url).pathname
}, 180_000)
afterAll(async () => {
  try {
    await native?.close()
  } finally {
    sdk?.destroy()
    await bucket?.close()
  }
}, 90_000)

describe('actual private bucket and application paths', () => {
  it('uses the real signed SDK to round-trip exact bytes on the pinned fixture', async () => {
    const bytes = Buffer.from('private storage fixture')
    await sdk.send(
      new PutObjectCommand({
        Bucket: bucket!.bucket,
        Key: 'signed-control',
        Body: bytes,
        ContentType: 'application/octet-stream',
      }),
    )
    const result = await sdk.send(new GetObjectCommand({ Bucket: bucket!.bucket, Key: 'signed-control' }))
    expect(Buffer.from(await result.Body!.transformToByteArray())).toEqual(bytes)
  })
  it('normal authorized application read obtains exact bytes through the counted existing S3 backend', async () => {
    bucket!.resetCounts()
    const response = await a.get(asset)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
    expect(bucket!.counts.GET).toBe(1)
  })
  it.each([
    ['GET', {}],
    ['HEAD', {}],
    ['GET', { Range: 'bytes=0-7' }],
    ['GET', { 'If-None-Match': '*' }],
    ['GET', { Range: 'bytes=0-1,5-8' }],
  ] as const)('raw anonymous %s cannot expose object bytes or metadata (%j)', async (method, headers) => {
    const object = `${bucket!.endpoint}/${bucket!.bucket}/${asset.slice(3)}`
    const response = await fetch(object, { method, headers, redirect: 'manual' })
    expect(response.status).toBe(403)
    expect(response.headers.get('etag')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.equals(PNG)).toBe(false)
    expect(response.headers.get('content-type')).not.toContain('image/')
    expect(response.headers.get('last-modified')).toBeNull()
    // Garage reflects the requested path in a generic XML denial. Compare an
    // absent object of the same key length so reflection cannot masquerade as metadata.
    const missingKey = 'z'.repeat(asset.slice(3).length)
    const absent = await fetch(`${bucket!.endpoint}/${bucket!.bucket}/${missingKey}`, {
      method,
      headers,
      redirect: 'manual',
    })
    expect(absent.status).toBe(403)
    for (const key of ['content-type', 'content-length', 'etag', 'last-modified', 'location'])
      expect(response.headers.get(key)).toBe(absent.headers.get(key))
    const normalize = (text: string) =>
      text.replace(/<Resource>[^<]*<\/Resource>/, '<Resource>requested-path</Resource>')
    expect(normalize(bytes.toString())).toBe(normalize(await absent.text()))
  })
  it('a foreign signing secret cannot read the private object', async () => {
    const other = new S3Client({
      ...bucket!.sdk,
      credentials: { ...bucket!.sdk.credentials, secretAccessKey: '0'.repeat(64) },
    })
    try {
      await expect(
        other.send(new GetObjectCommand({ Bucket: bucket!.bucket, Key: asset.slice(3) })),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } })
    } finally {
      other.destroy()
    }
  })
  it('denies anonymous and foreign application variants before ANY bucket IO, even after warm reads', async () => {
    expect((await a.get(asset)).status).toBe(200)
    bucket!.resetCounts()
    for (const client of [null, b]) {
      for (const [method, headers] of [
        ['GET', {}],
        ['HEAD', {}],
        ['GET', { Range: 'bytes=0-7' }],
        ['GET', { 'If-None-Match': '*' }],
      ] as const) {
        const response = client
          ? await client.req(asset + '?download', { method, headers })
          : await fetch(native!.server.base + asset + '?download', { method, headers, redirect: 'manual' })
        expect(response.status).toBe(404)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(response.headers.get('etag')).toBeNull()
        expect(response.headers.get('content-type')).toBeNull()
        expect(response.headers.get('location')).toBeNull()
        expect(await response.text()).toBe('')
      }
    }
    expect(bucket!.counts).toEqual({})
  })
})
