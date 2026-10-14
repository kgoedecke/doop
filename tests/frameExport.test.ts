// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import { downloadFrameExport } from '../src/lib/frameExport'
import { useStore } from '../src/lib/store'

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
  expect(fetch).toHaveBeenCalledWith('/i/export-frame.jpg?scale=2&download', expect.anything())
  expect(useStore.getState().notice).toMatchObject({ text: 'Exporting JPG…', busy: true })

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
  expect(clicked.map((a) => a.download)).toEqual(['Poster.png', 'Poster.jpg'])
})

it('keeps the spinner up while another export is still rendering', async () => {
  const pending: ((res: Response) => void)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
  )

  const png = downloadFrameExport(frame, 'png')
  const jpg = downloadFrameExport(frame, 'jpg')
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
