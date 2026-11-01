import type { Frame } from '../../shared/types'
import { api } from './api'
import { useStore } from './store'
import { posthog } from './posthog'
import { recordCreate, recordCreates } from './history'
import { ELEMENT_CLIP_KEY, FRAME_CLIP_KEY as CLIP_KEY } from './clipboardKeys'

/** One copied frame, positioned relative to the top-left of the copied group
 *  so a multi-frame paste keeps the frames' layout. */
interface ClipFrame {
  name: string
  html: string
  x: number
  y: number
  width: number
  height: number
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
  const results = await Promise.allSettled(requests.map((r) => api.createFrame(r.canvasId, r.frame)))
  const created = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) console.error(`${requests.length - created.length} of ${requests.length} frame(s) failed`, failed.reason)
  if (created.length) {
    recordCreates(created)
    useStore.getState().selectMany(created.map((f) => f.id))
  }
  return created
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
  createFromClip(
    canvasId,
    (window.innerWidth / 2 - vp.x) / vp.zoom - width / 2,
    (window.innerHeight / 2 - vp.y) / vp.zoom - height / 2,
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

/** Upload images and place them as canvas elements laid out in a row,
 *  centered as a group in the current view (one image lands dead-center).
 *  Sizes are read first so differently-sized images sit side by side, never
 *  stacked. */
export async function uploadImageFrames(
  canvasId: string,
  files: File[],
  fallbackName = 'Pasted image',
): Promise<Frame[]> {
  const dims = await Promise.all(files.map((f) => imageSize(f)))
  const scaled = dims.map((d) => {
    const scale = Math.min(1, MAX_PASTE_DIM / Math.max(d.width, d.height))
    return { width: Math.max(40, Math.round(d.width * scale)), height: Math.max(40, Math.round(d.height * scale)) }
  })
  const vp = useStore.getState().viewport
  const cx = (window.innerWidth / 2 - vp.x) / vp.zoom
  const cy = (window.innerHeight / 2 - vp.y) / vp.zoom
  const totalW = scaled.reduce((sum, s) => sum + s.width, 0) + IMAGE_ROW_GAP * (scaled.length - 1)
  let x = cx - totalW / 2
  const placed = scaled.map((size) => {
    const slot = { ...size, x }
    x += size.width + IMAGE_ROW_GAP
    return slot
  })
  return Promise.all(
    files.map(async (file, i) => {
      const slot = placed[i]
      if (!slot) throw new Error('image slot missing')
      const { url } = await api.uploadAsset(canvasId, file)
      const name = file.name.replace(/\.[a-z0-9]+$/i, '').trim() || fallbackName
      return api.createFrame(canvasId, {
        name,
        html: imageElementHtml(url, name),
        width: slot.width,
        height: slot.height,
        x: Math.round(slot.x),
        y: Math.round(cy - slot.height / 2),
      })
    }),
  )
}

export async function pasteImagesCentered(canvasId: string, files: File[]) {
  const frames = await uploadImageFrames(canvasId, files)
  posthog.capture('image_pasted', { count: frames.length })
  frames.forEach(recordCreate)
  const last = frames[frames.length - 1]
  if (last) useStore.getState().select(last.id)
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
      },
    })),
  ).then((created) => {
    if (created.length) posthog.capture('frame_duplicated', { count: created.length })
  })
}
