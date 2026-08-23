import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({
  createFrame: vi.fn(),
  deleteFrame: vi.fn(),
  updateFrame: vi.fn(),
  select: vi.fn(),
  patchFrameLocal: vi.fn(),
  capture: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  api: {
    createFrame: mocks.createFrame,
    deleteFrame: mocks.deleteFrame,
    updateFrame: mocks.updateFrame,
  },
}))
vi.mock('../src/lib/store', () => ({
  useStore: { getState: () => ({ select: mocks.select, patchFrameLocal: mocks.patchFrameLocal }) },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))

import { clearHistory, deleteFrameTracked, undo } from '../src/lib/history'

const frame: Frame = {
  id: 'frame-1',
  canvasId: 'canvas-1',
  name: 'Pricing',
  x: 10,
  y: 20,
  width: 640,
  height: 480,
  html: '<h1>Pricing</h1>',
  createdAt: 1,
  updatedAt: 1,
  updatedBy: 'Kai',
}

describe('tracked frame deletion', () => {
  beforeEach(() => {
    clearHistory()
    vi.clearAllMocks()
  })

  it('restores a successfully deleted frame on undo', async () => {
    mocks.deleteFrame.mockResolvedValue({ ok: true })
    mocks.createFrame.mockResolvedValue({ ...frame, id: 'frame-2' })

    await deleteFrameTracked(frame)
    await undo()

    expect(mocks.createFrame).toHaveBeenCalledWith('canvas-1', {
      name: 'Pricing',
      x: 10,
      y: 20,
      width: 640,
      height: 480,
      html: '<h1>Pricing</h1>',
    })
    expect(mocks.select).toHaveBeenCalledWith('frame-2')
  })

  it('does not create an undo entry when deletion fails', async () => {
    const error = new Error('offline')
    mocks.deleteFrame.mockRejectedValue(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await deleteFrameTracked(frame)
    await undo()

    expect(mocks.createFrame).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith('delete failed', error)
    consoleError.mockRestore()
  })
})
