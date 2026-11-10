import { afterEach, expect, it, vi } from 'vitest'

// Actual store/content-key/preview/thumbnail/current canvas policy; renderer,
// account-ban lookup and object storage are explicit controlled stand-ins.
const mocks = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  render: vi.fn(async (frame: { html: string }) => Buffer.from(frame.html)),
}))
vi.mock('../server/screenshot.ts', () => ({ renderFrame: mocks.render }))
vi.mock('../server/auth.ts', () => ({ isBanned: async () => false }))
vi.mock('../server/storage.ts', () => ({
  putObject: async (key: string, bytes: Buffer) => {
    mocks.objects.set(key, bytes)
  },
  getObject: async (key: string) => mocks.objects.get(key) ?? null,
  deleteObject: async (key: string) => {
    mocks.objects.delete(key)
  },
}))
import { store } from '../server/store.ts'
import { getImage } from '../server/previews.ts'
import * as thumbs from '../server/thumbs.ts'

afterEach(() => vi.restoreAllMocks())

for (const stored of [false, true]) {
  it(`keeps snapshot A through ${stored ? 'stored' : 'new'} thumbnail lookup and cache reuse after an edit to B`, async () => {
    mocks.objects.clear()
    mocks.render.mockClear()
    const live = {
      id: `snapshot-${stored}`,
      canvasId: `snapshot-canvas-${stored}`,
      pageId: 'p',
      name: 'Snapshot',
      x: 0,
      y: 0,
      width: 320,
      height: 240,
      html: '<p>A</p>',
      createdAt: 1,
      updatedAt: 1,
      updatedBy: 'owner',
    }
    store.init([
      {
        id: live.canvasId,
        name: 'Private',
        ownerId: 'owner',
        createdAt: 1,
        updatedAt: 1,
        pages: [{ id: 'p', name: 'Page' }],
        frames: [live],
      },
    ])
    const scope = {
      kind: 'frame' as const,
      canvasId: live.canvasId,
      frameId: live.id,
      reader: { actorId: 'owner', currentActor: async () => 'owner' },
    }
    const load = store.renderSource.bind(store)
    if (stored) {
      live.html = '<p>B</p>'
      await thumbs.create(await load(live), scope)
      live.html = '<p>A</p>'
    }
    let reads = 0
    vi.spyOn(store, 'renderSource').mockImplementation(async (input) => {
      const snapshot = await load(input)
      if (++reads === 1) live.html = '<p>B</p>'
      return snapshot
    })
    const request = { ext: 'jpg' as const, scale: 1, quality: 90, preview: true, scope }
    expect((await getImage(live, request)).buf.toString()).toBe('<p>A</p>')
    live.html = '<p>A</p>'
    expect((await getImage(live, request)).buf.toString()).toBe('<p>A</p>')
    expect(reads).toBe(2)
    expect(mocks.render).toHaveBeenCalledTimes(stored ? 2 : 1)
  })
}
