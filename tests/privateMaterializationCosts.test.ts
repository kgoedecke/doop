import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../server/auth.ts', async (original) => ({
  ...(await original<typeof import('../server/auth.ts')>()),
  isBanned: async () => false,
}))
vi.mock('../server/db/persist.ts', async (original) => ({
  ...(await original<typeof import('../server/db/persist.ts')>()),
  saveFrame: vi.fn(),
}))
import * as assets from '../server/assets.ts'
import { materializePrivateResources } from '../server/privateMaterialization.ts'
import { frameReadScope } from '../server/privateResources.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import { PRIVATE_MEDIA_LIMITS, PrivateMediaBudget, privateMediaAllowance } from '../shared/privateMedia.ts'

afterEach(() => vi.restoreAllMocks())

it('one resource reuses its encoded/decoded charge while repeated references and expansion still count', () => {
  const budget = new PrivateMediaBudget()
  const costs = {
    resources: [{ key: 'private:canvas:file.png', mime: 'image/png', encodedBytes: 7, decodedBytes: 8 }],
    references: 1,
    parserWork: 2,
    expandedBytes: 32,
  }
  budget.merge(costs)
  budget.merge(costs)
  expect(budget.usage).toEqual({ encodedBytes: 7, decodedBytes: 8, references: 2, parserWork: 4, expandedBytes: 64 })
  budget.reference(62)
  expect(() => budget.reference()).toThrow()
})

it('distinct identities cannot each spend a separate decoded budget', () => {
  const budget = new PrivateMediaBudget(0, { decodedBytes: 12 })
  budget.reserveDecoded('private:a:first.png', 8)
  expect(() => budget.reserveDecoded('private:a:second.png', 8)).toThrow()
  expect(() => budget.reserveDecoded('private:a:first.png', 9)).toThrow()
})

it('remaining allowances accept zero and reject forged, fractional or raised values', () => {
  expect(privateMediaAllowance({ decodedBytes: 0 }).decodedBytes).toBe(0)
  for (const invalid of [
    null,
    [],
    { costs: [] },
    { encodedBytes: PRIVATE_MEDIA_LIMITS.encodedBytes + 1 },
    { references: -1 },
    { references: 0.5 },
    { parserWork: null },
    { expandedBytes: Infinity },
    { decodedBytes: NaN },
  ])
    expect(() => privateMediaAllowance(invalid)).toThrow()
})

it('the actual materializer rejects a lower encoded allowance before starting private storage IO', async () => {
  const frame = {
    id: 'cost-frame',
    canvasId: 'cost-canvas',
    name: 'Cost',
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    html: '<p>Cost</p>',
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'cost-owner',
  } as Frame
  store.init([
    { id: frame.canvasId, name: 'Cost', ownerId: 'cost-owner', frames: [frame], createdAt: 0, updatedAt: 0 } as Canvas,
  ])
  vi.spyOn(assets, 'assetMetadata').mockReturnValue({
    id: 'cost-image',
    canvasId: frame.canvasId,
    ext: 'png',
    mime: 'image/png',
    size: 128,
  } as NonNullable<ReturnType<typeof assets.assetMetadata>>)
  const reads = vi.spyOn(assets, 'getAsset')
  const scope = frameReadScope({ actorId: 'cost-owner', currentActor: async () => 'cost-owner' }, frame)
  await expect(
    materializePrivateResources('<img src="/a/cost-image.png">', scope, { limits: { encodedBytes: 127 } }),
  ).rejects.toMatchObject({ kind: 'limit' })
  expect(reads).not.toHaveBeenCalled()
})
