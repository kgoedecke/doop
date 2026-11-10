import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
const mocks = vi.hoisted(() => ({
  renderFrame: vi.fn(),
  putObject: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
  assertRead: vi.fn(),
}))
vi.mock('../server/screenshot.ts', () => ({ renderFrame: mocks.renderFrame }))
vi.mock('../server/storage.ts', () => ({
  putObject: mocks.putObject,
  getObject: mocks.getObject,
  deleteObject: mocks.deleteObject,
}))
/* Byte/cache/queue protocol here; current policy and real renders have native tests. */
vi.mock('../server/privateResources.ts', async (original) => ({
  ...(await original<typeof import('../server/privateResources.ts')>()),
  assertRenderRead: mocks.assertRead,
}))
import * as thumbs from '../server/thumbs.ts'
import { frameReadScope } from '../server/privateResources.ts'
const reader = { actorId: 'a', currentActor: async () => 'a' }
const frame = (id: string, html = ''): Frame =>
  ({ id, canvasId: 'c', name: id, x: 0, y: 0, width: 1280, height: 900, html, updatedAt: 1, updatedBy: 't' }) as Frame
const scope = (f: Frame) => frameReadScope(reader, f)
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function deferredRenders() {
  const resolve: Array<(b: Buffer) => void> = []
  mocks.renderFrame.mockImplementation(() => new Promise<Buffer>((r) => resolve.push(r)))
  return resolve
}
beforeEach(() => {
  mocks.assertRead.mockReset().mockResolvedValue(undefined)
  mocks.renderFrame.mockReset().mockResolvedValue(Buffer.from('rendered'))
  mocks.putObject.mockReset().mockResolvedValue(undefined)
  mocks.getObject.mockReset().mockResolvedValue(null)
  mocks.deleteObject.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())
describe('thumbs', () => {
  it('bounds the actual upstream pipeline at3 active plus16 waiters and rejects overflow', async () => {
    const resolve = deferredRenders()
    const all = Array.from({ length: 19 }, (_, i) => {
      const f = frame(`cap-${i}`)
      return thumbs.create(f, scope(f))
    })
    await flush()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(3)
    const excess = frame('cap-excess')
    await expect(thumbs.create(excess, scope(excess))).rejects.toThrow('capacity')
    for (let i = 0; i < 19; i++) {
      resolve[i]!(Buffer.from('x'))
      await flush()
      expect(mocks.renderFrame.mock.calls.length).toBeLessThanOrEqual(i + 4)
    }
    await Promise.all(all)
    expect(mocks.renderFrame).toHaveBeenCalledTimes(19)
  })
  it('expires a queued thumbnail after30s and frees capacity for later work', async () => {
    vi.useFakeTimers()
    const resolve = deferredRenders()
    const all = Array.from({ length: 3 }, (_, i) => {
      const f = frame(`deadline-${i}`)
      return thumbs.create(f, scope(f))
    })
    const f = frame('deadline-wait')
    const expired = expect(thumbs.create(f, scope(f))).rejects.toThrow('capacity')
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    await expired
    expect(mocks.renderFrame).toHaveBeenCalledTimes(3)
    for (const r of resolve) r(Buffer.from('x'))
    await Promise.all(all)
    mocks.renderFrame.mockResolvedValue(Buffer.from('next'))
    await expect(thumbs.create(f, scope(f))).resolves.toEqual(Buffer.from('next'))
  })
  it('keeps all three pipeline slots while persistence holds rendered buffers', async () => {
    const finishes: Array<() => void> = []
    mocks.putObject.mockImplementation(() => new Promise<void>((r) => finishes.push(r)))
    const all = Array.from({ length: 4 }, (_, i) => {
      const f = frame(`put-held-${i}`)
      return thumbs.create(f, scope(f))
    })
    await flush()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(3)
    expect(finishes).toHaveLength(3)
    finishes[0]!()
    await flush()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(4)
    for (const finish of finishes.slice(1)) finish()
    await Promise.all(all)
  })
  it('does not persist a thumb for a frame purged mid-render', async () => {
    const resolve = deferredRenders()
    const f = frame('purged-mid-render')
    const p = thumbs.create(f, scope(f))
    const refused = expect(p).rejects.toThrow('unavailable')
    await flush()
    thumbs.purge(f.id)
    resolve[0]!(Buffer.from('late'))
    await refused
    expect(mocks.putObject).not.toHaveBeenCalled()
  })
  it('deletes its own write when purge lands during the put', async () => {
    let finishPut!: () => void
    mocks.putObject.mockImplementation(
      () =>
        new Promise<void>((r) => {
          finishPut = r
        }),
    )
    const f = frame('purged-during-put')
    const p = thumbs.create(f, scope(f))
    const refused = expect(p).rejects.toThrow('unavailable')
    await flush()
    thumbs.purge(f.id)
    finishPut()
    await refused
    expect(mocks.deleteObject).toHaveBeenCalledWith(`thumb/${f.id}.jpg`)
  })
  it('unknown persisted provenance is a miss before storage, with no stale background serve', async () => {
    mocks.getObject.mockResolvedValue(Buffer.from('stale'))
    const f = frame('unknown-frame')
    expect(await thumbs.getStored(f, scope(f))).toBeNull()
    expect(mocks.getObject).not.toHaveBeenCalled()
    expect(mocks.renderFrame).not.toHaveBeenCalled()
  })
  it('shares identical content but never shares different content pending for one frame', async () => {
    const resolve = deferredRenders()
    const a = frame('content-pending', 'old')
    const b = { ...a, html: 'new' }
    const first = thumbs.create(a, scope(a))
    const same = thumbs.create(a, scope(a))
    const second = thumbs.create(b, scope(b))
    await flush()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
    resolve[1]!(Buffer.from('new'))
    resolve[0]!(Buffer.from('old'))
    expect(await first).toEqual(Buffer.from('old'))
    expect(await same).toEqual(Buffer.from('old'))
    expect(await second).toEqual(Buffer.from('new'))
    expect(mocks.renderFrame.mock.calls.map(([f]) => f.html)).toEqual(['old', 'new'])
  })
  it('rejects mismatched persisted bytes even when write acknowledgements arrive in reverse physical order', async () => {
    let stored: Buffer | null = null
    const writes: Array<{ commit: () => void; ack: () => void }> = []
    mocks.renderFrame.mockImplementation(async (f: Frame) => Buffer.from(f.html))
    mocks.putObject.mockImplementation(
      (_key: string, buf: Buffer) =>
        new Promise<void>((ack) =>
          writes.push({
            commit: () => {
              stored = buf
            },
            ack,
          }),
        ),
    )
    mocks.getObject.mockImplementation(async () => stored)
    const old = frame('reverse-writes', 'old')
    const newer = { ...old, html: 'new' }
    const a = thumbs.create(old, scope(old))
    const b = thumbs.create(newer, scope(newer))
    await flush()
    expect(writes).toHaveLength(2)
    writes[1]!.commit()
    writes[0]!.commit()
    writes[0]!.ack()
    await flush()
    writes[1]!.ack()
    await Promise.all([a, b])
    expect(await thumbs.getStored(newer, scope(newer))).toBeNull()
    expect(await thumbs.getStored(old, scope(old))).toBeNull()
    mocks.putObject.mockImplementation(async (_key: string, buf: Buffer) => {
      stored = buf
    })
    await thumbs.create(newer, scope(newer))
    expect(await thumbs.getStored(newer, scope(newer))).toEqual(Buffer.from('new'))
  })
})
