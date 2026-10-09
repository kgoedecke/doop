import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({ loadLegacyFrameIds: async () => [] }))
import { store } from '../server/store.ts'
import { canvasIndex, frameActor } from '../server/frame-sync.ts'
import { pageFrames } from '../shared/pages.ts'

it('persists missing and orphaned page membership when reopening an actor-backed canvas', async () => {
  const canvasId = randomUUID()
  const frame = (id: string, pageId?: string): Frame => ({
    id: `${canvasId}.${id}`,
    canvasId,
    name: id,
    pageId,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    html: '',
    createdAt: 1,
    updatedAt: 1,
    updatedBy: 'test',
  })
  const canvas: Canvas = {
    id: canvasId,
    name: 'Reopened',
    ownerId: 'alice',
    createdAt: 1,
    updatedAt: 1,
    pages: [
      { id: 'first', name: 'Page 1' },
      { id: 'second', name: 'Page 2' },
    ],
    frames: [],
  }
  const frames = [frame('kept', 'second'), frame('orphan', 'deleted-page'), frame('legacy')]
  for (const entry of frames) await frameActor(entry.id).initialize(entry)
  await canvasIndex(canvasId).initialize(frames.map((entry) => entry.id))
  store.init([canvas])

  const reopened = (await store.syncCanvas(canvasId))!
  expect(pageFrames(reopened, 'first').map((entry) => entry.name)).toEqual(['orphan', 'legacy'])
  expect(pageFrames(reopened, 'second').map((entry) => entry.name)).toEqual(['kept'])
  for (const entry of frames.slice(1)) expect((await frameActor(entry.id).snapshot()).frame?.pageId).toBe('first')
})
