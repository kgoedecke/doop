import type { Actor, Canvas, Frame } from '../shared/types.ts'
import { isFrameMidStream } from './actions.ts'
import { checkpoint } from './journal.ts'
import { checkFrameMeta, type FrameMetaPatch, type PageToolResult, updateFrameMeta } from './pageTools.ts'
import { measureFrameHeight } from './screenshot.ts'
import { store } from './store.ts'

const description =
  'Set to "height" to fit the document’s scrollable content at the frame width. The server verifies the resulting height in Chromium.'
export const FIT_ON = {
  create: description + ' If fitting fails, the created frame keeps its starting size.',
  set: description + ' If fitting fails, the new HTML stays at the current size.',
  update:
    description +
    ' You can pass a new width in the same call. Omit height. If fitting fails the whole update is refused.',
}

export const FIT_NEEDS_HTML = 'Write the frame HTML before fitting its height.'

export function readHeightFit(value: unknown): PageToolResult<'height' | undefined> {
  return value === undefined || value === 'height'
    ? { ok: true, value }
    : { ok: false, error: 'fit_to_content must be "height"' }
}

export interface FittedFrame {
  frame: Frame
  note?: string
}

export function fitNotes(result?: FittedFrame): string[] {
  return result?.note ? [result.note] : []
}

export async function updateFrameMetaWithFit(
  canvas: Canvas,
  frameId: string,
  patch: FrameMetaPatch,
  fit: 'height' | undefined,
  actor: Actor,
): Promise<PageToolResult<FittedFrame>> {
  if (!fit) {
    const result = updateFrameMeta(canvas, frameId, patch, actor)
    return result.ok ? { ok: true, value: { frame: result.value } } : result
  }
  if (patch.height !== undefined) return { ok: false, error: 'Pass either height or fit_to_content.' }
  const checked = checkFrameMeta(canvas, patch, { allowEmpty: true })
  if (!checked.ok) return checked
  const frame = store.getFrame(frameId)
  if (!frame || frame.canvasId !== canvas.id) return { ok: false, error: 'frame not found on this canvas' }
  if (!frame.html.trim()) return { ok: false, error: FIT_NEEDS_HTML }
  if (isFrameMidStream(frameId)) return { ok: false, error: 'Fit the frame after its HTML stream finishes.' }

  const { html, width, height } = frame
  const measuringWidth = patch.width ?? width
  if (!(measuringWidth > 0 && Number.isFinite(measuringWidth)))
    return { ok: false, error: 'A fit needs a positive frame width.' }
  let fitted: number
  try {
    fitted = await measureFrameHeight({ ...frame, width: measuringWidth })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not measure the frame height.' }
  }
  const current = store.getFrame(frameId)
  if (
    current !== frame ||
    current.html !== html ||
    current.width !== width ||
    current.height !== height ||
    isFrameMidStream(frameId)
  ) {
    return { ok: false, error: 'The frame changed while it was measured. Retry after the edit finishes.' }
  }
  const updated = updateFrameMeta(canvas, frameId, { ...checked.value, height: fitted }, actor)
  return updated.ok
    ? { ok: true, value: { frame: updated.value, note: `fit_to_content: the frame is now ${fitted}px tall.` } }
    : updated
}

export async function fitWrittenFrame(frame: Frame, actor: Actor): Promise<FittedFrame> {
  // Deliver the design before awaiting a render slot. A failed fit keeps the write.
  checkpoint()
  const canvas = store.getCanvas(frame.canvasId)
  const fit = canvas
    ? await updateFrameMetaWithFit(canvas, frame.id, {}, 'height', actor)
    : { ok: false as const, error: 'Canvas was deleted.' }
  return fit.ok
    ? fit.value
    : { frame: store.getFrame(frame.id) ?? frame, note: `fit_to_content was not applied: ${fit.error}` }
}
