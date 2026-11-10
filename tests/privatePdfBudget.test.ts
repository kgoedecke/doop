import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'
const mocks = vi.hoisted(() => ({ loadFramePage: vi.fn(), pdf: vi.fn(), close: vi.fn() }))
vi.mock('../server/screenshot.ts', () => ({
  findBrowserPath: () => '/actual-browser-fixture-tested-separately',
  loadFramePage: mocks.loadFramePage,
}))
vi.mock('../server/auth.ts', async (original) => ({
  ...(await original<typeof import('../server/auth.ts')>()),
  isBanned: async () => false,
}))
vi.mock('../server/db/persist.ts', async (original) => ({
  ...(await original<typeof import('../server/db/persist.ts')>()),
  saveFrame: vi.fn(),
}))
import { store } from '../server/store.ts'
import { renderFramesPdf } from '../server/pdfExport.ts'
const reader = { actorId: 'pdf-budget-reader', currentActor: async () => 'pdf-budget-reader' }
const frames = Array.from(
  { length: 5 },
  (_, i) =>
    ({
      id: `pdf-budget-${i}`,
      canvasId: 'pdf-budget-canvas',
      name: 'Budget',
      html: '<p>budget</p>',
      width: 80,
      height: 60,
      x: 0,
      y: 0,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'test',
    }) as Frame,
)
beforeEach(() => {
  store.init([
    {
      id: 'pdf-budget-canvas',
      name: 'PDF budget',
      ownerId: reader.actorId,
      frames,
      createdAt: 0,
      updatedAt: 0,
    } as Canvas,
  ])
  mocks.close.mockReset().mockResolvedValue(undefined)
  mocks.pdf.mockReset()
  mocks.loadFramePage.mockReset().mockImplementation(async () => ({
    close: mocks.close,
    cancel: mocks.close,
    assertReady: vi.fn(),
    page: {
      setViewport: vi.fn(),
      emulateMediaType: vi.fn(),
      mainFrame: () => ({ childFrames: () => [], evaluate: async () => undefined }),
      pdf: mocks.pdf,
    },
  }))
})
afterEach(() => vi.restoreAllMocks())
it('rejects a page above15,000,000 bytes and drains all three already-started page contexts', async () => {
  mocks.pdf.mockResolvedValue(new Uint8Array(15_000_001))
  await expect(renderFramesPdf(frames, reader)).rejects.toThrow('output budget')
  expect(mocks.loadFramePage).toHaveBeenCalledTimes(3)
  expect(mocks.close).toHaveBeenCalledTimes(3)
})
it('aggregate page preparation above15,000,000 bytes stops new pages and closes every admitted context', async () => {
  mocks.pdf.mockResolvedValue(new Uint8Array(8_000_000))
  await expect(renderFramesPdf(frames, reader)).rejects.toThrow('output budget')
  expect(mocks.loadFramePage).toHaveBeenCalledTimes(3)
  // A completed page closes before its final live check; the owner close is idempotent.
  expect(mocks.close.mock.calls.length).toBeGreaterThanOrEqual(3)
  expect(mocks.pdf).toHaveBeenCalledTimes(3)
})
