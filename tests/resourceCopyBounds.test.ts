import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'
import type * as t from '../server/db/schema.ts'

type Asset = typeof t.assets.$inferSelect
const rig = vi.hoisted(() => ({
  assets: new Map<string, Asset>(),
  read: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  publishAssets: vi.fn(),
  publishFonts: vi.fn(),
}))
vi.mock('../server/assets.ts', () => ({
  MAX_ASSET_BYTES: 5 * 1024 * 1024,
  assetMetadata: (id: string) => rig.assets.get(id),
  getAsset: rig.read,
  publishCopiedAssets: rig.publishAssets,
  validateAssetReferences: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ canvasFontRows: () => [], publishCopiedFonts: rig.publishFonts }))
vi.mock('../server/storage.ts', () => ({ putObject: rig.put, deleteObject: rig.remove }))
vi.mock('../server/db/persist.ts', () => ({ insertCanvas: async () => {} }))
// This controlled-I/O rig has an active authenticated actor; native server
// tests exercise actual account revocation and database-backed authentication.
vi.mock('../server/auth.ts', () => ({ isBanned: async () => false }))
const { store } = await import('../server/store.ts')
const { prepareCanvasResourceCopy } = await import('../server/resourceCopies.ts')
const { PrivateResourceError } = await import('../server/privateResources.ts')

let source: Canvas
beforeEach(async () => {
  store.canvases.clear()
  rig.assets.clear()
  rig.read.mockReset().mockImplementation(async (id: string) => {
    const row = rig.assets.get(id)!
    return { meta: { id, mime: row.mime, ext: row.ext, size: row.size }, buf: Buffer.alloc(row.size) }
  })
  rig.put.mockReset().mockResolvedValue(undefined)
  rig.remove.mockReset().mockResolvedValue(undefined)
  rig.publishAssets.mockClear()
  rig.publishFonts.mockClear()
  source = await store.createCanvas('Source', 'owner')
  source.memberIds = ['actor']
})

function destination(groups: number[], bytes = 1): Canvas {
  let count = 0
  const frames: Frame[] = groups.map((length, index) => {
    const urls = Array.from({ length }, () => {
      const id = `source_asset_${count++}`
      rig.assets.set(id, {
        id,
        canvasId: source.id,
        ownerId: 'owner',
        mime: 'image/png',
        ext: 'png',
        size: bytes,
        uploadedBy: 'owner',
        createdAt: 1,
      })
      return `<img src="/a/${id}.png">`
    })
    return {
      id: `new_frame_${index}`,
      canvasId: 'destination',
      name: 'Copy',
      html: urls.join(''),
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      createdAt: 1,
      updatedAt: 1,
      updatedBy: 'actor',
    }
  })
  return { id: 'destination', ownerId: 'actor', name: 'Destination', frames, createdAt: 1, updatedAt: 1 }
}

function barrier() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

describe('copy budgets before storage I/O', () => {
  it('refuses 65 distinct assets across multiple otherwise valid HTML carriers', async () => {
    await expect(prepareCanvasResourceCopy(source.id, destination([33, 32]), 'actor')).rejects.toThrow(/count budget/)
    expect(rig.read).not.toHaveBeenCalled()
    expect(rig.put).not.toHaveBeenCalled()
  })

  it('refuses aggregate content above 64MiB even when every file is within its 5MiB limit', async () => {
    await expect(prepareCanvasResourceCopy(source.id, destination([14], 5 * 1024 * 1024), 'actor')).rejects.toThrow(
      /byte budget/,
    )
    expect(rig.read).not.toHaveBeenCalled()
    expect(rig.put).not.toHaveBeenCalled()
  })
})

it('keeps at most four competing storage reads/writes active and does not publish during preparation', async () => {
  const readGate = barrier()
  const writeGate = barrier()
  let active = 0
  let peak = 0
  const begin = () => {
    peak = Math.max(peak, ++active)
  }
  const read = rig.read.getMockImplementation()!
  rig.read.mockImplementation(async (id: string) => {
    begin()
    try {
      await readGate.wait
      return await read(id)
    } finally {
      active--
    }
  })
  rig.put.mockImplementation(async () => {
    begin()
    try {
      await writeGate.wait
    } finally {
      active--
    }
  })
  const preparing = prepareCanvasResourceCopy(source.id, destination([12]), 'actor')
  try {
    await expect.poll(() => rig.read.mock.calls.length).toBe(4)
    expect(active).toBe(4)
    expect(rig.put).not.toHaveBeenCalled()
    readGate.release()
    await expect.poll(() => rig.put.mock.calls.length).toBe(4)
    expect(rig.read).toHaveBeenCalledTimes(4)
    expect(active).toBe(4)
  } finally {
    readGate.release()
    writeGate.release()
    await preparing.catch(() => {})
  }
  const copy = await preparing
  expect(copy.assets).toHaveLength(12)
  expect(rig.read).toHaveBeenCalledTimes(12)
  expect(rig.put).toHaveBeenCalledTimes(12)
  expect(peak).toBe(4)
  expect(active).toBe(0)
  expect(store.getCanvas('destination')).toBeUndefined()
  expect(rig.publishAssets).not.toHaveBeenCalled()
  expect(rig.publishFonts).not.toHaveBeenCalled()
})

it('refuses current source-policy loss while reads are held, before any destination object or metadata is published', async () => {
  const gate = barrier()
  const read = rig.read.getMockImplementation()!
  rig.read.mockImplementation(async (id: string) => {
    await gate.wait
    return read(id)
  })
  const preparing = prepareCanvasResourceCopy(source.id, destination([8]), 'actor')
  const rejected = expect(preparing).rejects.toBeInstanceOf(PrivateResourceError)
  try {
    await expect.poll(() => rig.read.mock.calls.length).toBe(4)
    source.memberIds = []
  } finally {
    gate.release()
  }
  await rejected
  expect(rig.read).toHaveBeenCalledTimes(4)
  expect(rig.put).not.toHaveBeenCalled()
  expect(store.getCanvas('destination')).toBeUndefined()
  expect(rig.publishAssets).not.toHaveBeenCalled()
  expect(rig.publishFonts).not.toHaveBeenCalled()
})
