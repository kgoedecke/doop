import sharp from 'sharp'
import { expect, it, vi } from 'vitest'
vi.mock('../server/auth.ts', async (original) => ({
  ...(await original<typeof import('../server/auth.ts')>()),
  isBanned: async () => false,
}))
vi.mock('../server/db/persist.ts', async (original) => ({
  ...(await original<typeof import('../server/db/persist.ts')>()),
  saveFrame: vi.fn(),
}))
import { privateMcpImage } from '../server/mcpMedia.ts'
import { frameReadScope, type ResourceReader } from '../server/privateResources.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

it('the actual default 30s preview deadline retains all four slots until begun current-reader leaves settle', async () => {
  const owner = 'preview-lifetime-owner'
  const frame: Frame = {
    id: 'preview-lifetime-frame',
    canvasId: 'preview-lifetime-canvas',
    name: 'Lifetime',
    x: 0,
    y: 0,
    width: 16,
    height: 8,
    html: '<p>Lifetime</p>',
    createdAt: 0,
    updatedAt: 0,
    updatedBy: owner,
  }
  const canvas: Canvas = {
    id: frame.canvasId,
    ownerId: owner,
    name: 'Lifetime',
    frames: [frame],
    createdAt: 0,
    updatedAt: 0,
  }
  store.init([canvas])
  const bytes = await sharp({ create: { width: 16, height: 8, channels: 4, background: 'green' } })
    .png()
    .toBuffer()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let begun = 0
  const controlledReader: ResourceReader = {
    actorId: owner,
    currentActor: async () => {
      begun++
      await held
      return owner
    },
  }
  // The injected reader intentionally ignores cancellation, like the existing
  // DB/storage interfaces. Job, scope checks, admission and worker stay real.
  const first = Array.from({ length: 5 }, () => privateMcpImage(bytes, frameReadScope(controlledReader, frame)))
  const expired = Promise.allSettled(first)
  let fresh: ReturnType<typeof privateMcpImage> | undefined
  try {
    const results = await expired
    expect(results.map((result) => result.status)).toEqual(Array(5).fill('rejected'))
    expect(begun).toBe(4)
    let freshReads = 0
    const freshReader: ResourceReader = {
      actorId: owner,
      currentActor: async () => {
        freshReads++
        return owner
      },
    }
    fresh = privateMcpImage(bytes, frameReadScope(freshReader, frame))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(freshReads).toBe(0)
    release()
    const result = await fresh
    expect(Buffer.from(result.bytes)).toEqual(bytes)
    expect(result.fullResolution).toBe(true)
    expect(begun).toBe(4)
    expect(freshReads).toBeGreaterThan(0)
  } finally {
    release()
    await expired
    if (fresh) await Promise.allSettled([fresh])
  }
}, 40_000)
