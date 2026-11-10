import type { Frame } from '../../shared/types'
import { snapshotFrame } from './frameBridge'
import { PrivateExportOperation } from './privateExport'
import type { PrivateMaterializer } from './privateMaterialization'
import {
  assertRenderPixels,
  PRIVATE_MEDIA_LIMITS,
  PrivateMaterializationError,
  type PrivateMaterialization,
} from '../../shared/privateMedia'
import {
  visitPrivateReferences,
  privateAssetUrl,
  PRIVATE_REFERENCE_LIMITS,
  type PrivateUrlKind,
} from '../../shared/privateReferences'
import { inlineMedia } from '../../shared/inlineMedia'

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
  /** Explicit fixture transport; application callers use the normal scoped API. */
  materialize?: PrivateMaterializer
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
  assertRenderPixels(frame.width, frame.height, opts.scale)
  const operation = new PrivateExportOperation(
    frame,
    opts.signal ?? AbortSignal.timeout(RESOURCE_FETCH_MS),
    opts.materialize,
  )
  try {
    const snapshot = await snapshotFrame(frame.id)
    /* an unmounted frame renders from its saved HTML; a mounted one whose
     pixels cannot all be read is for the server */
    if (snapshot && snapshot.html === null) throw new Error('the frame cannot be drawn here')
    const html = snapshot?.html ?? frame.html
    const svg = await inlineDocument(html, {
      width: frame.width,
      height: frame.height,
      signal: operation.signal,
      operation,
    })
    const output = await drawSvg(svg, { width: frame.width, height: frame.height, ...opts, signal: operation.signal })
    if (output.size > PRIVATE_MEDIA_LIMITS.encodedBytes) throw new PrivateMaterializationError('limit')
    await operation.revalidate()
    return output
  } finally {
    operation.close()
  }
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
  assertRenderPixels(clip.width, clip.height, opts.scale)
  const bitmap = await createImageBitmap(image)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(clip.width * opts.scale))
    canvas.height = Math.max(1, Math.round(clip.height * opts.scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d canvas')
    ctx.drawImage(bitmap, -Math.round(clip.x * opts.scale), -Math.round(clip.y * opts.scale))
    return await encode(canvas, opts)
  } finally {
    bitmap.close()
  }
}

interface InlineOptions {
  width: number
  height: number
  signal: AbortSignal
  operation: PrivateExportOperation
}

/** One SVG, sized to the frame, holding the document with every external
 *  resource inlined. Exported for tests. */
export async function inlineDocument(html: string, opts: InlineOptions): Promise<string> {
  assertRenderPixels(opts.width, opts.height)
  const prepared = await opts.operation.document(html)
  // A detached document has no ambient network permission while public media
  // awaits explicit anonymous fetch/admission in its trusted parent.
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`
  const resources = new ResourceCache(opts.operation, prepared)
  try {
    const masked = resources.mask(html)
    const doc = new DOMParser().parseFromString(policy + masked, 'text/html')
    const base = new URL(doc.querySelector('base[href]')?.getAttribute('href') ?? '', document.baseURI).href
    resources.beforeSerialize(doc.documentElement, 'baseline')

    /* nothing embeds inside an SVG image: a nested document would be a hole
     in the picture, so a frame holding one is for the server's browser */
    if (doc.querySelector('iframe, object, embed')) throw new Error('the frame embeds a document')
    /* nothing runs inside one either: scripts, and the <base> that has done its job */
    for (const el of doc.querySelectorAll('script, base, link:not([rel~="stylesheet"])')) el.remove()

    // Serial source preparation keeps each admission's remaining limits current.
    const styles = [...doc.querySelectorAll('style')]
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const href = resources.resolve(link.getAttribute('href') ?? '', base)
      const css = await resources.text(href)
      const inlined = await inlineCssUrls(css, href, resources, new Set([href]), 'external')
      resources.replaceValue(link.outerHTML, `<style>${inlined}</style>`, 'text')
      const style = doc.createElement('style')
      const media = link.getAttribute('media')
      if (media) style.setAttribute('media', media)
      style.textContent = inlined
      link.replaceWith(style)
    }
    for (const style of styles) {
      const old = style.textContent ?? ''
      const next = await inlineCssUrls(old, base, resources)
      resources.replaceValue(old, next, 'text')
      style.textContent = next
    }
    for (const el of doc.querySelectorAll('[style]')) {
      const old = el.getAttribute('style') ?? ''
      const next = await inlineCssUrls(old, base, resources, new Set(), 'prepared', 'declarationList')
      resources.replaceValue(old, next, 'attribute')
      el.setAttribute('style', next)
    }
    for (const img of doc.querySelectorAll('img, input[type="image"], video[poster]')) {
      if (!img.getAttribute('src') && img.hasAttribute('srcset'))
        throw new Error('the local renderer cannot inline this visual resource')
      img.removeAttribute('srcset')
      img.removeAttribute('sizes')
      img.removeAttribute('loading')
      await inlineAttr(img, img.tagName === 'VIDEO' ? 'poster' : 'src', base, resources)
    }
    for (const source of doc.querySelectorAll('picture > source')) source.remove()
    for (const image of doc.querySelectorAll('image'))
      await inlineAttr(image, image.hasAttribute('href') ? 'href' : 'xlink:href', base, resources)
    for (const element of doc.querySelectorAll('svg, svg *')) {
      for (const name of [
        'fill',
        'stroke',
        'filter',
        'clip-path',
        'mask',
        'marker',
        'marker-start',
        'marker-mid',
        'marker-end',
        'cursor',
        'color-profile',
      ]) {
        const old = element.getAttribute(name)
        if (old === null) continue
        const next = await inlineCssUrls(old, base, resources, new Set(), 'prepared', 'value')
        resources.replaceValue(old, next, 'attribute')
        element.setAttribute(name, next)
      }
    }
    resources.assertResolved(doc)
    resources.beforeSerialize(doc.documentElement)
    /* the XML serializer gives an HTML document's root its xhtml namespace */
    const body = new XMLSerializer().serializeToString(doc.documentElement)
    const { width, height } = opts
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject width="${width}" height="${height}">${body}</foreignObject></svg>`
    )
  } finally {
    resources.close()
  }
}

async function inlineAttr(el: Element, attr: string, base: string, resources: ResourceCache): Promise<void> {
  const raw = el.getAttribute(attr)
  if (!raw) return
  const resolved = resources.resolve(raw, base)
  const next = await inlineUrl(resolved, base, resources)
  resources.replaceValue(raw, next, 'attribute')
  el.setAttribute(attr, next)
}

async function inlineUrl(
  ref: string,
  base: string,
  resources: ResourceCache,
  chain?: ReadonlySet<string>,
  source: 'prepared' | 'external' = 'prepared',
  kind: PrivateUrlKind = 'media',
): Promise<string> {
  const url = new URL(resources.resolve(ref, base), base)
  const fragment = url.hash
  url.hash = ''
  return (await resources.dataUrl(url.href, chain, source, kind)) + fragment
}

/** The shared bounded AST owner handles imports, escapes and image-set strings. */
async function inlineCssUrls(
  source: string,
  base: string,
  resources: ResourceCache,
  chain: ReadonlySet<string> = new Set(),
  origin: 'prepared' | 'external' = 'prepared',
  context: 'stylesheet' | 'declarationList' | 'value' = 'stylesheet',
): Promise<string> {
  resources.signal.throwIfAborted()
  const refs = new Map<string, { kind: PrivateUrlKind; occurrences: number }>()
  const work = (count: number) => resources.operation.budget.chargeWork(count)
  visitPrivateReferences(source, location.origin, () => {}, context, {
    base,
    work,
    url: (raw, at, kind) => {
      if (!raw.trim() || raw.trim().startsWith('#')) return
      const url = resources.resolve(raw, at)
      if (/^about:/i.test(url)) return
      if (origin === 'external') resources.operation.budget.reference()
      refs.set(url, { kind, occurrences: (refs.get(url)?.occurrences ?? 0) + 1 })
    },
  })
  const replacements = new Map<string, string>()
  for (const [url, { kind }] of refs) replacements.set(url, await inlineUrl(url, base, resources, chain, origin, kind))
  let growth = 0
  // Fetch/decode once per identity, but reserve every escaped insertion before
  // the AST rewriter constructs it. Do not subtract the resolved URL length:
  // a relative/escaped source spelling may occupy fewer bytes than that URL.
  for (const [url, next] of replacements) growth += refs.get(url)!.occurrences * (escapedBytes(next, 'attribute') + 32)
  resources.operation.budget.assertExpansion(growth)
  return visitPrivateReferences(source, location.origin, () => {}, context, {
    base,
    work,
    url: (raw, at) => replacements.get(resources.resolve(raw, at)),
  })
}

/** Fetches, one per URL, as the bytes of everything inlined. A failed
 *  fetch rejects the whole render: a blank where an image belongs is not an
 *  export, and the server's renderer can still load it. */
function escapedBytes(text: string, mode: 'attribute' | 'text'): number {
  let bytes = new TextEncoder().encode(text).byteLength
  for (const char of text) {
    if (char === '&') bytes += 4
    else if (char === '<' || char === '>') bytes += 3
    else if (char === '\r' || (mode === 'attribute' && ['"', "'", '\t', '\n'].includes(char))) bytes += 5
  }
  return bytes
}

class ResourceCache {
  private readonly pending = new Map<string, Promise<Blob>>()
  private readonly data = new Map<string, Promise<string>>()
  private readonly privateFiles = new Map<string, string>()
  private readonly fileIds = new Map<string, string>()
  private readonly knownData = new Set<string>()
  private readonly aliases = new Map<string, { url: string; raw: string; kind: PrivateUrlKind }>()
  readonly signal: AbortSignal

  constructor(
    readonly operation: PrivateExportOperation,
    prepared: PrivateMaterialization,
  ) {
    this.signal = operation.signal
    for (const row of prepared.replacements) {
      const url = new URL(row.canonical, document.baseURI)
      url.hash = ''
      const data = new URL(row.inline)
      data.hash = ''
      this.privateFiles.set(url.href, data.href)
      const ref = privateAssetUrl(url.href, url.origin)
      if (ref) this.fileIds.set(`${ref.id}.${ref.ext}`, data.href)
      this.knownData.add(data.href)
    }
  }

  /** Mask before native DOM parsing: no raw remote/private URL can auto-load. */
  mask(source: string): string {
    return visitPrivateReferences(source, location.origin, () => {}, 'html', {
      base: document.baseURI,
      work: (count) => this.operation.budget.chargeWork(count),
      url: (raw, base, kind) => {
        if (!raw.trim() || raw.trim().startsWith('#')) return
        const ref = privateAssetUrl(raw, location.origin, base)
        const url = new URL(ref?.url ?? raw, base)
        if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol)) return
        if (this.aliases.size >= PRIVATE_MEDIA_LIMITS.references) throw new PrivateMaterializationError('limit')
        if (url.protocol === 'data:') {
          const media = inlineMedia(url.href)
          if (media && !media.syntax) {
            const copy = new URL(url)
            copy.hash = ''
            this.knownData.add(copy.href)
          }
        }
        const token = `about:blank#doop-export-${this.aliases.size}-end`
        this.aliases.set(token, { url: url.href, raw, kind })
        return token
      },
    })
  }

  resolve(raw: string, base: string): string {
    return this.aliases.get(raw)?.url ?? new URL(raw, base).href
  }

  private preparedValue(raw: string): string {
    const url = new URL(raw, document.baseURI)
    const fragment = url.hash
    url.hash = ''
    const ref = privateAssetUrl(url.href, location.origin)
    const seeded = this.privateFiles.get(url.href) ?? (ref ? this.fileIds.get(`${ref.id}.${ref.ext}`) : undefined)
    return seeded ? seeded + fragment : raw
  }

  private baselineBytes(text: string, mode: 'attribute' | 'text'): number {
    let bytes = escapedBytes(text, mode)
    for (const [token, value] of this.aliases) {
      let start = 0
      while ((start = text.indexOf(token, start)) !== -1) {
        bytes +=
          escapedBytes(this.preparedValue(value.url) === value.url ? value.raw : this.preparedValue(value.url), mode) -
          escapedBytes(token, mode)
        start += token.length
      }
    }
    return bytes
  }

  replaceValue(old: string, next: string, mode: 'attribute' | 'text'): void {
    this.operation.budget.chargeExpanded(Math.max(0, escapedBytes(next, mode) - this.baselineBytes(old, mode)))
  }

  beforeSerialize(root: Element, stage: 'baseline' | 'final' = 'final'): void {
    let bytes = 128
    const nodes: Node[] = [root]
    const size = (text: string, mode: 'attribute' | 'text') =>
      stage === 'baseline' ? this.baselineBytes(text, mode) : escapedBytes(text, mode)
    while (nodes.length) {
      const node = nodes.pop()!
      this.operation.budget.chargeWork(1)
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element
        bytes += 128 + element.tagName.length * 2
        for (const attr of element.attributes) bytes += attr.name.length + size(attr.value, 'attribute') + 128
      } else bytes += size(node.nodeValue ?? '', 'text') + 32
      if (bytes > PRIVATE_MEDIA_LIMITS.expandedBytes) throw new PrivateMaterializationError('limit')
      nodes.push(...node.childNodes)
    }
    const extra = Math.max(0, bytes - this.operation.budget.usage.expandedBytes)
    if (stage === 'baseline') this.operation.budget.chargeExpanded(extra)
    else this.operation.budget.assertExpansion(extra)
  }

  /** An unsupported visual carrier must trigger the authorized fallback,
   * never become a blank raster merely because its URL stayed masked. */
  assertResolved(doc: Document): void {
    for (const element of doc.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        this.operation.budget.chargeWork(1)
        for (const [token, value] of this.aliases) {
          if (value.kind !== 'other' && attribute.value.includes(token))
            throw new Error('the local renderer cannot inline this visual resource')
        }
      }
    }
  }

  close(): void {
    this.pending.clear()
    this.data.clear()
    this.privateFiles.clear()
    this.fileIds.clear()
    this.knownData.clear()
    this.aliases.clear()
  }

  private blob(url: string, syntax: 'stylesheet' | 'media'): Promise<Blob> {
    let pending = this.pending.get(url)
    if (!pending) {
      pending = (async () => {
        if (!/^(?:https?:|blob:)/i.test(url)) throw new PrivateMaterializationError('unsupported')
        const response = await fetch(url, { signal: this.signal, credentials: 'omit', redirect: 'error' })
        if (!response.ok) throw new Error(`${response.status} fetching ${url}`)
        const mime = response.headers.get('content-type') ?? 'application/octet-stream'
        const maximum =
          syntax === 'stylesheet'
            ? PRIVATE_REFERENCE_LIMITS.bytes
            : Math.floor((PRIVATE_REFERENCE_LIMITS.bytes - 4096) / 4) * 3
        if (Number(response.headers.get('content-length') ?? 0) > maximum) {
          await response.body?.cancel().catch(() => {})
          throw new Error('the resource exceeds the local inline source budget')
        }
        const reader = response.body?.getReader()
        const parts: Uint8Array<ArrayBuffer>[] = []
        let total = 0
        try {
          if (!reader) this.operation.publicChunk(url, 0)
          for (;;) {
            this.signal.throwIfAborted()
            const part = await reader?.read()
            if (!part || part.done) break
            total += part.value.byteLength
            if (total > maximum) throw new Error('the resource exceeds the local inline source budget')
            this.operation.publicChunk(url, part.value.byteLength)
            parts.push(new Uint8Array(part.value))
          }
        } catch (error) {
          await reader?.cancel().catch(() => {})
          throw error
        } finally {
          reader?.releaseLock()
        }
        return new Blob(parts, { type: mime })
      })()
      this.pending.set(url, pending)
    }
    return pending
  }

  async text(url: string): Promise<string> {
    return (await this.blob(url, 'stylesheet')).text()
  }

  async dataUrl(
    url: string,
    chain: ReadonlySet<string> = new Set(),
    origin: 'prepared' | 'external' = 'prepared',
    kind: PrivateUrlKind = 'media',
  ): Promise<string> {
    this.signal.throwIfAborted()
    if (kind === 'stylesheet') {
      if (chain.has(url)) return 'data:text/css,'
      if (chain.size >= PRIVATE_REFERENCE_LIMITS.depth) throw new PrivateMaterializationError('limit')
      const media = url.startsWith('data:') ? inlineMedia(url, 'stylesheet') : undefined
      if (media && media.syntax !== 'stylesheet') throw new PrivateMaterializationError('unsupported')
      const text = media ? new TextDecoder().decode(media.bytes) : await this.text(url)
      const nextOrigin = url.startsWith('data:') ? origin : 'external'
      const inlined = await inlineCssUrls(
        text,
        url.startsWith('data:') ? document.baseURI : url,
        this,
        new Set(chain).add(url),
        nextOrigin,
      )
      const bytes = new TextEncoder().encode(inlined).byteLength
      this.operation.budget.assertExpansion(4 * Math.ceil(bytes / 3) + 64)
      return toDataUrl(new Blob([inlined], { type: 'text/css' }))
    }
    if (url.startsWith('data:')) {
      if (origin === 'prepared' || this.knownData.has(url)) return url
      const value = await this.operation.inlineResource(url)
      this.knownData.add(value)
      return value
    }
    const ref = privateAssetUrl(url, location.origin)
    const seeded = this.privateFiles.get(url) ?? (ref ? this.fileIds.get(`${ref.id}.${ref.ext}`) : undefined)
    if (seeded) return seeded
    let pending = this.data.get(url)
    if (!pending) {
      pending = ref
        ? this.operation.privateResource(new URL(url).pathname)
        : (async () => {
            const blob = await this.blob(url, 'media')
            this.operation.budget.assertExpansion(4 * Math.ceil(blob.size / 3) + 1024)
            const uri = await toDataUrl(blob)
            return this.operation.publicResource(uri, url, blob.size)
          })()
      this.data.set(url, pending)
    }
    return pending
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
