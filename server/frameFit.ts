import { MAX_EXPORT_SIDE } from '../shared/exportScale.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import * as actions from './actions.ts'
import { checkpoint } from './journal.ts'
import { checkFrameMeta, type FrameMetaPatch, type PageToolResult, updateFrameMeta } from './pageTools.ts'
import { type ContentMeasure, measureContentHeight } from './screenshot.ts'
import { store } from './store.ts'

/**
 * `fit_height` on update_frame, create_frame and set_frame_html, for agents on
 * MCP and the resident agent alike: the frame's height becomes its content's,
 * measured in the server's Chromium, instead of an agent guessing and
 * screenshotting until nothing is cut off (#532).
 */

/** The tallest a fit makes a frame: the export limit's side, past which a render is cut anyway. */
export const FIT_HEIGHT_MAX = MAX_EXPORT_SIDE

/** What every tool taking fit_height tells the agent about it. */
export const FIT_HEIGHT_DESCRIPTION =
  "true sets the frame's height to its content's, measured in a browser at the frame's width, instead of guessing a height and checking screenshots. Parts sized in vh are laid out at the fitted height; a design whose content always outgrows its viewport (a 100vh hero with more below) cannot be fitted and is refused."

/** Why there is nothing to fit yet: a frame with no design, such as one a stream is about to fill. */
export const FIT_NEEDS_HTML =
  'fit_height needs the design in the frame: write or stream it in first, then call update_frame with fit_height'

export interface FittedFrame {
  frame: Frame
  /** what the result tells the agent about the fit, when one was asked for */
  note?: string
}

/** A fit's outcome before anything is written. */
type Settled = { kind: 'fits'; height: number } | { kind: 'outgrows' }

/** The height a design settles at: content that does not depend on the
 *  viewport is measured once and confirmed. A design sized in vh grows or
 *  shrinks with the frame (content = a + b × height), so its fixed point is
 *  solved from two measures and confirmed with a third; with b ≥ 1 (a
 *  100vh hero above anything else) no height holds all of it. Content that
 *  fills the frame exactly is either a floor or sized by the viewport alone,
 *  told apart at a 1px viewport: a min-height:100vh wrapper around less still
 *  flows to its content there and shrinks to it, while an app shell at
 *  height:100vh collapses and only its overflow is left, so it keeps its height. */
export async function settleHeight(start: number, measure: ContentMeasure): Promise<Settled> {
  const clamp = (height: number) => Math.min(Math.max(1, Math.round(height)), FIT_HEIGHT_MAX)
  const painted = async (viewport: number) => clamp((await measure(viewport)).painted)
  const from = clamp(start)
  const first = await painted(from)
  if (first === from) {
    const tiny = await measure(1)
    const floor = clamp(tiny.painted)
    const shrinks = floor > 1 && floor < from && clamp(tiny.flow) >= floor && (await painted(floor)) === floor
    return { kind: 'fits', height: shrinks ? floor : from }
  }
  const second = await painted(first)
  if (second === first) return { kind: 'fits', height: first }
  const slope = (second - first) / (first - from)
  if (slope >= 1) return { kind: 'outgrows' }
  const solved = clamp(Math.ceil((first - slope * from) / (1 - slope)))
  const check = await painted(solved)
  return Math.abs(check - solved) <= 1 ? { kind: 'fits', height: Math.max(check, solved) } : { kind: 'outgrows' }
}

async function measuredHeight(frame: Frame, width: number): Promise<PageToolResult<number>> {
  if (!frame.html.trim()) return { ok: false, error: FIT_NEEDS_HTML }
  try {
    const settled = await measureContentHeight({ ...frame, width }, (measure) => settleHeight(frame.height, measure))
    return settled.kind === 'fits'
      ? { ok: true, value: settled.height }
      : {
          ok: false,
          error:
            'this design grows with its frame (parts sized in vh, such as a 100vh hero, push the rest below the viewport at any height): set height instead, or size those parts in px',
        }
  } catch (e) {
    return { ok: false, error: `could not measure the frame: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function fitNote(height: number): string {
  return height === FIT_HEIGHT_MAX
    ? `fit_height: the content is at least ${FIT_HEIGHT_MAX}px tall; the frame stops there, the export limit`
    : `fit_height: the frame is now ${height}px tall, its content's height`
}

/** update_frame, for agents on MCP and the resident agent: `updateFrameMeta`,
 *  and with `fitHeight` the frame measured at the patch's width (its own when
 *  the patch has none) and the height written with the rest of the patch. The
 *  patch is checked before the browser is asked; a fit is refused while an
 *  agent streams into the frame and when its design changed during the
 *  measurement, and a refused fit applies none of the patch. */
export async function updateFrameMetaWithFit(
  canvas: Canvas,
  frameId: string,
  patch: FrameMetaPatch,
  fitHeight: boolean,
  actor: Actor,
): Promise<PageToolResult<FittedFrame>> {
  if (!fitHeight) {
    const updated = updateFrameMeta(canvas, frameId, patch, actor)
    return updated.ok ? { ok: true, value: { frame: updated.value } } : updated
  }
  if (patch.height !== undefined) return { ok: false, error: 'pass either height or fit_height, not both' }
  const checked = checkFrameMeta(canvas, patch, { allowEmpty: true })
  if (!checked.ok) return checked
  const measured = store.getFrame(frameId)
  if (!measured) return { ok: false, error: `frame ${frameId} not found` }
  if (actions.isFrameMidStream(frameId))
    return { ok: false, error: 'the frame is still streaming: fit it once the stream is done' }
  const snapshot = { ...measured }
  const width = patch.width ?? snapshot.width
  const height = await measuredHeight(snapshot, width)
  if (!height.ok) return height
  const current = store.getFrame(frameId)
  if (!current || current.canvasId !== canvas.id) return { ok: false, error: `frame ${frameId} not found` }
  if (current.html !== snapshot.html || (patch.width === undefined && current.width !== snapshot.width))
    return {
      ok: false,
      error: 'the frame changed while it was measured: call update_frame with fit_height to fit what it is now',
    }
  const updated = updateFrameMeta(canvas, frameId, { ...patch, height: height.value }, actor)
  return updated.ok ? { ok: true, value: { frame: updated.value, note: fitNote(height.value) } } : updated
}

/** create_frame and set_frame_html with `fit_height`: the write is committed
 *  first, so viewers get it while the browser measures, then the frame is
 *  fitted. A fit that cannot be made leaves the write as it is and says why. */
export async function fitWrittenFrame(frame: Frame, actor: Actor): Promise<FittedFrame> {
  checkpoint()
  const canvas = store.getCanvas(frame.canvasId)
  const fitted = canvas
    ? await updateFrameMetaWithFit(canvas, frame.id, {}, true, actor)
    : { ok: false as const, error: 'the canvas is gone' }
  return fitted.ok
    ? fitted.value
    : { frame: store.getFrame(frame.id) ?? frame, note: `fit_height was not applied: ${fitted.error}` }
}
