import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({
  renderFrame: vi.fn(),
  putObject: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
  assertRead: vi.fn(),
}))
// This cache-only rig supplies loaded snapshots; cold-source/auth behavior is exercised by privateLazyLoading.
vi.mock('../server/store.ts', () => ({ store: { renderSource: async (frame: Frame) => ({ ...frame }) } }))
vi.mock('../server/screenshot.ts', () => ({ renderFrame: mocks.renderFrame }))
vi.mock('../server/storage.ts', () => ({
  putObject: mocks.putObject,
  getObject: mocks.getObject,
  deleteObject: mocks.deleteObject,
}))
/* Policy is exercised against real auth/PG in privateFileAccess/privateMediaCache. */
vi.mock('../server/privateResources.ts', async (original) => ({
  ...(await original<typeof import('../server/privateResources.ts')>()),
  assertRenderRead: mocks.assertRead,
}))
import { getImage, primeImage } from '../server/previews.ts'
import { frameReadScope } from '../server/privateResources.ts'
let seq = 0
const reader = { actorId: 'a', currentActor: async () => 'a' }
const frame = (over: Partial<Frame> = {}): Frame =>
  ({
    id: `f${seq++}`,
    canvasId: 'c',
    name: 'f',
    x: 0,
    y: 0,
    width: 1280,
    height: 900,
    html: '',
    updatedAt: 1,
    updatedBy: 't',
    ...over,
  }) as Frame
const req = (f: Frame, over: Partial<Parameters<typeof getImage>[1]> = {}): Parameters<typeof getImage>[1] => ({
  ext: 'jpg',
  scale: 1,
  quality: 90,
  preview: false,
  scope: frameReadScope(reader, f),
  ...over,
})
beforeEach(() => {
  mocks.assertRead.mockReset().mockResolvedValue(undefined)
  mocks.renderFrame.mockReset().mockResolvedValue(Buffer.from('rendered'))
  mocks.putObject.mockReset().mockResolvedValue(undefined)
  mocks.getObject.mockReset().mockResolvedValue(null)
  mocks.deleteObject.mockReset().mockResolvedValue(undefined)
})
describe('getImage', () => {
  it('png?preview does a full png render, never the jpeg thumb path', async () => {
    const f = frame()
    expect((await getImage(f, req(f, { ext: 'png', preview: true }))).status).toBe('ok')
    expect(mocks.renderFrame).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      expect.objectContaining({ type: 'png' }),
    )
    expect(mocks.getObject).not.toHaveBeenCalled()
    expect(mocks.putObject).not.toHaveBeenCalled()
  })
  it('jpg?preview renders card-size and persists the thumb', async () => {
    const f = frame()
    await getImage(f, req(f, { preview: true }))
    expect(mocks.renderFrame).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      0.5,
      expect.objectContaining({ type: 'jpeg', quality: 70, maxHeight: 1200 }),
    )
    expect(mocks.putObject).toHaveBeenCalledWith(`thumb/${f.id}.jpg`, expect.anything(), 'image/jpeg')
  })
  it('caches content even when timestamps collide and never labels old bytes as new', async () => {
    const f = frame()
    await getImage(f, req(f))
    await getImage(f, req(f))
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
    await getImage({ ...f, html: '<p>new</p>' }, req(f))
    expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
  })
  it('a failed render is not cached — the next request retries', async () => {
    const f = frame()
    mocks.renderFrame.mockRejectedValueOnce(new Error('chromium died'))
    await expect(getImage(f, req(f))).rejects.toThrow('chromium died')
    await expect(getImage(f, req(f))).resolves.toMatchObject({ status: 'ok' })
    expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
  })
  it('denies before rendering, storage and warmed cache reuse', async () => {
    const f = frame()
    await getImage(f, req(f))
    mocks.assertRead.mockRejectedValue(new Error('revoked'))
    await expect(getImage(f, req(f))).rejects.toThrow('revoked')
    await expect(getImage(frame(), req(f, { preview: true }))).rejects.toThrow('revoked')
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
    expect(mocks.getObject).not.toHaveBeenCalled()
  })
  it('does not read unknown persisted thumbs or serve their stale bytes', async () => {
    mocks.getObject.mockResolvedValue(Buffer.from('unknown'))
    const f = frame()
    expect((await getImage(f, req(f, { preview: true }))).buf.toString()).toBe('rendered')
    expect(mocks.getObject).not.toHaveBeenCalled()
  })
  it('primeImage seeds only the admitted content and still guards every reuse', async () => {
    const f = frame()
    await primeImage(f, frameReadScope(reader, f), 1, Buffer.from('from-the-tool'))
    expect((await getImage(f, req(f, { ext: 'png' }))).buf.toString()).toBe('from-the-tool')
    expect(mocks.renderFrame).not.toHaveBeenCalled()
    await getImage({ ...f, html: 'new' }, req(f, { ext: 'png' }))
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
    mocks.assertRead.mockRejectedValue(new Error('revoked'))
    await expect(getImage(f, req(f, { ext: 'png' }))).rejects.toThrow('revoked')
  })
  it('rejects output above 15,000,000 bytes and never caches the failed render', async () => {
    const f = frame()
    mocks.renderFrame.mockResolvedValueOnce(Buffer.alloc(15_000_001))
    await expect(getImage(f, req(f))).rejects.toThrow('output budget')
    await getImage(f, req(f))
    expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
  })
  it('evicts completed bytes above 64MiB rather than just counting entries', async () => {
    mocks.renderFrame.mockResolvedValue(Buffer.alloc(14_000_000))
    const frames = Array.from({ length: 5 }, () => frame())
    for (const f of frames) await getImage(f, req(f))
    await getImage(frames[0]!, req(frames[0]!))
    expect(mocks.renderFrame).toHaveBeenCalledTimes(6)
  })
})

it('the private cache expires after5min even when content stays unchanged', async () => {
  const f = frame()
  await getImage(f, req(f))
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000)
  try {
    await getImage(f, req(f))
    expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
  } finally {
    clock.mockRestore()
  }
})
it('the private cache evicts the oldest entry at its200-entry ceiling', async () => {
  const first = frame()
  await primeImage(first, frameReadScope(reader, first), 1, Buffer.from('first'))
  for (let i = 0; i < 200; i++) {
    const f = frame()
    await primeImage(f, frameReadScope(reader, f), 1, Buffer.from('next'))
  }
  await getImage(first, req(first, { ext: 'png' }))
  expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
})

it('priming freezes content before its async guard so a live input edit cannot mislabel old pixels', async () => {
  const f = frame()
  mocks.assertRead.mockImplementationOnce(async () => {
    f.html = 'new content during authority IO'
  })
  await primeImage(f, frameReadScope(reader, f), 1, Buffer.from('old pixels'))
  expect((await getImage(f, req(f, { ext: 'png' }))).buf.toString()).toBe('rendered')
  expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
})
