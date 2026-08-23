import type { Frame } from '../../shared/types'
import { api } from './api'
import { useStore } from './store'
import { posthog } from './posthog'
import { recordCreate } from './history'

/** Same-origin frame clipboard: survives canvas switches and browser tabs. */
const CLIP_KEY = 'doop:frame-clipboard'

interface FrameClip {
  name: string
  html: string
  width: number
  height: number
}

export function copyFrame(frame: Frame) {
  const clip: FrameClip = { name: frame.name, html: frame.html, width: frame.width, height: frame.height }
  localStorage.setItem(CLIP_KEY, JSON.stringify(clip))
}

function readFrameClip(): FrameClip | null {
  const raw = localStorage.getItem(CLIP_KEY)
  if (!raw) return null

  try {
    const clip: unknown = JSON.parse(raw)
    if (
      !clip ||
      typeof clip !== 'object' ||
      !('name' in clip) ||
      typeof clip.name !== 'string' ||
      !('html' in clip) ||
      typeof clip.html !== 'string' ||
      !('width' in clip) ||
      typeof clip.width !== 'number' ||
      !Number.isFinite(clip.width) ||
      clip.width <= 0 ||
      !('height' in clip) ||
      typeof clip.height !== 'number' ||
      !Number.isFinite(clip.height) ||
      clip.height <= 0
    ) {
      throw new Error('invalid frame clipboard data')
    }
    return clip as FrameClip
  } catch {
    localStorage.removeItem(CLIP_KEY)
    return null
  }
}

export function hasFrameClip(): boolean {
  return readFrameClip() !== null
}

function createFromClip(canvasId: string, x: number, y: number, clip = readFrameClip()) {
  if (!clip) return
  api
    .createFrame(canvasId, {
      name: clip.name,
      html: clip.html,
      width: clip.width,
      height: clip.height,
      x: Math.round(x),
      y: Math.round(y),
    })
    .then((f) => {
      posthog.capture('frame_pasted')
      recordCreate(f)
      useStore.getState().select(f.id)
    })
    .catch(console.error)
}

/** Paste with the frame's top-left at a screen point (e.g. a right-click). */
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
  const clip = readFrameClip()
  if (!clip) return
  const vp = useStore.getState().viewport
  createFromClip(
    canvasId,
    (window.innerWidth / 2 - vp.x) / vp.zoom - clip.width / 2,
    (window.innerHeight / 2 - vp.y) / vp.zoom - clip.height / 2,
    clip,
  )
}

/* ---- image paste: clipboard bitmap -> uploaded asset -> image frame ---- */

/** Frames larger than this get scaled down on paste (retina screenshots
 *  would otherwise land enormous); the asset keeps its full resolution. */
const MAX_PASTE_DIM = 900

function imageFrameHtml(url: string, alt: string): string {
  return `<!doctype html>
<html>
<head>
<style>
  * { margin: 0; }
  html, body { height: 100%; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; }
</style>
</head>
<body>
  <img src="${url}" alt="${alt.replace(/"/g, '&quot;')}">
</body>
</html>`
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

/** Upload images and drop them as frames laid out in a row, centered as a
 *  group in the current view (one image lands dead-center). Sizes are read
 *  first so differently-sized images sit side by side, never stacked. */
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
  const xs: number[] = []
  let x = cx - totalW / 2
  for (const s of scaled) {
    xs.push(x)
    x += s.width + IMAGE_ROW_GAP
  }
  return Promise.all(
    files.map(async (file, i) => {
      const { url } = await api.uploadAsset(canvasId, file)
      const name = file.name.replace(/\.[a-z0-9]+$/i, '').trim() || fallbackName
      return api.createFrame(canvasId, {
        name,
        html: imageFrameHtml(url, name),
        width: scaled[i].width,
        height: scaled[i].height,
        x: Math.round(xs[i]),
        y: Math.round(cy - scaled[i].height / 2),
      })
    }),
  )
}

export async function pasteImagesCentered(canvasId: string, files: File[]) {
  const frames = await uploadImageFrames(canvasId, files)
  posthog.capture('image_pasted', { count: frames.length })
  frames.forEach(recordCreate)
  useStore.getState().select(frames[frames.length - 1].id)
}

export function duplicateFrame(frame: Frame) {
  api
    .createFrame(frame.canvasId, {
      name: `${frame.name} copy`,
      html: frame.html,
      x: frame.x + 40,
      y: frame.y + 40,
      width: frame.width,
      height: frame.height,
    })
    .then((f) => {
      posthog.capture('frame_duplicated')
      recordCreate(f)
      useStore.getState().select(f.id)
    })
    .catch(console.error)
}
