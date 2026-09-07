import type { Frame } from './types'

export const EXPORT_SCALES = [0.5, 1, 2, 3, 4] as const
export type ExportScale = (typeof EXPORT_SCALES)[number]
export type ExportFormat = 'png' | 'jpg'
export interface ExportOptions {
  format: ExportFormat
  scale: ExportScale
  quality: number
  mode?: 'separate' | 'combined'
}

export function parseExportScale(value: unknown): ExportScale {
  const scale = Number(value)
  return EXPORT_SCALES.includes(scale as ExportScale) ? (scale as ExportScale) : 1
}

export function exportDimensions(frame: Pick<Frame, 'width' | 'height'>, scale: ExportScale) {
  return {
    width: Math.max(1, Math.round(Math.round(frame.width) * scale)),
    height: Math.max(1, Math.round(Math.round(frame.height) * scale)),
  }
}

/** Bound raster allocation before opening a Chromium page. */
export function exportSizeError(frame: Pick<Frame, 'width' | 'height'>, scale: ExportScale): string | null {
  const { width, height } = exportDimensions(frame, scale)
  return !Number.isFinite(width * height) || width > 32768 || height > 32768 || width * height > 64_000_000
    ? 'Export is too large. Choose a lower scale or reduce the frame size (maximum 64 megapixels and 32,768 px per side).'
    : null
}

export function exportFileNames(frames: Pick<Frame, 'name'>[], format: ExportFormat): string[] {
  const used = new Set<string>()
  return frames.map((frame) => {
    const base =
      frame.name
        // eslint-disable-next-line no-control-regex -- File names cannot contain control characters.
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
        .replace(/^\.+|[. ]+$/g, '')
        .trim()
        .slice(0, 100) || 'frame'
    let name = `${base}.${format}`
    let suffix = 2
    while (used.has(name.toLowerCase())) name = `${base} (${suffix++}).${format}`
    used.add(name.toLowerCase())
    return name
  })
}

/** The same world-coordinate bounds used by the canvas, including gaps. */
export function exportSelectionBounds(frames: Pick<Frame, 'x' | 'y' | 'width' | 'height'>[]) {
  if (!frames.length) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.min(...frames.map((f) => f.x))
  const y = Math.min(...frames.map((f) => f.y))
  return {
    x,
    y,
    width: Math.ceil(Math.max(...frames.map((f) => f.x + f.width)) - x),
    height: Math.ceil(Math.max(...frames.map((f) => f.y + f.height)) - y),
  }
}
