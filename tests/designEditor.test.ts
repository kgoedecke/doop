import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const mock = vi.hoisted(() => ({ updateFrame: vi.fn(), getCanvas: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: mock,
  ApiError: class extends Error {
    body: Record<string, unknown>
    constructor(
      public status: number,
      text: string,
    ) {
      super(text)
      this.body = JSON.parse(text)
    }
  },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
const { useStore } = await import('../src/lib/store')
const { useDesignEditor, saveDesignPatch, commitDesignEdit } = await import('../src/lib/designEditor')
const { clearHistory, undo } = await import('../src/lib/history')
const { ApiError } = await import('../src/lib/api')
const frame = { id: 'f', canvasId: 'c', name: 'Test', html: 'before', width: 800, height: 600, x: 0, y: 0 } as Frame

beforeEach(() => {
  vi.clearAllMocks()
  mock.updateFrame.mockResolvedValue({})
  mock.getCanvas.mockResolvedValue({ id: 'c', frames: [{ ...frame }] })
  useStore.getState().setCanvas({ id: 'c', frames: [{ ...frame }] } as Canvas)
  useDesignEditor.setState({ error: null, saved: false, inlineFrameId: null, unsavedHtml: {} })
  clearHistory()
})

describe('inspector save transactions', () => {
  it('refuses a layer mutation while the same frame has an unfinished inline edit', async () => {
    useDesignEditor.setState({ inlineFrameId: 'f' })
    await commitDesignEdit('f', '#layer', { type: 'visibility' })
    expect(mock.updateFrame).not.toHaveBeenCalled()
    expect(useStore.getState().canvas!.frames[0].html).toBe('before')
    expect(useDesignEditor.getState().error).toContain('Finish text editing')
  })

  it('serializes rapid edits with the correct source preconditions and undo boundaries', async () => {
    let finish!: () => void
    mock.updateFrame.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const first = saveDesignPatch('f', { html: 'first' })
    const second = saveDesignPatch('f', { html: 'second' })
    await Promise.resolve()
    expect(mock.updateFrame).toHaveBeenCalledTimes(1)
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'first' }, 'before')
    expect(useDesignEditor.getState().busy).toBe(true)
    finish()
    await Promise.all([first, second])
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'second' }, 'first')
    expect(useDesignEditor.getState().busy).toBe(false)
    await undo()
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'first' }, 'second')
  })

  it('rolls back failed writes and does not create undo entries for them', async () => {
    mock.updateFrame.mockRejectedValueOnce(new Error('Connection lost'))
    await saveDesignPatch('f', { html: 'unsaved' })
    expect(useStore.getState().canvas!.frames[0].html).toBe('before')
    expect(useDesignEditor.getState().error).toBe('Connection lost')
    await undo()
    expect(mock.updateFrame).toHaveBeenCalledTimes(1)
  })

  it('saves a later queued edit against the confirmed source after an earlier failure', async () => {
    mock.updateFrame.mockRejectedValueOnce(new Error('Temporary failure'))
    const first = saveDesignPatch('f', { html: 'first' })
    const second = saveDesignPatch('f', { html: 'second' })
    await Promise.all([first, second])
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'second' }, 'before')
    expect(useStore.getState().canvas!.frames[0].html).toBe('second')
    expect(useDesignEditor.getState().error).toBeNull()
    expect(useDesignEditor.getState().unsavedHtml.f).toBeUndefined()
    await undo()
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'before' }, 'second')
    await undo()
    expect(mock.updateFrame).toHaveBeenCalledTimes(3)
  })

  it('rolls back to the confirmed source when every queued edit fails', async () => {
    mock.updateFrame.mockRejectedValue(new Error('Temporary failure'))
    await Promise.all([saveDesignPatch('f', { html: 'first' }), saveDesignPatch('f', { html: 'second' })])
    expect(mock.updateFrame).toHaveBeenNthCalledWith(2, 'f', { html: 'second' }, 'before')
    expect(useStore.getState().canvas!.frames[0].html).toBe('before')
    expect(useDesignEditor.getState().unsavedHtml.f).toBe('second')
    await undo()
    expect(mock.updateFrame).toHaveBeenCalledTimes(2)
  })

  it('stops dependent HTML writes after a remote conflict instead of overwriting the collaborator', async () => {
    mock.updateFrame.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: 'Source changed' })))
    mock.getCanvas.mockResolvedValue({ id: 'c', frames: [{ ...frame, html: 'remote' }] })
    await Promise.all([saveDesignPatch('f', { html: 'first' }), saveDesignPatch('f', { html: 'second' })])
    expect(mock.updateFrame).toHaveBeenCalledTimes(1)
    expect(useStore.getState().canvas!.frames[0].html).toBe('remote')
    expect(useDesignEditor.getState().unsavedHtml.f).toBe('second')
    await undo()
    expect(mock.updateFrame).toHaveBeenCalledTimes(1)
  })

  it('keeps the latest draft and cancels dependent writes when the server cannot be read', async () => {
    mock.updateFrame.mockRejectedValueOnce(new Error('Offline'))
    mock.getCanvas.mockRejectedValueOnce(new Error('Offline'))
    await Promise.all([saveDesignPatch('f', { html: 'first' }), saveDesignPatch('f', { html: 'second' })])
    expect(mock.updateFrame).toHaveBeenCalledTimes(1)
    expect(useStore.getState().canvas!.frames[0].html).toBe('before')
    expect(useDesignEditor.getState().unsavedHtml.f).toBe('second')
    expect(useDesignEditor.getState().busy).toBe(false)
  })

  it('confirms a committed write whose response was lost before saving its successor', async () => {
    mock.updateFrame.mockRejectedValueOnce(new Error('Response lost'))
    mock.getCanvas.mockResolvedValueOnce({ id: 'c', frames: [{ ...frame, html: 'first' }] })
    await Promise.all([saveDesignPatch('f', { html: 'first' }), saveDesignPatch('f', { html: 'second' })])
    expect(mock.updateFrame).toHaveBeenNthCalledWith(2, 'f', { html: 'second' }, 'first')
    expect(useDesignEditor.getState().error).toBeNull()
    await undo()
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'first' }, 'second')
    await undo()
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'before' }, 'first')
  })

  it('uses the last accepted edit as the baseline when a middle request fails', async () => {
    mock.updateFrame
      .mockResolvedValueOnce({ ...frame, html: 'first' })
      .mockRejectedValueOnce(new Error('Temporary failure'))
    mock.getCanvas.mockResolvedValueOnce({ id: 'c', frames: [{ ...frame, html: 'first' }] })
    await Promise.all([
      saveDesignPatch('f', { html: 'first' }),
      saveDesignPatch('f', { html: 'second' }),
      saveDesignPatch('f', { html: 'third' }),
    ])
    expect(mock.updateFrame).toHaveBeenNthCalledWith(3, 'f', { html: 'third' }, 'first')
    await undo()
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'first' }, 'third')
    await undo()
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'before' }, 'first')
  })

  it('keeps confirmed baselines independent when edits to two frames are interleaved', async () => {
    const other = { ...frame, id: 'g', html: 'other before' }
    useStore.getState().setCanvas({ id: 'c', frames: [{ ...frame }, other] } as Canvas)
    mock.updateFrame.mockRejectedValueOnce(new Error('Temporary failure'))
    mock.getCanvas.mockResolvedValueOnce({ id: 'c', frames: [{ ...frame }, other] })
    await Promise.all([
      saveDesignPatch('f', { html: 'first' }),
      saveDesignPatch('g', { html: 'other after' }),
      saveDesignPatch('f', { html: 'second' }),
    ])
    expect(mock.updateFrame).toHaveBeenNthCalledWith(2, 'g', { html: 'other after' }, 'other before')
    expect(mock.updateFrame).toHaveBeenNthCalledWith(3, 'f', { html: 'second' }, 'before')
  })

  it('preserves a newer WebSocket update arriving while the failed save refreshes', async () => {
    let refreshed!: (canvas: Canvas) => void
    mock.updateFrame.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: 'Source changed' })))
    mock.getCanvas.mockImplementationOnce(
      () =>
        new Promise<Canvas>((resolve) => {
          refreshed = resolve
        }),
    )
    const first = saveDesignPatch('f', { html: 'first' })
    const second = saveDesignPatch('f', { html: 'second' })
    await vi.waitFor(() => expect(mock.getCanvas).toHaveBeenCalled())
    useStore.getState().patchFrameLocal('f', { html: 'newer remote' })
    refreshed({ id: 'c', frames: [{ ...frame, html: 'older remote' }] } as Canvas)
    await Promise.all([first, second])
    expect(mock.updateFrame).toHaveBeenCalledTimes(1)
    expect(useStore.getState().canvas!.frames[0].html).toBe('newer remote')
    expect(useDesignEditor.getState().unsavedHtml.f).toBe('second')
  })

  it('starts a new batch from the refreshed source after a conflict', async () => {
    mock.updateFrame.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: 'Source changed' })))
    mock.getCanvas.mockResolvedValueOnce({ id: 'c', frames: [{ ...frame, html: 'remote' }] })
    await saveDesignPatch('f', { html: 'rejected' })
    await saveDesignPatch('f', { html: 'reviewed edit' })
    expect(mock.updateFrame).toHaveBeenLastCalledWith('f', { html: 'reviewed edit' }, 'remote')
    expect(useDesignEditor.getState().error).toBeNull()
    expect(useDesignEditor.getState().unsavedHtml.f).toBe('rejected')
  })

  it('does not roll back a newer remote value when the original request fails', async () => {
    let reject!: (error: Error) => void
    mock.updateFrame.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        }),
    )
    const save = saveDesignPatch('f', { html: 'local' })
    await Promise.resolve()
    useStore.getState().patchFrameLocal('f', { html: 'remote' })
    reject(new Error('Connection lost'))
    await save
    expect(useStore.getState().canvas!.frames[0].html).toBe('remote')
  })

  it('refreshes the server source after a conflict and reports the rejected edit', async () => {
    mock.updateFrame.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: 'Source changed' })))
    mock.getCanvas.mockResolvedValue({ id: 'c', frames: [{ ...frame, html: 'remote' }] })
    await saveDesignPatch('f', { html: 'stale' })
    expect(useStore.getState().canvas!.frames[0].html).toBe('remote')
    expect(useDesignEditor.getState().error).toBe('Source changed')
  })

  it('does not add an old canvas save to the new canvas undo history', async () => {
    let finish!: () => void
    mock.updateFrame.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const save = saveDesignPatch('f', { html: 'updated' })
    await Promise.resolve()
    useStore.getState().setCanvas({ id: 'another', frames: [] } as unknown as Canvas)
    clearHistory()
    finish()
    await save
    await undo()
    expect(mock.updateFrame).toHaveBeenCalledTimes(1)
  })
})
