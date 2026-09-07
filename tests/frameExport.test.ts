import { afterEach, describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
import type { Frame } from '../shared/types'
import { exportFileNames, exportSelectionBounds, exportSizeError, parseExportScale } from '../shared/frameExport'
import { prepareFrameExport } from '../src/lib/frameExport'

const frame = (id: string, over: Partial<Frame> = {}) =>
  ({ id, name: 'Frame', x: 0, y: 0, width: 200, height: 100, ...over }) as Frame
const options = { format: 'png' as const, scale: 2 as const, quality: 90 }
const imageResponse = (body = 'image') => new Response(body, { headers: { 'Content-Type': 'image/png' } })
afterEach(() => vi.unstubAllGlobals())

describe('export geometry and naming', () => {
  it('supports the offered scales and falls back for invalid URL parameters', () => {
    for (const scale of [0.5, 1, 2, 3, 4]) expect(parseExportScale(String(scale))).toBe(scale)
    for (const value of [undefined, 'NaN', 'Infinity', '-1', '100', ['2', '4']]) expect(parseExportScale(value)).toBe(1)
  })
  it('preserves negative positions, gaps and overlapping bounds', () => {
    expect(exportSelectionBounds([frame('a', { x: -100, y: -50 }), frame('b', { x: 200, y: 20 })])).toEqual({
      x: -100,
      y: -50,
      width: 500,
      height: 170,
    })
    expect(exportSizeError({ width: 10000, height: 10000 }, 1)).toBeTruthy()
    expect(exportSizeError({ width: 10000, height: 10000 }, 0.5)).toBeNull()
    expect(exportSizeError({ width: 40000, height: 100 }, 1)).toBeTruthy()
  })
  it('keeps duplicate and unsafe names as unique files without directory paths', () => {
    expect(
      exportFileNames(
        ['Frame', 'frame', 'Frame (2)', '../Hero/CTA', '...', '日本語'].map((name) => ({ name })),
        'png',
      ),
    ).toEqual(['Frame.png', 'frame (2).png', 'Frame (2) (2).png', '-Hero-CTA.png', 'frame (3).png', '日本語.png'])
  })
})

describe('export downloads', () => {
  it('returns a single image directly with scale and quality in the request', async () => {
    const fetcher = vi.fn().mockResolvedValue(imageResponse())
    vi.stubGlobal('fetch', fetcher)
    const result = await prepareFrameExport([frame('a')], options, new AbortController().signal)
    expect(result.name).toBe('Frame.png')
    expect(result.blob.type).toBe('image/png')
    expect(await result.blob.text()).toBe('image')
    expect(fetcher.mock.calls[0][0]).toBe('/i/a.png?scale=2&quality=90')
    expect(fetcher.mock.calls[0][1].cache).toBe('no-store')
  })
  it('puts every selected frame in a valid ZIP with unique names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(imageResponse('first')).mockResolvedValueOnce(imageResponse('second')),
    )
    const progress = vi.fn()
    const result = await prepareFrameExport([frame('a'), frame('b')], options, new AbortController().signal, progress)
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    expect(result.name).toBe('frames.zip')
    expect(Object.keys(files)).toEqual(['Frame.png', 'Frame (2).png'])
    expect(new TextDecoder().decode(files['Frame (2).png'])).toBe('second')
    expect(progress.mock.calls).toEqual([[1], [2]])
  })
  it('stops on failed frames and never returns a partial archive', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(new Response('', { status: 429 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(
      prepareFrameExport([frame('a'), frame('b'), frame('c')], options, new AbortController().signal),
    ).rejects.toThrow('Wait a minute')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects HTML responses and oversized selections before rendering', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(prepareFrameExport([frame('a')], options, new AbortController().signal)).rejects.toThrow(
      'did not return an image',
    )
    fetcher.mockClear()
    await expect(
      prepareFrameExport([frame('a', { width: 40000 })], options, new AbortController().signal),
    ).rejects.toThrow('too large')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('cancellation prevents further requests', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn().mockResolvedValue(imageResponse())
    vi.stubGlobal('fetch', fetcher)
    await expect(
      prepareFrameExport([frame('a'), frame('b')], options, controller.signal, () => controller.abort()),
    ).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('composites in canvas order, fills JPG gaps white, and releases raster memory', async () => {
    const drawImage = vi.fn()
    const fillRect = vi.fn()
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage, fillRect, fillStyle: '' }),
      toBlob: vi.fn((cb: (b: Blob) => void) => cb(new Blob(['combined'], { type: 'image/jpeg' }))),
    }
    const bitmap = { close: vi.fn() }
    vi.stubGlobal('document', { createElement: () => canvas })
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(imageResponse())),
    )
    const result = await prepareFrameExport(
      [frame('a', { x: -100 }), frame('b', { x: 200 })],
      { ...options, mode: 'combined', format: 'jpg' },
      new AbortController().signal,
    )
    expect(result.name).toBe('selection.jpg')
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1000, 200)
    expect(drawImage.mock.calls.map((args) => args.slice(1))).toEqual([
      [0, 0, 400, 200],
      [600, 0, 400, 200],
    ])
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.9)
    expect(bitmap.close).toHaveBeenCalledTimes(2)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
  })
})
