import type { Frame } from '../../shared/types'
import { api } from './api'
import { useStore } from './store'
import { posthog } from './posthog'
import { recordCreates } from './history'
import { ELEMENT_CLIP_KEY, FRAME_CLIP_KEY as CLIP_KEY } from './clipboardKeys'
import { stageViewportSize } from './framePlacement'
import { importSvgInBrowser, looksLikeSvg } from './svgImport'
import { importPdf, isPdfFile } from './pdfImport'

/** One copied frame, positioned relative to the top-left of the copied group
 *  so a multi-frame paste keeps the frames' layout. */
interface ClipFrame {
  name: string
  html: string
  x: number
  y: number
  width: number
  height: number
  /** degrees clockwise about the centre, when the copied frame was turned */
  rotation?: number
}

interface FrameClip {
  frames: ClipFrame[]
}

export function copyFrames(frames: Frame[]) {
  if (!frames.length) return
  const left = Math.min(...frames.map((f) => f.x))
  const top = Math.min(...frames.map((f) => f.y))
  const clip: FrameClip = {
    frames: frames.map((f) => ({
      name: f.name,
      html: f.html,
      x: f.x - left,
      y: f.y - top,
      width: f.width,
      height: f.height,
      ...(f.rotation ? { rotation: f.rotation } : {}),
    })),
  }
  localStorage.setItem(CLIP_KEY, JSON.stringify(clip))
  localStorage.removeItem(ELEMENT_CLIP_KEY)
}

function readClip(): ClipFrame[] {
  const raw = localStorage.getItem(CLIP_KEY)
  if (!raw) return []
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed?.frames)) return parsed.frames
  /* a clip written before multi-frame copy: one frame, no offset */
  return parsed?.html === undefined ? [] : [{ ...parsed, x: 0, y: 0 }]
}

export function hasFrameClip(): boolean {
  return !!localStorage.getItem(CLIP_KEY)
}

/** Overall size of the copied group, for centring it in the view. */
function clipBounds(frames: ClipFrame[]) {
  return {
    width: Math.max(...frames.map((f) => f.x + f.width)),
    height: Math.max(...frames.map((f) => f.y + f.height)),
  }
}

/** Create several frames at once. The requests are independent, so one
 *  failing must not orphan its siblings: whatever landed is still recorded
 *  in history (undoable as a group) and becomes the selection. */
async function createFrames(requests: { canvasId: string; frame: Parameters<typeof api.createFrame>[1] }[]) {
  return (await settleFrames(requests)).flatMap((frame) => (frame ? [frame] : []))
}

/** Like `createFrames`, but says which request each frame came from: a
 *  `null` where that request failed. */
async function settleFrames(requests: { canvasId: string; frame: Parameters<typeof api.createFrame>[1] }[]) {
  const results = await Promise.allSettled(requests.map((r) => api.createFrame(r.canvasId, r.frame)))
  const created = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) console.error(`${requests.length - created.length} of ${requests.length} frame(s) failed`, failed.reason)
  if (created.length) {
    recordCreates(created)
    useStore.getState().selectMany(created.map((f) => f.id))
  }
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null))
}

/** Create the copied frames with the group's top-left at a world point. */
function createFromClip(canvasId: string, x: number, y: number) {
  const frames = readClip()
  if (!frames.length) return
  void createFrames(
    frames.map((f) => ({
      canvasId,
      frame: {
        name: f.name,
        html: f.html,
        width: f.width,
        height: f.height,
        x: Math.round(x + f.x),
        y: Math.round(y + f.y),
        ...(f.rotation ? { rotation: f.rotation } : {}),
      },
    })),
  ).then((created) => {
    if (created.length) posthog.capture('frame_pasted', { count: created.length })
  })
}

/** Paste with the group's top-left at a screen point (e.g. a right-click). */
export function pasteFrameAtScreen(canvasId: string, clientX: number, clientY: number) {
  const stage = document.querySelector('.stage')?.getBoundingClientRect()
  const vp = useStore.getState().viewport
  createFromClip(
    canvasId,
    (clientX - (stage?.left ?? 0) - vp.x) / vp.zoom,
    (clientY - (stage?.top ?? 0) - vp.y) / vp.zoom,
  )
}

/** Paste centered in the current view (keyboard ⌘V). */
export function pasteFrameCentered(canvasId: string) {
  const frames = readClip()
  if (!frames.length) return
  const { width, height } = clipBounds(frames)
  const vp = useStore.getState().viewport
  /* the stage, not the window: docked panels leave it only part of it */
  const stage = stageViewportSize()
  createFromClip(
    canvasId,
    (stage.width / 2 - vp.x) / vp.zoom - width / 2,
    (stage.height / 2 - vp.y) / vp.zoom - height / 2,
  )
}

/* ---- image paste: clipboard bitmap -> uploaded asset -> image frame ---- */

/** Frames larger than this get scaled down on paste (retina screenshots
 *  would otherwise land enormous); the asset keeps its full resolution. */
const MAX_PASTE_DIM = 900

/** A pasted or dropped image is a top-level canvas element, the way a drawn
 *  shape is: a transparent shell the size of its one image, which the Layers
 *  panel lists at the root under its name, moves into frames and back out of,
 *  and scales with when resized. */
function imageElementHtml(url: string, name: string): string {
  const doc = new DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html')
  doc.documentElement.style.cssText = 'width:100%;height:100%;margin:0;'
  doc.body.style.cssText = 'width:100%;height:100%;margin:0;'
  doc.body.setAttribute('data-doop-canvas-element', 'true')
  const img = doc.createElement('img')
  img.setAttribute('data-doop-drawing', 'image')
  img.setAttribute('data-name', name)
  img.src = url
  img.alt = name
  img.setAttribute(
    'style',
    'position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;margin:0;display:block;object-fit:contain;',
  )
  doc.body.append(img)
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth || 512, height: img.naturalHeight || 512 })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve({ width: 512, height: 512 })
    }
    img.src = url
  })
}

/** Horizontal breathing room between images dropped together. */
const IMAGE_ROW_GAP = 40

interface Slot {
  width: number
  height: number
  /** A vector keeps its proportions; a bitmap sits in a box it fits inside. */
  uniform?: boolean
  /** A page keeps its size: its markup is laid out in those px. */
  exact?: boolean
}

/** Lay sizes out in a row centered as a group on `at` (a screen point, the
 *  middle of the view when left out; one lands dead-center), in world px. */
function rowSlots(sizes: Slot[], at?: { x: number; y: number }) {
  const scaled = sizes.map((d) => {
    if (d.exact) return { width: d.width, height: d.height }
    const scale = Math.min(1, MAX_PASTE_DIM / Math.max(d.width, d.height))
    if (d.uniform)
      return { width: Math.max(1, Math.round(d.width * scale)), height: Math.max(1, Math.round(d.height * scale)) }
    return { width: Math.max(40, Math.round(d.width * scale)), height: Math.max(40, Math.round(d.height * scale)) }
  })
  const vp = useStore.getState().viewport
  /* a drop point is in window coordinates, the viewport in the stage's (the
     desktop shell's title bar sits above it); a paste centers in the stage */
  const stage = document.querySelector('.stage')?.getBoundingClientRect()
  const { width, height } = stageViewportSize()
  const point = at ? { x: at.x - (stage?.left ?? 0), y: at.y - (stage?.top ?? 0) } : { x: width / 2, y: height / 2 }
  const cx = (point.x - vp.x) / vp.zoom
  const cy = (point.y - vp.y) / vp.zoom
  const totalW = scaled.reduce((sum, s) => sum + s.width, 0) + IMAGE_ROW_GAP * (scaled.length - 1)
  let x = cx - totalW / 2
  return scaled.map((size) => {
    const slot = { ...size, x: Math.round(x), y: Math.round(cy - size.height / 2) }
    x += size.width + IMAGE_ROW_GAP
    return slot
  })
}

/** Upload images and place them as canvas elements laid out in a row,
 *  centered as a group on `at`. Sizes are read first so differently-sized
 *  images sit side by side, never stacked. */
export async function uploadImageFrames(
  canvasId: string,
  files: File[],
  { fallbackName = 'Pasted image', at }: { fallbackName?: string; at?: { x: number; y: number } } = {},
): Promise<Frame[]> {
  const placed = rowSlots(await Promise.all(files.map((f) => imageSize(f))), at)
  return Promise.all(
    files.map(async (file, i) => {
      const slot = placed[i]
      if (!slot) throw new Error('image slot missing')
      const { url } = await api.uploadAsset(canvasId, file)
      const name = fileStem(file.name) || fallbackName
      return api.createFrame(canvasId, {
        name,
        html: imageElementHtml(url, name),
        width: slot.width,
        height: slot.height,
        x: slot.x,
        y: slot.y,
      })
    }),
  )
}

function fileStem(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').trim()
}

/* ---- files from the clipboard or a drop: bitmaps become pictures, SVGs editable shapes ---- */

/** An SVG on the clipboard or in a drop, by type or by name. */
export function isSvgFile(file: File): boolean {
  return file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
}

/** The text on the clipboard when it is an SVG document, as copying a file's
 *  source or an icon from a design tool puts there. */
export function svgMarkupOf(data: DataTransfer | null): string | null {
  const text = data?.getData('text/plain') ?? ''
  return looksLikeSvg(text) ? text : null
}

/** What a paste or drop brought: image files, SVG files, PDFs, or SVG source text. */
export interface IncomingFiles {
  images: File[]
  vectors: File[]
  pdfs: File[]
  markup?: string | null
}

export function splitIncoming(files: File[], markup: string | null = null): IncomingFiles {
  const vectors = files.filter(isSvgFile)
  return {
    vectors,
    pdfs: files.filter(isPdfFile),
    images: files.filter((f) => f.type.startsWith('image/') && !isSvgFile(f)),
    markup: files.length ? null : markup,
  }
}

export function hasIncoming({ images, vectors, pdfs, markup }: IncomingFiles): boolean {
  return images.length > 0 || vectors.length > 0 || pdfs.length > 0 || !!markup
}

/** One frame to create, sized and named, with its markup ready. */
type Prepared = { kind: 'image' | 'vector' | 'page'; name: string; size: Slot; html: () => Promise<string> }

/** What a paste or drop landed, by kind. */
interface Landed {
  images: number
  vectors: number
  pages: number
}

/** Place everything a paste or drop brought as one row, bitmaps and vectors
 *  alike, centered on `at`. Whatever lands is recorded as one undo step and
 *  becomes the selection, even when a sibling's upload or request fails. */
async function importIncoming(
  canvasId: string,
  incoming: IncomingFiles,
  { fallbackName, at }: { fallbackName: string; at?: { x: number; y: number } },
): Promise<Landed> {
  const images: Prepared[] = await Promise.all(
    incoming.images.map(async (file) => ({
      kind: 'image' as const,
      name: fileStem(file.name) || fallbackName,
      size: await imageSize(file),
      html: async () => {
        const { url } = await api.uploadAsset(canvasId, file)
        return imageElementHtml(url, fileStem(file.name) || fallbackName)
      },
    })),
  )
  const sources = incoming.markup
    ? [{ name: 'Vector', markup: incoming.markup }]
    : await Promise.all(
        incoming.vectors.map(async (file) => ({ name: fileStem(file.name) || 'Vector', markup: await file.text() })),
      )
  const vectors: Prepared[] = sources.flatMap(({ name, markup }) => {
    const result = importSvgInBrowser(markup, name)
    if (!result) return []
    return [
      {
        kind: 'vector' as const,
        name,
        size: { width: result.width, height: result.height, uniform: true },
        html: () => Promise.resolve(result.html),
      },
    ]
  })
  if (sources.length && !vectors.length && !images.length) throw new Error('The SVG has no shapes to import.')
  /* a PDF is one frame per page, at the page's printed size */
  /* a PDF that cannot be read drops out on its own; its siblings still land */
  const read = await Promise.allSettled(
    incoming.pdfs.map(async (file) =>
      importPdf(new Uint8Array(await file.arrayBuffer()), fileStem(file.name) || 'PDF', {
        importSvg: importSvgInBrowser,
        /* pictures become assets, so a photo-heavy page stays under the frame's size cap */
        storeImage: async (bytes, mime) =>
          (await api.uploadAsset(canvasId, new Blob([bytes as BlobPart], { type: mime }))).url,
      }),
    ),
  )
  const unreadable = read.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (unreadable) console.error('PDF import failed', unreadable.reason)
  const pages: Prepared[] = read
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .map((page) => ({
      kind: 'page' as const,
      name: page.name,
      size: { width: page.width, height: page.height, exact: true },
      html: () => Promise.resolve(page.html),
    }))
  if (incoming.pdfs.length && !pages.length && !vectors.length && !images.length)
    throw unreadable ? new Error('The PDF could not be read.') : new Error('The PDF has no pages to import.')
  const prepared = [...vectors, ...pages, ...images]
  const placed = rowSlots(
    prepared.map((p) => p.size),
    at,
  )
  /* a bitmap whose upload fails (too large, say) drops out on its own; the
     others keep their slots */
  const ready = await Promise.allSettled(
    prepared.map(async (p, i) => {
      const slot = placed[i]!
      return {
        kind: p.kind,
        canvasId,
        frame: { name: p.name, html: await p.html(), width: slot.width, height: slot.height, x: slot.x, y: slot.y },
      }
    }),
  )
  const requests = ready.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const upload = ready.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (upload) console.error(`${ready.length - requests.length} of ${ready.length} file(s) failed`, upload.reason)
  const frames = await settleFrames(requests)
  const landed: Landed = { images: 0, vectors: 0, pages: 0 }
  const counted = { image: 'images', vector: 'vectors', page: 'pages' } as const
  frames.forEach((frame, i) => {
    if (frame) landed[counted[requests[i]!.kind]]++
  })
  if (!landed.images && !landed.vectors && !landed.pages && prepared.length) {
    if (upload) throw upload.reason instanceof Error ? upload.reason : new Error(String(upload.reason))
    throw new Error('Couldn’t add the files.')
  }
  return landed
}

export async function pasteFilesCentered(canvasId: string, incoming: IncomingFiles) {
  const landed = await importIncoming(canvasId, incoming, { fallbackName: 'Pasted image' })
  posthog.capture('files_pasted', landed)
}

/** Files dragged in from the desktop land centered on the drop point. */
export async function dropFiles(canvasId: string, incoming: IncomingFiles, at: { x: number; y: number }) {
  const landed = await importIncoming(canvasId, incoming, { fallbackName: 'Dropped image', at })
  posthog.capture('files_dropped', landed)
}

/** Duplicate frames 40px down-right of the originals, keeping their layout;
 *  several frames land as one undo step and become the new selection. */
export function duplicateFrames(frames: Frame[]) {
  if (!frames.length) return
  void createFrames(
    frames.map((frame) => ({
      canvasId: frame.canvasId,
      frame: {
        name: `${frame.name} copy`,
        html: frame.html,
        x: frame.x + 40,
        y: frame.y + 40,
        width: frame.width,
        height: frame.height,
        ...(frame.rotation ? { rotation: frame.rotation } : {}),
      },
    })),
  ).then((created) => {
    if (created.length) posthog.capture('frame_duplicated', { count: created.length })
  })
}
