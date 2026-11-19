import { MAX_EXPORT_SIDE } from '../shared/exportScale.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import * as actions from './actions.ts'
import { checkpoint } from './journal.ts'
import { checkFrameMeta, type FrameMetaPatch, type PageToolResult, updateFrameMeta } from './pageTools.ts'
import { type ContentExtent, type ContentProbe, measureContent } from './screenshot.ts'
import { designPx } from './renderLimits.ts'
import { store } from './store.ts'

/**
 * `fit_to_content` on update_frame, create_frame and set_frame_html, for agents
 * on MCP and the resident agent alike: the frame takes its content's size,
 * measured in the server's Chromium, instead of an agent guessing and
 * screenshotting until nothing is cut off (#532). "height" fits the height at
 * the frame's width; "width" hugs, as a Figma frame does, so it suits a
 * component or a card, never a screen; "both" hugs and then fits the height.
 */

/** Which sides fit_to_content fits. */
export const FIT_AXES = ['height', 'width', 'both'] as const
export type FitAxes = (typeof FIT_AXES)[number]

/** The tallest a fit makes a frame: the export limit's side, past which a render is cut anyway. */
export const FIT_HEIGHT_MAX = MAX_EXPORT_SIDE

/** What every tool taking fit_to_content tells the agent about it. */
const FIT_DESCRIPTION =
  'Sizes the frame to its content, measured in a browser, instead of guessing a size and checking screenshots. "height": the frame becomes as tall as its content at its width; parts sized in vh are laid out at the fitted height, and a design whose content always outgrows its viewport (a 100vh hero with more below) is refused. "width": the frame narrows to hug its content and never gets wider; for a component main, a badge or a card, not a screen, where a centred max-width layout would lose its side margins. "both": hugs the width, then fits the height at it.'

/** fit_to_content's full description on each tool, the same for MCP agents and the resident. */
export const FIT_ON = {
  create: `${FIT_DESCRIPTION} width and height are where the measuring starts. If the fit cannot be made, the frame is still created and the result says why.`,
  set: `${FIT_DESCRIPTION} If the fit cannot be made, the new HTML still stands and the result says why.`,
  update: `${FIT_DESCRIPTION} "height" is measured at the new width when you pass one. Not with height when fitting the height, nor with width when fitting the width. If the fit cannot be made, nothing else in the call is applied either.`,
}

/** Why there is nothing to fit yet: a frame with no design, such as one a stream is about to fill. */
export const FIT_NEEDS_HTML =
  'fit_to_content needs the design in the frame: write or stream it in first, then call update_frame with fit_to_content'

/** fit_to_content as an agent sent it: left out, one of FIT_AXES, or refused. */
export function readFitAxes(value: unknown): PageToolResult<FitAxes | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  return FIT_AXES.some((axes) => axes === value)
    ? { ok: true, value: value as FitAxes }
    : { ok: false, error: 'fit_to_content must be "height", "width" or "both"' }
}

const fitsHeight = (axes: FitAxes) => axes !== 'width'
const fitsWidth = (axes: FitAxes) => axes !== 'height'

/** The content's height measured with the viewport `viewportHeight` tall, at the width being fitted. */
export type HeightMeasure = (viewportHeight: number) => Promise<Omit<ContentExtent, 'right'>>

export interface FittedFrame {
  frame: Frame
  /** what the result tells the agent about the fit, when one was asked for */
  note?: string
}

/** A fit's outcome before anything is written. */
type Settled = { kind: 'fits'; height: number } | { kind: 'outgrows' }

/** Measures a design may take to settle, the slope check included: well inside one render's deadline. */
const MAX_MEASURES = 9

/** The steepest a design may grow with its frame at its fitted height and still fit: a 50vh
 *  hero over 300px fits at 600, while an 80vh one over 1000px would only hold at 5000px, the hero
 *  4000px tall, which is a design to size in px rather than a fit. Above 0.5, so pixel rounding
 *  cannot tip a 50vh part over. */
const STEEPEST_FIT = 0.6

interface Probe {
  /** the viewport height measured at */
  at: number
  /** the painted height measured, uncapped: a design still growing past FIT_HEIGHT_MAX shows it */
  content: number
}

/** Where the line through two probes meets content = height, when it does (slope below 1). */
function secantStep(a: Probe, b: Probe): number | undefined {
  const slope = (b.content - a.content) / (b.at - a.at)
  if (!Number.isFinite(slope) || slope >= 1) return undefined
  return Math.ceil((b.content - slope * b.at) / (1 - slope))
}

/** The height a design settles at, the frame's height that its content fills.
 *  - Content that does not depend on the viewport is measured once and confirmed.
 *  - A design sized in vh, plain or inside clamp(), max() or min-height, changes with the
 *    frame, so the height is iterated (each measure feeding the next, sped up along the line
 *    through the last two) until a measure holds. Where it holds, the growth is measured over
 *    a wide span below (a few px would read rounding as slope): one that keeps outgrowing the
 *    frame (a 100vh hero with more below, past the cap too) or grows steeply with it is refused.
 *  - An app shell (a viewport-tall page whose content scrolls inside it) keeps its height.
 *  - Content that fills the frame exactly is either a floor or sized by the viewport alone,
 *    told apart at a 1px viewport: a min-height:100vh wrapper around less still flows to its
 *    content there and shrinks to it, a height:100vh one collapses and keeps its height. */
export async function settleHeight(start: number, measure: HeightMeasure): Promise<Settled> {
  const clamp = (height: number) => Math.min(designPx(height), FIT_HEIGHT_MAX)
  const probe = async (at: number): Promise<Probe> => ({ at, content: Math.round((await measure(at)).painted) })
  const from = clamp(start)
  const opening = await measure(from)
  if (opening.shell) return { kind: 'fits', height: from }
  let point: Probe = { at: from, content: Math.round(opening.painted) }
  if (point.content === from) {
    const tiny = await measure(1)
    const floor = clamp(tiny.painted)
    const shrinks = floor > 1 && floor < from && clamp(tiny.flow) >= floor && (await probe(floor)).content === floor
    return { kind: 'fits', height: shrinks ? floor : from }
  }
  let previous: Probe | undefined
  for (let measures = 2; measures < MAX_MEASURES; measures++) {
    const step = previous && secantStep(previous, point)
    const next = clamp(step !== undefined && step !== point.at ? step : point.content)
    const reached = await probe(next)
    /* held: the content fits the frame with a px to spare at most (taller would clip it), or it
       passes the export limit, where the frame stops */
    const holds =
      (reached.content <= next && next - reached.content <= 1) || (next === FIT_HEIGHT_MAX && reached.content > next)
    if (holds) {
      const below = await probe(Math.max(1, next - Math.max(100, Math.round(next / 4))))
      const slope = (reached.content - below.content) / (reached.at - below.at)
      /* content that grows with its frame is no taller in a frame of its own height, so the
         frame takes the height the content measured, not the step's rounded-up guess */
      return slope > STEEPEST_FIT ? { kind: 'outgrows' } : { kind: 'fits', height: clamp(reached.content) }
    }
    previous = point
    point = reached
  }
  return { kind: 'outgrows' }
}

/** The width the content hugs to, never past `from`. Measured again at the hugged width, since
 *  a media query there may lay the content out wider; the wider of the two holds it. */
async function hugWidth(probe: ContentProbe, from: number, height: number): Promise<number> {
  const first = designPx(Math.min(await probe.width(from, height), from))
  if (first >= from) return from
  const second = designPx(await probe.width(first, height))
  return Math.min(from, Math.max(first, second))
}

type FitSize = { width: number; height: number }

async function measuredSize(frame: Frame, width: number, axes: FitAxes): Promise<PageToolResult<FitSize>> {
  if (!frame.html.trim()) return { ok: false, error: FIT_NEEDS_HTML }
  try {
    const fitted = await measureContent(frame, async (probe): Promise<PageToolResult<FitSize>> => {
      const fittedWidth = fitsWidth(axes) ? await hugWidth(probe, designPx(width), frame.height) : width
      if (!fitsHeight(axes)) return { ok: true, value: { width: fittedWidth, height: frame.height } }
      const settled = await settleHeight(frame.height, (height) => probe.height(fittedWidth, height))
      return settled.kind === 'fits'
        ? { ok: true, value: { width: fittedWidth, height: settled.height } }
        : {
            ok: false,
            error:
              'this design grows with its frame (parts sized in vh, such as a 100vh hero, push the rest below the viewport at any height): set height instead, or size those parts in px',
          }
    })
    return fitted
  } catch (e) {
    return { ok: false, error: `could not measure the frame: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** What a create or set result says about its fit, if one was asked for. */
export function fitNotes(fit: FittedFrame | undefined): string[] {
  return fit?.note ? [fit.note] : []
}

function fitNote(axes: FitAxes, { width, height }: FitSize): string {
  const capped = fitsHeight(axes) && height === FIT_HEIGHT_MAX
  const size = axes === 'height' ? `${height}px tall` : axes === 'width' ? `${width}px wide` : `${width}x${height}px`
  return capped
    ? `fit_to_content: the content is at least ${FIT_HEIGHT_MAX}px tall; the frame stops there, the export limit, and is now ${size}`
    : `fit_to_content: the frame is now ${size}, its content's size`
}

/** Why a patch cannot be fitted as asked: it sets a side the fit would measure. */
function fitClash(patch: FrameMetaPatch, axes: FitAxes): string | null {
  if (fitsHeight(axes) && patch.height !== undefined) return `pass either height or fit_to_content "${axes}", not both`
  if (fitsWidth(axes) && patch.width !== undefined) return `pass either width or fit_to_content "${axes}", not both`
  return null
}

/** update_frame, for agents on MCP and the resident agent: `updateFrameMeta`,
 *  and with `fit` the frame measured (the height at the patch's width, its own
 *  when the patch has none) and the fitted size written with the rest of the
 *  patch. The patch is checked before the browser is asked; a fit is refused
 *  while an agent streams into the frame and when its design changed during
 *  the measurement, and a refused fit applies none of the patch. */
export async function updateFrameMetaWithFit(
  canvas: Canvas,
  frameId: string,
  patch: FrameMetaPatch,
  fit: FitAxes | undefined,
  actor: Actor,
): Promise<PageToolResult<FittedFrame>> {
  if (!fit) {
    const updated = updateFrameMeta(canvas, frameId, patch, actor)
    return updated.ok ? { ok: true, value: { frame: updated.value } } : updated
  }
  const clash = fitClash(patch, fit)
  if (clash) return { ok: false, error: clash }
  const checked = checkFrameMeta(canvas, patch, { allowEmpty: true })
  if (!checked.ok) return checked
  const measured = store.getFrame(frameId)
  if (!measured) return { ok: false, error: `frame ${frameId} not found` }
  if (actions.isFrameMidStream(frameId))
    return { ok: false, error: 'the frame is still streaming: fit it once the stream is done' }
  const snapshot = { ...measured }
  const size = await measuredSize(snapshot, patch.width ?? snapshot.width, fit)
  if (!size.ok) return size
  const current = store.getFrame(frameId)
  if (!current || current.canvasId !== canvas.id) return { ok: false, error: `frame ${frameId} not found` }
  if (current.html !== snapshot.html || (patch.width === undefined && current.width !== snapshot.width))
    return {
      ok: false,
      error: 'the frame changed while it was measured: call update_frame with fit_to_content to fit what it is now',
    }
  /* only the sides measured: a height fit at a width someone changes meanwhile is refused above */
  const fitted = {
    ...patch,
    ...(fitsWidth(fit) ? { width: size.value.width } : {}),
    ...(fitsHeight(fit) ? { height: size.value.height } : {}),
  }
  const updated = updateFrameMeta(canvas, frameId, fitted, actor)
  return updated.ok ? { ok: true, value: { frame: updated.value, note: fitNote(fit, size.value) } } : updated
}

/** create_frame and set_frame_html with `fit_to_content`: the write is
 *  committed first, so viewers get it while the browser measures, then the
 *  frame is fitted. A fit that cannot be made leaves the write as it is and
 *  says why. */
export async function fitWrittenFrame(frame: Frame, fit: FitAxes, actor: Actor): Promise<FittedFrame> {
  checkpoint()
  const canvas = store.getCanvas(frame.canvasId)
  const fitted = canvas
    ? await updateFrameMetaWithFit(canvas, frame.id, {}, fit, actor)
    : { ok: false as const, error: 'the canvas is gone' }
  return fitted.ok
    ? fitted.value
    : { frame: store.getFrame(frame.id) ?? frame, note: `fit_to_content was not applied: ${fitted.error}` }
}
