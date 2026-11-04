import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { db } from '../server/db/index.ts'
import * as t from '../server/db/schema.ts'
import { emitCanvasEvent, onCanvasEvent, type CanvasEvent } from '../server/events.ts'
import { createAsset, imagesForFrames, storeAsset } from '../server/assets.ts'
import {
  DESCRIBE_LONG_EDGE_PX,
  MAX_DESCRIBE_ATTEMPTS,
  describeAsset,
  describeIdle,
  describerFor,
  enqueueDescription,
  enqueuePending,
  onCanvasEvent as queueOnCanvasEvent,
  startImageDescriptions,
} from '../server/imageDescriptions.ts'
import { saveImageDescriptionMode } from '../server/imageDescriptionPrefs.ts'
import { store } from '../server/store.ts'
import type { AgentTurnRequest } from '../server/agentModel.ts'

/**
 * Image descriptions (.context/specs/image-descriptions.md): a stored image
 * is an event, the owner's preference and account pick the describer, and
 * the worker writes one paragraph per asset — once, with retries bounded,
 * within a day's budget, and over the backlog an earlier process left.
 */

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  own: vi.fn(),
  server: vi.fn(),
  run: vi.fn(),
  objects: new Map<string, Buffer>(),
}))

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})
vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))
vi.mock('../server/storage.ts', () => ({
  storageMode: 'disk',
  putObject: async (key: string, buf: Buffer) => void mocks.objects.set(key, buf),
  getObject: async (key: string) => mocks.objects.get(key) ?? null,
}))
vi.mock('../server/modelAccounts.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/modelAccounts.ts')>()
  return { ...original, getAccount: mocks.account }
})
vi.mock('../server/agentModel.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/agentModel.ts')>()
  return { ...original, accountDescriber: mocks.own, serverDescriber: mocks.server }
})
vi.mock('../server/env.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/env.ts')>()
  return { ...original, env: { ...original.env, DESCRIBE_PER_CANVAS_PER_DAY: 4, DESCRIBE_CONCURRENCY: 2 } }
})

const fake = (label: string) => ({ provider: 'anthropic' as const, label, run: mocks.run })
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], stop_reason: 'end_turn' as const })

let png: Buffer
beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
  png = await sharp({ create: { width: 3000, height: 1200, channels: 3, background: '#4080ff' } })
    .png()
    .toBuffer()
}, 30_000)

let canvasN = 0
function canvas(ownerId = 'owner') {
  const id = `canvas-${++canvasN}`
  store.canvases.set(id, { id, ownerId, name: 'Shots', pages: [], frames: [], createdAt: 0, updatedAt: 0 })
  return id
}

beforeEach(() => {
  mocks.account.mockReset().mockResolvedValue(null)
  mocks.own.mockReset().mockReturnValue(null)
  mocks.server.mockReset().mockReturnValue(fake('Doop (haiku)'))
  mocks.run.mockReset().mockResolvedValue(answer('A checkout screen with a blue Pay button.'))
})

const row = async (id: string) => (await db.select().from(t.assets).where(eq(t.assets.id, id)))[0]!

describe('storing an image', () => {
  it('starts undescribed and announces itself as asset.stored', async () => {
    const seen: CanvasEvent[] = []
    const off = onCanvasEvent((_canvasId, event) => void seen.push(event))
    const canvasId = canvas()
    const asset = await createAsset(png, { canvasId, uploadedBy: 'alice' })
    off()
    expect(await row(asset.id)).toMatchObject({ description: null, describeAttempts: 0, describedAt: null })
    expect(seen).toEqual([{ type: 'asset.stored', asset: { ...asset, canvasId } }])
  })

  it('is no event for a font, an svg, or an asset without a canvas', async () => {
    const seen: CanvasEvent[] = []
    const off = onCanvasEvent((_canvasId, event) => void seen.push(event))
    await storeAsset(Buffer.from('wOFF'), { mime: 'font/woff', ext: 'woff' }, { canvasId: canvas(), uploadedBy: 'a' })
    await createAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { canvasId: canvas(), uploadedBy: 'a' })
    await createAsset(png, { uploadedBy: 'a' })
    off()
    expect(seen).toEqual([])
  })
})

describe('which model describes', () => {
  it('runs on the owner’s account when it can see', async () => {
    mocks.account.mockResolvedValue({ kind: 'anthropic-key', userId: 'owner' })
    mocks.own.mockReturnValue(fake('Claude API (haiku)'))
    expect(await describerFor('owner')).toMatchObject({ status: { label: 'Claude API (haiku)' } })
  })

  it('falls through to the server tier for a text-only account, and says so when there is none', async () => {
    mocks.account.mockResolvedValue({ kind: 'openrouter-key', userId: 'owner' })
    expect(await describerFor('owner')).toMatchObject({ status: { label: 'Doop (haiku)' } })
    mocks.server.mockReturnValue(null)
    expect(await describerFor('owner')).toEqual({ model: null, status: { label: null, reason: 'text-only' } })
  })

  it('uses the server tier for an owner without an account, and reports no-model without a key', async () => {
    expect(await describerFor('owner')).toMatchObject({ status: { label: 'Doop (haiku)' } })
    mocks.server.mockReturnValue(null)
    expect(await describerFor('owner')).toEqual({ model: null, status: { label: null, reason: 'no-model' } })
  })

  it('honours off and server', async () => {
    mocks.account.mockResolvedValue({ kind: 'anthropic-key', userId: 'picky' })
    mocks.own.mockReturnValue(fake('Claude API (haiku)'))
    await saveImageDescriptionMode('picky', 'off')
    expect(await describerFor('picky')).toEqual({ model: null, status: { label: null, reason: 'off' } })
    await saveImageDescriptionMode('picky', 'server')
    expect(await describerFor('picky')).toMatchObject({ status: { label: 'Doop (haiku)' } })
    expect(mocks.own).not.toHaveBeenCalled()
  })
})

describe('the worker', () => {
  it('describes a queued image once, shrunk to the long edge, and tells the room', async () => {
    const canvasId = canvas()
    const sent: unknown[] = []
    await startImageDescriptions((id, msg) => void sent.push([id, msg]))
    /* boot also queues what the tests above left undescribed; let that pass */
    await describeIdle()
    mocks.run.mockClear()
    const asset = await createAsset(png, { canvasId, uploadedBy: 'alice' })
    queueOnCanvasEvent(canvasId, { type: 'asset.stored', asset: { ...asset, canvasId } })
    await describeIdle()
    expect(await row(asset.id)).toMatchObject({
      description: 'A checkout screen with a blue Pay button.',
      describedBy: 'Doop (haiku)',
      describeAttempts: 0,
    })
    expect(sent).toContainEqual([
      canvasId,
      { type: 'asset:described', assetId: asset.id, description: 'A checkout screen with a blue Pay button.' },
    ])
    const req = mocks.run.mock.calls[0]![0] as AgentTurnRequest
    const image = (req.messages[0]!.content as { type: string; source?: { data: string } }[])[0]!
    const meta = await sharp(Buffer.from(image.source!.data, 'base64')).metadata()
    expect(meta.width).toBe(DESCRIBE_LONG_EDGE_PX)
    expect(req.tools).toEqual([])
    /* once: a second pass is a no-op */
    expect(await describeAsset(asset.id)).toBe('skipped')
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })

  it('counts a failed attempt and gives up after the last one', async () => {
    const canvasId = canvas()
    const asset = await createAsset(png, { canvasId, uploadedBy: 'alice' })
    mocks.run.mockRejectedValue(new Error('overloaded'))
    for (let attempt = 1; attempt <= MAX_DESCRIBE_ATTEMPTS; attempt++) {
      expect(await describeAsset(asset.id)).toBe('failed')
      expect((await row(asset.id)).describeAttempts).toBe(attempt)
    }
    expect(await describeAsset(asset.id)).toBe('skipped')
    expect(mocks.run).toHaveBeenCalledTimes(MAX_DESCRIBE_ATTEMPTS)
  })

  it('stops at the canvas’s daily budget (failed calls count: they may have cost something)', async () => {
    const canvasId = canvas()
    const results = []
    for (let i = 0; i < 5; i++) {
      const asset = await createAsset(png, { canvasId, uploadedBy: 'alice' })
      results.push(await describeAsset(asset.id))
    }
    expect(results).toEqual(['described', 'described', 'described', 'described', 'skipped'])
  })

  it('leaves an image alone when its owner turned descriptions off', async () => {
    await saveImageDescriptionMode('quiet', 'off')
    const asset = await createAsset(png, { canvasId: canvas('quiet'), uploadedBy: 'alice' })
    expect(await describeAsset(asset.id)).toBe('skipped')
    expect(mocks.run).not.toHaveBeenCalled()
    expect((await row(asset.id)).describeAttempts).toBe(0)
  })

  it('picks up the backlog an earlier process left', async () => {
    const canvasId = canvas()
    const asset = await createAsset(png, { canvasId, uploadedBy: 'alice' })
    const spent = await createAsset(png, { canvasId: canvas(), uploadedBy: 'alice' })
    await db.update(t.assets).set({ describeAttempts: MAX_DESCRIBE_ATTEMPTS }).where(eq(t.assets.id, spent.id))
    const pending = await enqueuePending()
    await describeIdle()
    expect(pending).toBeGreaterThanOrEqual(1)
    expect((await row(asset.id)).description).toBeTruthy()
    expect((await row(spent.id)).description).toBeNull()
  })

  it('queues one id once', async () => {
    const asset = await createAsset(png, { canvasId: canvas(), uploadedBy: 'alice' })
    enqueueDescription(asset.id)
    enqueueDescription(asset.id)
    await describeIdle()
    expect(mocks.run).toHaveBeenCalledTimes(1)
  })
})

describe('what agents read', () => {
  it('lists each frame’s raster images with their descriptions', async () => {
    const canvasId = canvas()
    const shot = await createAsset(png, { canvasId, uploadedBy: 'alice' })
    const pending = await createAsset(png, { canvasId, uploadedBy: 'alice' })
    const vector = await createAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
      canvasId,
      uploadedBy: 'alice',
    })
    await db.update(t.assets).set({ description: 'A login form.' }).where(eq(t.assets.id, shot.id))
    await db.insert(t.assetRefs).values([
      { assetId: shot.id, frameId: 'frame-a' },
      { assetId: pending.id, frameId: 'frame-a' },
      { assetId: vector.id, frameId: 'frame-a' },
      { assetId: shot.id, frameId: 'frame-b' },
    ])
    const images = await imagesForFrames(['frame-a', 'frame-b', 'frame-empty'])
    expect(images.get('frame-a')).toEqual(
      expect.arrayContaining([
        { src: `/a/${shot.id}.png`, description: 'A login form.' },
        { src: `/a/${pending.id}.png`, description: null },
      ]),
    )
    expect(images.get('frame-a')).toHaveLength(2)
    expect(images.get('frame-b')).toEqual([{ src: `/a/${shot.id}.png`, description: 'A login form.' }])
    expect(images.has('frame-empty')).toBe(false)
    expect(await imagesForFrames([])).toEqual(new Map())
  })

  it('is reached by the event bus', async () => {
    const seen: string[] = []
    const off = onCanvasEvent((_c, event) => void seen.push(event.type))
    emitCanvasEvent('c', {
      type: 'asset.stored',
      asset: { id: 'x', mime: 'image/png', ext: 'png', size: 1, canvasId: 'c' },
    })
    off()
    expect(seen).toEqual(['asset.stored'])
  })
})
