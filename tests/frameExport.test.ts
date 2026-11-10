// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import {
  copyElementPng,
  copyFramePng,
  downloadElementExport,
  downloadFrameExport,
  downloadFramesPdf,
} from '../src/lib/frameExport'
import { cropRaster, frameSvg, rasterizeFrame } from '../src/lib/frameRaster'
import { inspectElement } from '../src/lib/frameBridge'
import { useStore } from '../src/lib/store'

/* the browser's own render comes first; these tests are about the server
   fallback unless they make it succeed */
vi.mock('../src/lib/frameRaster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/frameRaster')>()),
  rasterizeFrame: vi.fn(async () => Promise.reject(new Error('no'))),
  cropRaster: vi.fn(async () => new Blob(['cropped'], { type: 'image/png' })),
  frameSvg: vi.fn(async () => new Blob(['<svg/>'], { type: 'image/svg+xml' })),
}))
/* an element is measured by the live document; an unmounted frame answers null */
vi.mock('../src/lib/frameBridge', () => ({ inspectElement: vi.fn(async () => null) }))

const frame: Frame = {
  id: 'export-frame',
  canvasId: 'canvas',
  name: 'Poster',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html: '',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'me',
}
let clicked: HTMLAnchorElement[]

beforeEach(() => {
  clicked = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this)
  })
  URL.createObjectURL = vi.fn(() => 'blob:export')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.mocked(rasterizeFrame).mockImplementation(async () => Promise.reject(new Error('no')))
  vi.mocked(inspectElement).mockImplementation(async () => null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (globalThis as { __DOOP_DESKTOP__?: string }).__DOOP_DESKTOP__
  useStore.setState({ notice: null })
})

it('shows a busy toast while rendering, then saves through a download link named by the server', async () => {
  let respond!: (res: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (respond = resolve))),
  )

  const done = downloadFrameExport(frame, 'jpg')
  expect(useStore.getState().notice).toMatchObject({ text: 'Exporting JPG…', busy: true })
  /* the browser's own render is tried first; the server request follows it */
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/i/export-frame.jpg?scale=2&download', expect.anything()))

  respond(new Response('jpg-bytes', { headers: { 'Content-Disposition': 'attachment; filename="Poster.jpg"' } }))
  await done

  expect(clicked).toHaveLength(1)
  expect(clicked[0]!.download).toBe('Poster.jpg')
  expect(clicked[0]!.href).toBe('blob:export')
  expect(useStore.getState().notice).toMatchObject({ text: '“Poster.jpg” is ready', busy: false })
})

it('reports the server error instead of saving a failed render', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'JPG export rate limit — wait a minute' }, { status: 429 })),
  )

  await downloadFrameExport(frame, 'jpg')

  expect(clicked).toHaveLength(0)
  expect(useStore.getState().notice?.text).toBe('JPG export rate limit — wait a minute')
})

it('requests PNG and JPG at 2x', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('img')),
  )
  await downloadFrameExport(frame, 'png')
  await downloadFrameExport(frame, 'jpg')
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    '/i/export-frame.png?scale=2&download',
    '/i/export-frame.jpg?scale=2&download',
  ])
  expect(clicked.map((a) => a.download)).toEqual(['Poster@2x.png', 'Poster@2x.jpg'])
})

it("saves the browser's own render without asking the server", async () => {
  vi.mocked(rasterizeFrame).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  vi.stubGlobal('fetch', vi.fn())

  await downloadFrameExport({ ...frame, name: 'Poster: v2/final' }, 'png')

  expect(rasterizeFrame).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'export-frame' }),
    expect.objectContaining({ scale: 2, type: 'png' }),
  )
  expect(fetch).not.toHaveBeenCalled()
  expect(clicked.map((a) => a.download)).toEqual(['Poster v2final@2x.png'])
  expect(useStore.getState().notice).toMatchObject({ text: '“Poster v2final@2x.png” is ready', busy: false })
})

it("copies the browser's own render", async () => {
  vi.mocked(rasterizeFrame).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  vi.stubGlobal('fetch', vi.fn())
  const write = vi.fn(async (items: ClipboardItem[]) => {
    await items[0]!.getType('image/png')
  })
  vi.stubGlobal('navigator', { clipboard: { write } })
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(private readonly items: Record<string, Promise<Blob>>) {}
      getType(type: string) {
        return this.items[type]
      }
    },
  )

  await copyFramePng(frame)

  expect(rasterizeFrame).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'png' }))
  expect(fetch).not.toHaveBeenCalled()
  expect(useStore.getState().notice).toMatchObject({ text: 'PNG copied', busy: false })
})

it('keeps the spinner up while another export is still rendering', async () => {
  const pending: ((res: Response) => void)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
  )

  const png = downloadFrameExport(frame, 'png')
  const jpg = downloadFrameExport(frame, 'jpg')
  await vi.waitFor(() => expect(pending).toHaveLength(2))
  pending[0]!(new Response('img', { headers: { 'Content-Disposition': 'attachment; filename="Poster.png"' } }))
  await png
  expect(useStore.getState().notice).toMatchObject({
    text: '“Poster.png” is ready · Exporting 1 more…',
    busy: true,
  })

  pending[1]!(new Response('jpg', { headers: { 'Content-Disposition': 'attachment; filename="Poster.jpg"' } }))
  await jpg
  expect(useStore.getState().notice).toMatchObject({ text: '“Poster.jpg” is ready', busy: false })
})

it('in the desktop shell leaves the outcome to the save panel, which may be cancelled', async () => {
  ;(globalThis as { __DOOP_DESKTOP__?: string }).__DOOP_DESKTOP__ = '0.4.0'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('img')),
  )

  await downloadFrameExport(frame, 'png')

  expect(clicked).toHaveLength(1)
  expect(useStore.getState().notice).toBeNull()
})

it('binds several frames into one PDF request and saves the file the server names', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('%PDF-1.7', {
          headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Deck.pdf"' },
        }),
    ),
  )

  await downloadFramesPdf('canvas', [frame, { ...frame, id: 'second' }])

  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/canvases/canvas/export.pdf?frames=export-frame,second',
    expect.anything(),
  )
  expect(clicked[0]!.download).toBe('Deck.pdf')
  expect(useStore.getState().notice).toMatchObject({ text: '“Deck.pdf” is ready', busy: false })
})

it('shows why a PDF could not be made, such as a server without a browser', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'PDF export is unavailable' }, { status: 503 })),
  )

  await downloadFramesPdf('canvas', [frame])

  expect(clicked).toHaveLength(0)
  expect(useStore.getState().notice?.text).toBe('PDF export is unavailable')
})

it('gives a PDF of many frames longer than a single frame to render', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('%PDF-1.7', { headers: { 'Content-Type': 'application/pdf' } })),
  )

  await downloadFramesPdf('canvas', [frame])
  const many = Array.from({ length: 40 }, (_, index) => ({ ...frame, id: `frame-${index}` }))
  await downloadFramesPdf('canvas', many)

  /* one frame keeps the two-minute floor; forty print three at a time, a minute per wave */
  expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([2 * 60_000, 14 * 60_000])
})

/* A clipboard that resolves each item's pending data the way browsers do. */
function stubClipboard() {
  const written: Blob[] = []
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    },
  )
  const write = vi.fn(async (items: { items: Record<string, Promise<Blob>> }[]) => {
    written.push(await items[0]!.items['image/png']!)
  })
  vi.stubGlobal('navigator', { clipboard: { write } })
  return { written, write }
}

it('copies the PNG, handing the clipboard the pending render so the click still counts', async () => {
  let respond!: (res: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (respond = resolve))),
  )
  const { written, write } = stubClipboard()

  const done = copyFramePng(frame)
  expect(write).toHaveBeenCalledTimes(1)
  expect(useStore.getState().notice).toMatchObject({ text: 'Copying PNG…', busy: true })
  /* the clipboard already holds the pending blob; behind it the browser's
     own render is tried first, then the server */
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/i/export-frame.png?scale=2&download', expect.anything()))

  respond(new Response('png-bytes'))
  await done

  expect(await written[0]!.text()).toBe('png-bytes')
  expect(clicked).toHaveLength(0)
  expect(useStore.getState().notice).toMatchObject({ text: 'PNG copied', busy: false })
})

it('reports the server error when the PNG to copy fails to render', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'render rate limit — cached URLs are unaffected' }, { status: 429 })),
  )
  const { written } = stubClipboard()

  await copyFramePng(frame)

  expect(written).toHaveLength(0)
  expect(useStore.getState().notice?.text).toBe('render rate limit — cached URLs are unaffected')
})

it('says so without rendering when the browser has no async clipboard', async () => {
  vi.stubGlobal('fetch', vi.fn())
  vi.stubGlobal('navigator', {})

  await copyFramePng(frame)

  expect(fetch).not.toHaveBeenCalled()
  expect(useStore.getState().notice?.text).toBe('This browser can’t copy images')
})

it('leaves no unhandled rejection when the clipboard refuses before reading the render', async () => {
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'render failed' }, { status: 500 })),
  )
  stubClipboard().write.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))

  await copyFramePng(frame)
  await new Promise((resolve) => setTimeout(resolve, 0))

  process.off('unhandledRejection', unhandled)
  expect(unhandled).not.toHaveBeenCalled()
  expect(useStore.getState().notice?.text).toBe('Couldn’t copy the PNG')
})

const hero = { selector: 'body > div:nth-of-type(1)', name: 'div.hero' }
const measured = (rect: { x: number; y: number; width: number; height: number }) =>
  vi.mocked(inspectElement).mockResolvedValue({ rect } as Awaited<ReturnType<typeof inspectElement>>)

it('exports one element as the whole render clipped to its measured box', async () => {
  measured({ x: 10.5, y: 20, width: 40, height: 30.2 })
  vi.mocked(rasterizeFrame).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  vi.stubGlobal('fetch', vi.fn())

  await downloadElementExport(frame, hero, 'png')

  expect(inspectElement).toHaveBeenCalledWith('export-frame', hero.selector)
  expect(rasterizeFrame).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'export-frame' }),
    expect.objectContaining({ scale: 2, type: 'png', clip: { x: 10, y: 20, width: 41, height: 31 } }),
  )
  expect(fetch).not.toHaveBeenCalled()
  expect(clicked.map((a) => a.download)).toEqual(['Poster - divhero@2x.png'])
})

it("crops the server's render of the frame when the browser cannot draw it", async () => {
  measured({ x: 0, y: 0, width: 50, height: 50 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('whole-frame', { headers: { 'content-type': 'image/jpeg' } })),
  )

  await downloadElementExport(frame, hero, 'jpg')

  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/i/export-frame.jpg?scale=2&download'])
  expect(cropRaster).toHaveBeenCalledWith(
    expect.any(Blob),
    { x: 0, y: 0, width: 50, height: 50 },
    expect.objectContaining({ scale: 2, type: 'jpeg' }),
  )
  expect(clicked.map((a) => a.download)).toEqual(['Poster - divhero@2x.jpg'])
})

it('says when the element cannot be measured instead of exporting the frame', async () => {
  vi.stubGlobal('fetch', vi.fn())

  await downloadElementExport(frame, hero, 'png')

  expect(rasterizeFrame).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(clicked).toHaveLength(0)
  expect(useStore.getState().notice?.text).toMatch(/Couldn’t find the element/)
})

it('copies one element as a PNG, measured after the clipboard write has started', async () => {
  measured({ x: 5, y: 5, width: 10, height: 10 })
  vi.mocked(rasterizeFrame).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  vi.stubGlobal('fetch', vi.fn())
  const write = vi.fn(async (items: ClipboardItem[]) => {
    await items[0]!.getType('image/png')
  })
  vi.stubGlobal('navigator', { clipboard: { write } })
  vi.stubGlobal(
    'ClipboardItem',
    class {
      constructor(private readonly items: Record<string, Promise<Blob>>) {}
      getType(type: string) {
        return this.items[type]
      }
    },
  )

  await copyElementPng(frame, hero)

  expect(rasterizeFrame).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ type: 'png', clip: { x: 5, y: 5, width: 10, height: 10 } }),
  )
  expect(useStore.getState().notice).toMatchObject({ text: 'PNG copied', busy: false })
})

it('renders at the picked scale and names the file by it', async () => {
  vi.mocked(rasterizeFrame).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  vi.stubGlobal('fetch', vi.fn())

  await downloadFrameExport(frame, 'png', 3)
  await downloadFrameExport(frame, 'jpg', 1)
  await downloadFrameExport(frame, 'png', 0.5)

  expect(vi.mocked(rasterizeFrame).mock.calls.map(([, opts]) => opts.scale)).toEqual([3, 1, 0.5])
  expect(clicked.map((a) => a.download)).toEqual(['Poster@3x.png', 'Poster.jpg', 'Poster@0.5x.png'])
})

it('asks the server for the picked scale when the browser cannot draw the frame', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('img')),
  )
  await downloadFrameExport(frame, 'png', 4)
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/i/export-frame.png?scale=4&download'])
})

it('brings a scale the frame is too big for down to the largest it allows, and says so', async () => {
  vi.mocked(rasterizeFrame).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  vi.stubGlobal('fetch', vi.fn())

  await downloadFrameExport({ ...frame, width: 1440, height: 6000 }, 'png', 4)

  const scale = vi.mocked(rasterizeFrame).mock.calls[0]![1].scale
  expect(scale).toBeGreaterThan(2)
  expect(scale).toBeLessThan(4)
  expect(clicked.map((a) => a.download)).toEqual([`Poster@${scale}x.png`])
  expect(useStore.getState().notice?.text).toBe(
    `“Poster@${scale}x.png” is ready · exported at ${scale}x, the largest this frame allows`,
  )
})

it('copies the PNG at the picked scale', async () => {
  vi.mocked(rasterizeFrame).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
  const { written } = stubClipboard()

  await copyFramePng(frame, 3)

  expect(rasterizeFrame).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'export-frame' }),
    expect.objectContaining({ scale: 3, type: 'png' }),
  )
  expect(written).toHaveLength(1)
  expect(useStore.getState().notice?.text).toBe('PNG copied')
})

it('saves an SVG drawn here, with no scale in its name and no server fallback', async () => {
  vi.stubGlobal('fetch', vi.fn())

  await downloadFrameExport(frame, 'svg', 3)

  expect(frameSvg).toHaveBeenCalledWith(expect.objectContaining({ id: 'export-frame' }), expect.anything())
  expect(rasterizeFrame).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(clicked.map((a) => a.download)).toEqual(['Poster.svg'])
})

it('crops an element SVG to its measured box', async () => {
  measured({ x: 10.5, y: 20, width: 40, height: 30.2 })
  vi.stubGlobal('fetch', vi.fn())

  await downloadElementExport(frame, hero, 'svg')

  expect(frameSvg).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'export-frame' }),
    expect.objectContaining({ clip: { x: 10, y: 20, width: 41, height: 31 } }),
  )
  expect(clicked.map((a) => a.download)).toEqual(['Poster - divhero.svg'])
})

it('says why an SVG could not be made instead of asking the server', async () => {
  vi.mocked(frameSvg).mockRejectedValueOnce(new Error('404 fetching https://elsewhere/pic.png'))
  vi.stubGlobal('fetch', vi.fn())

  await downloadFrameExport(frame, 'svg')

  expect(fetch).not.toHaveBeenCalled()
  expect(clicked).toEqual([])
  expect(useStore.getState().notice?.text).toBe(
    'Couldn’t export the SVG — an image or embed in this frame can’t be read here. Try PNG.',
  )
})
