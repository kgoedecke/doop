import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

/* Deferred renders so tests control when Chromium "finishes" */
const mocks = vi.hoisted(() => ({
  renderFrame: vi.fn(),
  putObject: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}))

vi.mock('../server/screenshot.ts', () => ({ renderFrame: mocks.renderFrame }))
/* what a render is supplied by its canvas is read off the store; here every frame names one token */
vi.mock('../server/frameCompose.ts', () => ({
  stampRender: (stamp: RenderStamp, source: Frame) =>
    stampDependencies(source.canvasId, stamp, [tokenDependency('--ink')]),
}))
vi.mock('../server/storage.ts', () => ({
  putObject: mocks.putObject,
  getObject: mocks.getObject,
  deleteObject: mocks.deleteObject,
}))

import * as thumbs from '../server/thumbs.ts'
import { bumpStyle, stampDependencies, tokenDependency, type RenderStamp } from '../server/styleVersion.ts'

const frame = (id: string): Frame =>
  ({
    id,
    canvasId: 'c',
    name: id,
    x: 0,
    y: 0,
    width: 1280,
    height: 900,
    html: '',
    updatedAt: 1,
    updatedBy: 't',
  }) as Frame

function deferredRenders() {
  const resolvers: Array<(b: Buffer) => void> = []
  mocks.renderFrame.mockImplementation(() => new Promise<Buffer>((r) => resolvers.push(r)))
  return resolvers
}

const tick = () => new Promise((r) => setTimeout(r, 25))

beforeEach(() => {
  mocks.renderFrame.mockReset()
  mocks.putObject.mockReset().mockResolvedValue(undefined)
  mocks.getObject.mockReset().mockResolvedValue(null)
  mocks.deleteObject.mockReset().mockResolvedValue(undefined)
})

describe('thumbs', () => {
  it('bounds concurrent renders globally — breadth across frames cannot fan out unbounded', async () => {
    const resolvers = deferredRenders()
    const all = Array.from({ length: 10 }, (_, i) => thumbs.create(frame(`cap-${i}`)))
    await tick()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(3)

    /* finishing one admits exactly one waiter — never a burst */
    resolvers[0]!(Buffer.from('x'))
    await tick()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(4)

    for (let i = 1; i < 10; i++) {
      resolvers[i]?.(Buffer.from('x'))
      await tick()
    }
    await Promise.all(all)
    expect(mocks.renderFrame).toHaveBeenCalledTimes(10)
  })

  it('does not persist a thumb for a frame purged mid-render', async () => {
    const resolvers = deferredRenders()
    const p = thumbs.create(frame('purged-mid-render'))
    await tick()
    thumbs.purge('purged-mid-render')
    resolvers[0]!(Buffer.from('late'))
    await p
    await tick()
    expect(mocks.putObject).not.toHaveBeenCalled()
  })

  it('deletes its own write when purge lands during the put', async () => {
    const resolvers = deferredRenders()
    let finishPut!: () => void
    mocks.putObject.mockImplementation(() => new Promise<void>((r) => (finishPut = r)))
    const p = thumbs.create(frame('purged-during-put'))
    await tick()
    resolvers[0]!(Buffer.from('x'))
    await tick() /* now inside putObject */
    thumbs.purge('purged-during-put')
    finishPut()
    await p
    await tick()
    expect(mocks.deleteObject).toHaveBeenCalledWith('thumb/purged-during-put.jpg')
  })

  it('a stored thumb is stale once what the canvas supplies its frame changes, with no frame written', async () => {
    mocks.renderFrame.mockResolvedValue(Buffer.from('rendered'))
    mocks.getObject.mockResolvedValue(Buffer.from('rendered'))
    const f = { ...frame('restyled-frame'), canvasId: 'restyled' }
    await thumbs.create(f)
    /* past the revalidation throttle */
    const later = Date.now() + 60_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await thumbs.getStored(f)
    await tick()
    /* a token the frame does not name changes nothing for it */
    bumpStyle('restyled', tokenDependency('--brand'))
    await thumbs.getStored(f)
    await tick()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
    bumpStyle('restyled', tokenDependency('--ink'))
    await thumbs.getStored(f)
    await tick()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })

  it('getStored serves stored bytes and refreshes stale ones in the background, deduped', async () => {
    deferredRenders()
    mocks.getObject.mockResolvedValue(Buffer.from('stale'))
    const f = frame('stale-frame')
    const [a, b] = await Promise.all([thumbs.getStored(f), thumbs.getStored(f)])
    expect(a?.toString()).toBe('stale')
    expect(b?.toString()).toBe('stale')
    await tick()
    /* one background refresh, not one per request (dedupe + throttle) */
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
  })
})
