import { zipSync } from 'fflate'
import type { Frame } from '../../shared/types'
import {
  exportFileNames,
  exportSizeError,
  exportSelectionBounds,
  exportDimensions,
  type ExportOptions,
} from '../../shared/frameExport'

/** Fetch sequentially so a large selection never opens many render pages at once.
 * No download is offered until every selected frame has succeeded. */
export async function prepareFrameExport(
  frames: Frame[],
  options: ExportOptions,
  signal: AbortSignal,
  onProgress: (completed: number) => void = () => {},
): Promise<{ blob: Blob; name: string }> {
  if (!frames.length) throw new Error('Select at least one frame to export.')
  if (frames.length > 100) throw new Error('Export up to 100 frames at a time.')
  for (const frame of frames) {
    const error = exportSizeError(frame, options.scale)
    if (error) throw new Error(`${frame.name}: ${error}`)
  }
  const combined = options.mode === 'combined' && frames.length > 1
  const bounds = exportSelectionBounds(frames)
  if (combined) {
    const error = exportSizeError(bounds, options.scale)
    if (error) throw new Error(error)
  }
  const names = exportFileNames(frames, options.format)
  const files: Record<string, Uint8Array> = Object.create(null)
  let bytes = 0
  const canvas = combined ? document.createElement('canvas') : null
  const context = canvas?.getContext('2d')
  if (canvas) {
    if (!context) throw new Error('Image export is not supported in this browser.')
    const size = exportDimensions(bounds, options.scale)
    canvas.width = size.width
    canvas.height = size.height
    if (options.format === 'jpg') {
      context.fillStyle = '#fff'
      context.fillRect(0, 0, size.width, size.height)
    }
  }
  try {
    for (const [index, frame] of frames.entries()) {
      signal.throwIfAborted()
      const query = new URLSearchParams({ scale: String(options.scale), quality: String(options.quality) })
      // Composite lossless sources; apply JPG quality once, to the final image.
      const sourceFormat = combined ? 'png' : options.format
      const response = await fetch(`/i/${encodeURIComponent(frame.id)}.${sourceFormat}?${query}`, {
        signal,
        cache: 'no-store',
      })
      if (!response.ok) {
        const message =
          response.status === 429
            ? 'Too many renders. Wait a minute and retry.'
            : 'Could not render this frame. Please retry.'
        throw new Error(`${frame.name}: ${message}`)
      }
      if (!response.headers.get('Content-Type')?.startsWith(sourceFormat === 'jpg' ? 'image/jpeg' : 'image/png')) {
        throw new Error(`${frame.name}: The server did not return an image. Please retry.`)
      }
      const data = new Uint8Array(await response.arrayBuffer())
      bytes += data.byteLength
      if (bytes > 128 * 1024 * 1024)
        throw new Error('Export exceeds 128 MB. Select fewer frames or choose a lower scale.')
      if (context) {
        const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }))
        try {
          signal.throwIfAborted()
          const size = exportDimensions(frame, options.scale)
          context.drawImage(
            bitmap,
            Math.round((frame.x - bounds.x) * options.scale),
            Math.round((frame.y - bounds.y) * options.scale),
            size.width,
            size.height,
          )
        } finally {
          bitmap.close()
        }
      } else files[names[index]] = data
      onProgress(index + 1)
    }
    signal.throwIfAborted()
    if (canvas) {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error('Could not create the image. Try a lower scale.'))),
          options.format === 'jpg' ? 'image/jpeg' : 'image/png',
          options.quality / 100,
        ),
      )
      signal.throwIfAborted()
      return { blob, name: `selection.${options.format}` }
    }
    if (frames.length === 1) {
      return {
        blob: new Blob([files[names[0]] as Uint8Array<ArrayBuffer>], {
          type: options.format === 'jpg' ? 'image/jpeg' : 'image/png',
        }),
        name: names[0],
      }
    }
    // Images are already compressed; storing them avoids needless CPU work.
    return {
      blob: new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
      name: 'frames.zip',
    }
  } finally {
    if (canvas) canvas.width = canvas.height = 0
  }
}

export function downloadExport(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
