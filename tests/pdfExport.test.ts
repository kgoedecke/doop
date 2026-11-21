import fs from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { readingOrder } from '../shared/frameOrder.ts'
import {
  mapLimited,
  pageSizeFor,
  pdfRendererAvailable,
  renderFramePdfPage,
  selectPdfFrames,
  takePdfExportSlot,
} from '../server/pdfExport.ts'
import { reloadEnv } from '../server/env.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import type { Canvas, Frame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * PDF export: page order, page sizing and the render pool as plain functions, then the
 * route against the REAL server (see ./harness.ts) — a vector page per
 * frame, sized to the frame, behind the canvas's own access gate.
 */

const PX_TO_PT = 72 / 96

function doc(text: string, background: string) {
  return `<!doctype html><html><body style="margin:0;background:${background};font:24px sans-serif"><h1>${text}</h1></body></html>`
}

describe('readingOrder', () => {
  it('reads rows top to bottom, each row left to right', () => {
    const frames = [
      { id: 'right', x: 900, y: 12, height: 400 },
      { id: 'below', x: 0, y: 700, height: 300 },
      { id: 'left', x: 0, y: 0, height: 400 },
      { id: 'mid', x: 450, y: 40, height: 300 },
    ]
    expect(readingOrder(frames).map((frame) => frame.id)).toEqual(['left', 'mid', 'right', 'below'])
  })

  it('starts a new row once a frame sits below the middle of the row lead', () => {
    const frames = [
      { id: 'a', x: 500, y: 0, height: 100 },
      { id: 'b', x: 0, y: 60, height: 100 },
    ]
    expect(readingOrder(frames).map((frame) => frame.id)).toEqual(['a', 'b'])
  })
})

describe('pageSizeFor', () => {
  it('prints a frame at its own size', () => {
    expect(pageSizeFor({ width: 800, height: 600 })).toEqual({ width: 800, height: 600, scale: 1 })
  })

  it('scales a frame beyond Chrome’s paper limit down to fit', () => {
    const size = pageSizeFor({ width: 1000, height: 38_400 })
    expect(size.scale).toBe(0.5)
    expect(size).toMatchObject({ width: 500, height: 19_200 })
  })
})

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

type Matrix = [number, number, number, number, number, number]

function concat([a, b, c, d, e, f]: Matrix, [ta, tb, tc, td, te, tf]: Matrix): Matrix {
  return [
    a * ta + b * tc,
    a * tb + b * td,
    c * ta + d * tc,
    c * tb + d * td,
    e * ta + f * tc + te,
    e * tb + f * td + tf,
  ]
}

function intersect(box: Box, clip: Box): Box | null {
  const left = Math.max(box.left, clip.left)
  const top = Math.max(box.top, clip.top)
  const right = Math.min(box.right, clip.right)
  const bottom = Math.min(box.bottom, clip.bottom)
  return left < right && top < bottom ? { left, top, right, bottom } : null
}

/**
 * The visible boxes a page fills with `color` (its `rg` operands), in CSS px
 * from the top left, after every clip: enough of the PDF operators (q/Q, cm,
 * re, W n, rg, f) to follow what Chrome writes for axis-aligned boxes.
 */
function visibleFills(pdf: PDFDocument, color: string): Box[] {
  const page = pdf.getPage(0)
  const pageHeight = page.getHeight()
  const contents = pdf.context.lookup(page.node.get(PDFName.of('Contents')))
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents]
  const operators = streams
    .flatMap((stream) =>
      stream instanceof PDFRawStream ? [new TextDecoder().decode(decodePDFRawStream(stream).decode())] : [],
    )
    .join('\n')
    .split(/\s+/)
  const pageBox: Box = { left: 0, top: 0, right: Infinity, bottom: Infinity }
  let state = { ctm: [1, 0, 0, 1, 0, 0] as Matrix, clip: pageBox, fill: '' }
  const saved: (typeof state)[] = []
  let operands: string[] = []
  let path: Box | null = null
  let clipping = false
  const fills: Box[] = []
  for (const token of operators) {
    if (/^[-+.\d]/.test(token)) {
      operands.push(token)
      continue
    }
    const n = operands.map(Number)
    if (token === 'q') saved.push({ ...state })
    else if (token === 'Q') state = saved.pop() ?? state
    else if (token === 'cm') state.ctm = concat(n as Matrix, state.ctm)
    else if (token === 'rg') state.fill = operands.join(' ')
    else if (token === 're') {
      const [x = 0, y = 0, w = 0, h = 0] = n
      const [a, b, c, d, e, f] = state.ctm
      const corners = [
        [x, y],
        [x + w, y + h],
      ].map(([px = 0, py = 0]) => [(a * px + c * py + e) / PX_TO_PT, (pageHeight - (b * px + d * py + f)) / PX_TO_PT])
      const xs = corners.map(([cx = 0]) => cx)
      const ys = corners.map(([, cy = 0]) => cy)
      path = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
    } else if (token === 'W' || token === 'W*') clipping = true
    else if (token === 'n') {
      if (clipping && path) state.clip = intersect(path, state.clip) ?? { left: 0, top: 0, right: 0, bottom: 0 }
      clipping = false
      path = null
    } else if (token === 'f' || token === 'f*') {
      const visible = path && state.fill === color ? intersect(path, state.clip) : null
      if (visible) fills.push(visible)
      path = null
    }
    operands = []
  }
  return fills
}

describe('pdfRendererAvailable', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    reloadEnv()
  })

  it('counts a remote browser on a server with no local Chrome', () => {
    vi.spyOn(fs, 'accessSync').mockImplementation(() => {
      throw new Error('ENOENT')
    })
    vi.stubEnv('REMOTE_BROWSER_URL', undefined)
    reloadEnv()
    expect(pdfRendererAvailable()).toBe(false)

    vi.stubEnv('REMOTE_BROWSER_URL', 'wss://browser.example/devtools/browser')
    reloadEnv()
    expect(pdfRendererAvailable()).toBe(true)
  })
})

describe('renderFramePdfPage', () => {
  it.skipIf(!findBrowserPath())(
    'keeps a block that straddles the frame’s bottom edge, with viewport units at the frame’s size',
    async () => {
      /* 60vh puts the red block across the 300px edge: printed bare, Chrome
         moved it whole onto a second sheet, which the export dropped */
      const html =
        '<!doctype html><html><body style="margin:0"><div style="height:60vh"></div>' +
        '<svg width="100" height="200" style="display:block"><rect width="100" height="200" fill="#ff0000"/></svg>' +
        '</body></html>'
      const frame: Frame = {
        id: 'edge',
        canvasId: 'c',
        name: 'Edge',
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        html,
        createdAt: 0,
        updatedAt: 0,
        updatedBy: 'me',
      }
      const pdf = await PDFDocument.load(await renderFramePdfPage(frame))
      expect(pdf.getPageCount()).toBe(1)
      expect(pdf.getPage(0).getHeight()).toBeCloseTo(300 * PX_TO_PT, 0)
      /* the block starts at 60vh of the frame and is cut at its bottom edge */
      const [red, ...others] = visibleFills(pdf, '1 0 0')
      expect(others).toEqual([])
      expect(red!.left).toBeCloseTo(0, 0)
      expect(red!.right).toBeCloseTo(100, 0)
      expect(red!.top).toBeCloseTo(180, 0)
      expect(red!.bottom).toBeCloseTo(300, 0)
    },
    60_000,
  )
})

describe('selectPdfFrames', () => {
  const at = (id: string, x: number, y: number): Frame => ({
    id,
    canvasId: 'c',
    name: id,
    x,
    y,
    width: 100,
    height: 100,
    html: '',
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'me',
  })
  const canvas: Canvas = {
    id: 'c',
    name: 'Deck',
    createdAt: 0,
    updatedAt: 0,
    frames: [at('c', 50, 60), at('b', 200, 30), at('a', 0, 0)],
  }
  const ids = (selection: ReturnType<typeof selectPdfFrames>) => (selection.ok ? selection.frames.map((f) => f.id) : [])

  it('keeps named frames in the order they were named', () => {
    expect(ids(selectPdfFrames(canvas, { frameIds: ['b', 'c'] }))).toEqual(['b', 'c'])
    expect(ids(selectPdfFrames(canvas, { frameIds: ['c', 'a', 'c'] }))).toEqual(['c', 'a'])
  })

  it('reads a whole page in reading order', () => {
    expect(ids(selectPdfFrames(canvas, {}))).toEqual(['a', 'b', 'c'])
  })
})

describe('mapLimited', () => {
  it('starts nothing new after a failure and settles the renders under way before rejecting', async () => {
    const started: number[] = []
    const settled: number[] = []
    const run = async (item: number) => {
      started.push(item)
      await new Promise((resolve) => setTimeout(resolve, item === 0 ? 1 : 20))
      settled.push(item)
      if (item === 0) throw new Error('render failed')
      return item
    }
    await expect(mapLimited([0, 1, 2, 3, 4, 5], 3, run)).rejects.toThrow('render failed')
    expect(started).toEqual([0, 1, 2])
    expect([...settled].sort((a, b) => a - b)).toEqual([0, 1, 2])
  })

  it('returns results in input order', async () => {
    const run = async (item: number) => {
      await new Promise((resolve) => setTimeout(resolve, 10 - item))
      return item * 2
    }
    expect(await mapLimited([1, 2, 3, 4], 2, run)).toEqual([2, 4, 6, 8])
  })
})

describe('takePdfExportSlot', () => {
  it('allows a handful of exports a minute per account', () => {
    const now = 1_000_000
    const granted = Array.from({ length: 8 }, () => takePdfExportSlot('budget-test', now))
    expect(granted.filter(Boolean)).toHaveLength(6)
    expect(takePdfExportSlot('budget-test', now + 61_000)).toBe(true)
  })
})

describe('GET /api/canvases/:id/export.pdf', () => {
  let server: Server
  let owner: Client
  let canvasId: string
  let wide: { id: string }
  let tall: { id: string }

  beforeAll(async () => {
    server = await startServer()
    owner = await new Client(server).signUp('pdf-owner@test.dev', 'Petra')
    canvasId = (await (await owner.post('/api/canvases', { name: 'Brochure' })).json()).id
    const frame = async (body: Record<string, unknown>) =>
      (await (await owner.post(`/api/canvases/${canvasId}/frames`, body)).json()) as { id: string }
    /* created out of reading order: the PDF must follow the canvas, not creation */
    tall = await frame({ name: 'Back', x: 0, y: 900, width: 400, height: 700, html: doc('Back cover', '#cde') })
    wide = await frame({ name: 'Front', x: 0, y: 0, width: 800, height: 600, html: doc('Front cover', '#fde') })
    await frame({ name: 'Draft', x: 1000, y: 0, width: 300, height: 300, html: doc('Draft', '#eee'), hidden: true })
  }, 70_000)

  afterAll(() => server?.stop())

  it('keeps a canvas private to strangers and signed-out visitors', async () => {
    const stranger = await new Client(server).signUp('pdf-stranger@test.dev', 'Sam')
    expect((await stranger.get(`/api/canvases/${canvasId}/export.pdf?frames=${wide.id}`)).status).toBe(403)
    expect((await stranger.get(`/api/canvases/${canvasId}/export.pdf`)).status).toBe(403)
    expect((await new Client(server).get(`/api/canvases/${canvasId}/export.pdf`)).status).toBe(401)
  })

  it('refuses frames that are not on the canvas', async () => {
    const res = await owner.get(`/api/canvases/${canvasId}/export.pdf?frames=${wide.id},nope`)
    expect(res.status).toBe(404)
  })

  it.skipIf(!findBrowserPath())(
    'returns one vector page per frame, each sized to its frame, in the order listed',
    async () => {
      const res = await owner.get(`/api/canvases/${canvasId}/export.pdf?frames=${wide.id},${tall.id}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="Brochure.pdf"')
      const bytes = new Uint8Array(await res.arrayBuffer())
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')

      const pdf = await PDFDocument.load(bytes)
      const sizes = pdf.getPages().map((page) => page.getSize())
      expect(sizes).toHaveLength(2)
      const [front, back] = sizes
      expect(front!.width).toBeCloseTo(800 * PX_TO_PT, 0)
      expect(front!.height).toBeCloseTo(600 * PX_TO_PT, 0)
      expect(back!.width).toBeCloseTo(400 * PX_TO_PT, 0)
      expect(back!.height).toBeCloseTo(700 * PX_TO_PT, 0)
    },
    60_000,
  )

  it.skipIf(!findBrowserPath())(
    'exports every visible frame on a page, in reading order, when no frames are named',
    async () => {
      const res = await owner.get(`/api/canvases/${canvasId}/export.pdf`)
      expect(res.status).toBe(200)
      const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()))
      expect(pdf.getPages().map((page) => Math.round(page.getWidth() / PX_TO_PT))).toEqual([800, 400])
    },
    60_000,
  )

  it.skipIf(!findBrowserPath())(
    'names a single-frame PDF after the frame',
    async () => {
      const res = await owner.get(`/api/canvases/${canvasId}/export.pdf?frames=${wide.id}`)
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="Front.pdf"')
      const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()))
      expect(pdf.getPageCount()).toBe(1)
    },
    60_000,
  )
})
