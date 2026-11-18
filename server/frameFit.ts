import type { Frame } from '../shared/types.ts'
import type { PageToolResult } from './pageTools.ts'
import { measureContentHeight } from './screenshot.ts'

/**
 * `fit_height` on update_frame, create_frame and set_frame_html (MCP and the
 * resident agent): the frame's height becomes its content's, measured in the
 * server's Chromium, instead of an agent guessing and screenshotting until
 * nothing is cut off (#532).
 */

/** The tallest a fit makes a frame: the export limit's side, past which a
 *  render is cut anyway. */
export const FIT_HEIGHT_MAX = 16_384

export interface FittedHeight {
  height: number
  /** the content's own height, when it is taller than FIT_HEIGHT_MAX */
  cappedFrom?: number
}

/** The height that shows all of `frame`'s content at `width` (its own width
 *  when left out, since text wraps by it). */
export async function fittedHeight(frame: Frame, width: number = frame.width): Promise<PageToolResult<FittedHeight>> {
  if (!frame.html.trim())
    return { ok: false, error: 'fit_height needs HTML in the frame: stream it in first, then call update_frame' }
  let content: number
  try {
    content = await measureContentHeight({ ...frame, width })
  } catch (e) {
    return { ok: false, error: `could not measure the frame: ${e instanceof Error ? e.message : String(e)}` }
  }
  const height = Math.min(Math.max(1, content), FIT_HEIGHT_MAX)
  return { ok: true, value: height < content ? { height, cappedFrom: content } : { height } }
}

/** What a tool result says about a fit. */
export function fitNote(fit: FittedHeight): string {
  return fit.cappedFrom
    ? `fit_height: the content is ${fit.cappedFrom}px tall; the frame stops at ${FIT_HEIGHT_MAX}px`
    : `fit_height: the frame is now ${fit.height}px tall, its content's height`
}
