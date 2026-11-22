import { DEFAULT_EXPORT_SCALE, exportPixelSize, fitExportScale, parseExportScale } from '../shared/exportScale.ts'
import { elementIdSelector, isElementId, MAX_LAYER_SELECTOR_CHARS } from '../shared/elementId.ts'
import type { Frame } from '../shared/types.ts'
import { env } from './env.ts'
import { hasElementId } from './elementIds.ts'

/**
 * One layer of a frame as an image: the frame rendered whole, then cut to
 * the layer's box, so what it inherits and what paints behind it stay in
 * the picture (the editor's element export does the same in the browser).
 * Served as `/i/<frameId>.<ext>?element=<data-doop-id>` or `?selector=<css>`,
 * which re-renders when the frame changes, like a frame's image URL.
 */

/** The layer an export names: its stamped id, or any CSS selector. */
export type LayerRef = { elementId: string } | { selector: string }

/** The layer named nothing the renderer could crop to. */
export class LayerNotFoundError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'LayerNotFoundError'
  }
}

/** The CSS selector the renderer looks the layer up by. */
export function layerSelector(ref: LayerRef): string {
  return 'elementId' in ref ? elementIdSelector(ref.elementId) : ref.selector
}

/** The `/i/` query naming a layer, or undefined when the request names
 *  none; null when it names one badly. */
export function layerRefFromQuery(query: Record<string, unknown>): LayerRef | null | undefined {
  const { element, selector } = query
  if (element === undefined && selector === undefined) return undefined
  if (element !== undefined) return isElementId(element) ? { elementId: element } : null
  return typeof selector === 'string' && selector.trim() && selector.length <= MAX_LAYER_SELECTOR_CHARS
    ? { selector: selector.trim() }
    : null
}

function layerParam(ref: LayerRef): string {
  return 'elementId' in ref ? `element=${ref.elementId}` : `selector=${encodeURIComponent(ref.selector)}`
}

export interface LayerExportRequest {
  format?: 'png' | 'jpg'
  scale?: number
  quality?: number
}

export type LayerExport =
  { ok: true; image_url: string; download_url: string; scale: number; note: string } | { ok: false; error: string }

/** The URLs `export_layer` hands back, after checking the layer can be
 *  named: a stamped id must be in the frame's saved HTML; a selector is
 *  only checked when the image renders, since it may match an element a
 *  script made. */
export function layerExport(frame: Frame, ref: LayerRef, req: LayerExportRequest = {}): LayerExport {
  if ('elementId' in ref) {
    if (!isElementId(ref.elementId))
      return { ok: false, error: `element_id must be a data-doop-id value ([a-z0-9]{6}), got "${ref.elementId}"` }
    if (!hasElementId(frame.html, ref.elementId))
      return {
        ok: false,
        error: `no element in frame ${frame.id} carries data-doop-id="${ref.elementId}"; read the frame with get_frame, or pass a CSS selector instead`,
      }
  } else if (!ref.selector.trim() || ref.selector.length > MAX_LAYER_SELECTOR_CHARS) {
    return { ok: false, error: `selector must be a CSS selector of 1-${MAX_LAYER_SELECTOR_CHARS} characters` }
  }
  const ext = req.format === 'jpg' ? 'jpg' : 'png'
  const quality = ext === 'jpg' ? `&quality=${req.quality ?? 90}` : ''
  /* fitted to the whole frame, which is what renders before the cut */
  const scale = fitExportScale(frame, parseExportScale(req.scale ?? DEFAULT_EXPORT_SCALE) ?? DEFAULT_EXPORT_SCALE)
  const base = `${env.BETTER_AUTH_URL}/i/${frame.id}.${ext}?scale=${scale}&${layerParam(ref)}${quality}`
  return {
    ok: true,
    image_url: base,
    download_url: `${base}&download`,
    scale,
    note: `Public URL, no auth needed: the frame rendered whole and cut to this layer's box (up to ${exportPixelSize(frame, scale).width}px wide), so inherited styles and the background behind it are in the picture. It re-renders when the frame changes; it answers 404 if the layer is gone or has no visible size. To publish, fetch it and upload the bytes, or hotlink it.`,
  }
}
