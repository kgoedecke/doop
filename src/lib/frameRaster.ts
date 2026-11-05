import type { Frame } from '../../shared/types'
import { snapshotFrame } from './frameBridge'

/**
 * Render a frame to an image in this browser: the document is inlined into
 * one self-contained SVG (every image, stylesheet and font as a data: URL,
 * since an SVG drawn as an image loads nothing from the network), drawn
 * onto a canvas and encoded. The engine that shows the frame paints the
 * export, so it is exactly what the person sees, with no server render.
 *
 * Anything that cannot be inlined (an image whose host sends no CORS
 * headers, a document the XML serializer cannot round-trip) rejects, and
 * the caller falls back to the server's renderer.
 */

export type RasterType = 'png' | 'jpeg'

/** A box inside the frame, in frame pixels. */
export interface ClipRect {
  x: number
  y: number
  width: number
  height: number
}

export interface RasterOptions {
  /** output pixel density; 2 for a retina export */
  scale: number
  type: RasterType
  /** JPEG only, 0-1 */
  quality?: number
  /** the whole render, fetches included, gives up when this fires */
  signal?: AbortSignal
  /** the part of the frame to keep; the whole frame when unset. The
   *  document is still laid out and painted whole, so an element keeps
   *  every style its ancestors give it and whatever paints behind it. */
  clip?: ClipRect
}

const RESOURCE_FETCH_MS = 15_000

export async function rasterizeFrame(frame: Frame, opts: RasterOptions): Promise<Blob> {
  const signal = opts.signal ?? AbortSignal.timeout(RESOURCE_FETCH_MS)
  const snapshot = await snapshotFrame(frame.id)
  /* an unmounted frame renders from its saved HTML; a mounted one whose
     pixels cannot all be read is for the server */
  if (snapshot && snapshot.html === null) throw new Error('the frame cannot be drawn here')
  const html = snapshot?.html ?? frame.html
  const svg = await inlineDocument(html, { width: frame.width, height: frame.height, signal })
  return drawSvg(svg, { width: frame.width, height: frame.height, ...opts })
}

/** The part of the frame a rendered box covers, in whole frame pixels
 *  (rounded outward, so an edge at a fraction is kept), or null when the
 *  box lies outside the frame: what the frame clips away is not in any
 *  render of it. */
export function clipToFrame(
  rect: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): ClipRect | null {
  const left = Math.max(0, Math.floor(rect.x))
  const top = Math.max(0, Math.floor(rect.y))
  const right = Math.min(frame.width, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(frame.height, Math.ceil(rect.y + rect.height))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Cut `clip` out of a rendered frame image drawn at `scale` (the server's
 *  export, say) and encode the piece. */
export async function cropRaster(
  image: Blob,
  clip: ClipRect,
  opts: Pick<RasterOptions, 'scale' | 'type' | 'quality'>,
): Promise<Blob> {
  const bitmap = await createImageBitmap(image)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(clip.width * opts.scale))
  canvas.height = Math.max(1, Math.round(clip.height * opts.scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas')
  ctx.drawImage(bitmap, -Math.round(clip.x * opts.scale), -Math.round(clip.y * opts.scale))
  return encode(canvas, opts)
}

interface InlineOptions {
  width: number
  height: number
  signal: AbortSignal
}

/** One SVG, sized to the frame, holding the document with every external
 *  resource inlined. Exported for tests. */
export async function inlineDocument(html: string, opts: InlineOptions): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const base = new URL(doc.querySelector('base[href]')?.getAttribute('href') ?? '', document.baseURI).href
  const resources = new ResourceCache(opts.signal)

  /* nothing embeds inside an SVG image: a nested document would be a hole
     in the picture, so a frame holding one is for the server's browser */
  if (doc.querySelector('iframe, object, embed')) throw new Error('the frame embeds a document')
  /* nothing runs inside one either: scripts, and the <base> that has done its job */
  for (const el of doc.querySelectorAll('script, base, link:not([rel~="stylesheet"])')) el.remove()

  const work: Promise<void>[] = []
  for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    work.push(
      (async () => {
        const href = new URL(link.getAttribute('href') ?? '', base).href
        const css = await resources.text(href)
        const style = doc.createElement('style')
        const media = link.getAttribute('media')
        if (media) style.setAttribute('media', media)
        style.textContent = await inlineCssUrls(css, href, resources)
        link.replaceWith(style)
      })(),
    )
  }
  for (const style of doc.querySelectorAll('style')) {
    work.push(
      (async () => {
        style.textContent = await inlineCssUrls(style.textContent ?? '', base, resources)
      })(),
    )
  }
  for (const el of doc.querySelectorAll('[style]')) {
    const inline = el.getAttribute('style') ?? ''
    if (!/url\(/i.test(inline)) continue
    work.push(
      (async () => {
        el.setAttribute('style', await inlineCssUrls(inline, base, resources))
      })(),
    )
  }
  for (const img of doc.querySelectorAll('img, input[type="image"], video[poster]')) {
    /* one source per image: the browser picked from srcset by the frame's
       own viewport, which is the width the SVG gets too, so src is right */
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')
    img.removeAttribute('loading')
    const attr = img.tagName === 'VIDEO' ? 'poster' : 'src'
    work.push(inlineAttr(img, attr, base, resources))
  }
  for (const source of doc.querySelectorAll('picture > source')) source.remove()
  for (const image of doc.querySelectorAll('image')) {
    work.push(inlineAttr(image, image.hasAttribute('href') ? 'href' : 'xlink:href', base, resources))
  }
  await Promise.all(work)

  /* the XML serializer gives an HTML document's root its xhtml namespace */
  const body = new XMLSerializer().serializeToString(doc.documentElement)
  const { width, height } = opts
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="${width}" height="${height}">${body}</foreignObject></svg>`
  )
}

async function inlineAttr(el: Element, attr: string, base: string, resources: ResourceCache): Promise<void> {
  const raw = el.getAttribute(attr)
  if (!raw || isInlineUrl(raw)) return
  el.setAttribute(attr, await inlineUrl(raw, base, resources))
}

/** The data: URL for `ref`, keeping its fragment: `sprite.svg#icon` and
 *  `#svgView(...)` pick what an SVG shows. */
async function inlineUrl(
  ref: string,
  base: string,
  resources: ResourceCache,
  chain?: ReadonlySet<string>,
): Promise<string> {
  const url = new URL(ref, base)
  const fragment = url.hash
  url.hash = ''
  return (await resources.dataUrl(url.href, chain)) + fragment
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
/* `@import "x.css"` is `@import url("x.css")` without the function */
const CSS_IMPORT_STRING = /@import\s+(['"])([^'"]+)\1/gi

/** Every `url(...)` in `css` that points off the document becomes a data:
 *  URL; a stylesheet it imports is inlined the same way, recursively.
 *  `chain` is the stylesheets being inlined on the way here: one that
 *  imports itself again, however indirectly, is left empty at that point. */
async function inlineCssUrls(
  css: string,
  base: string,
  resources: ResourceCache,
  chain: ReadonlySet<string> = new Set(),
): Promise<string> {
  resources.signal.throwIfAborted()
  css = css.replace(CSS_IMPORT_STRING, '@import url("$2")')
  const refs = [...css.matchAll(CSS_URL)].map((m) => m[2]?.trim() ?? '').filter((ref) => ref && !isInlineUrl(ref))
  if (refs.length === 0) return css
  const replacements = new Map<string, string>()
  await Promise.all(
    [...new Set(refs)].map(async (ref) => {
      replacements.set(ref, await inlineUrl(ref, base, resources, chain))
    }),
  )
  return css.replace(CSS_URL, (whole, _quote: string, ref: string) => {
    const replacement = replacements.get(ref.trim())
    return replacement ? `url("${replacement}")` : whole
  })
}

/** data: carries its own bytes, `#id` points inside the document. A blob:
 *  URL is left to the fetch, which fails for another document's object
 *  URL and so hands the export to the server. */
function isInlineUrl(ref: string): boolean {
  return /^(data:|#|about:)/i.test(ref)
}

/** Fetches, one per URL, as the bytes of everything inlined. A failed
 *  fetch rejects the whole render: a blank where an image belongs is not an
 *  export, and the server's renderer can still load it. */
class ResourceCache {
  private readonly pending = new Map<string, Promise<Blob>>()
  constructor(readonly signal: AbortSignal) {}

  private blob(url: string): Promise<Blob> {
    let pending = this.pending.get(url)
    if (!pending) {
      pending = fetch(url, { signal: this.signal, credentials: 'same-origin' }).then((res) => {
        if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
        return res.blob()
      })
      this.pending.set(url, pending)
    }
    return pending
  }

  async text(url: string): Promise<string> {
    return (await this.blob(url)).text()
  }

  async dataUrl(url: string, chain: ReadonlySet<string> = new Set()): Promise<string> {
    const blob = await this.blob(url)
    if (blob.type.startsWith('text/css')) {
      /* a stylesheet imported by another: its own url()s resolve against
         it, and an import cycle ends where it started */
      if (chain.has(url)) return 'data:text/css,'
      const css = await inlineCssUrls(await blob.text(), url, this, new Set(chain).add(url))
      return toDataUrl(new Blob([css], { type: 'text/css' }))
    }
    return toDataUrl(blob)
  }
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('could not read resource'))
    reader.readAsDataURL(blob)
  })
}

interface DrawOptions extends RasterOptions {
  width: number
  height: number
}

/** Draw the SVG onto a canvas at `scale` and encode it, the whole frame
 *  or the `clip` of it. The canvas is painted white first, as the server's
 *  renderer paints a frame with no background, and a JPEG has no alpha to
 *  keep. */
async function drawSvg(svg: string, opts: DrawOptions): Promise<Blob> {
  /* a data: URL, not a blob: one — Chromium taints the canvas for a
     foreignObject SVG drawn from a blob URL, and the export needs toBlob */
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, opts.signal)
  const clip = opts.clip ?? { x: 0, y: 0, width: opts.width, height: opts.height }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(clip.width * opts.scale))
  canvas.height = Math.max(1, Math.round(clip.height * opts.scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d canvas')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  /* the whole frame is drawn at scale, shifted so the clip lands at the origin */
  ctx.drawImage(
    image,
    -Math.round(clip.x * opts.scale),
    -Math.round(clip.y * opts.scale),
    Math.round(opts.width * opts.scale),
    Math.round(opts.height * opts.scale),
  )
  return encode(canvas, opts)
}

function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const abort = () => reject(signal?.reason ?? new Error('render aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    image.onload = () => {
      signal?.removeEventListener('abort', abort)
      resolve(image)
    }
    image.onerror = () => {
      signal?.removeEventListener('abort', abort)
      reject(new Error('the document could not be drawn'))
    }
    image.src = url
  })
}

function encode(canvas: HTMLCanvasElement, opts: Pick<RasterOptions, 'type' | 'quality'>): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('could not encode the image'))),
        opts.type === 'jpeg' ? 'image/jpeg' : 'image/png',
        opts.type === 'jpeg' ? (opts.quality ?? 0.9) : undefined,
      )
    } catch (error) {
      /* a tainted canvas throws a SecurityError here */
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
