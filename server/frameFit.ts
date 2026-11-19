import { MAX_EXPORT_SIDE } from '../shared/exportScale.ts'
import type { Actor, Canvas, Frame } from '../shared/types.ts'
import * as actions from './actions.ts'
import { checkpoint } from './journal.ts'
import { runCanvasWrite } from './canvasWrites.ts'
import { checkFrameMeta, type FrameMetaPatch, type PageToolResult } from './pageTools.ts'
import { type ContentExtent, type ContentProbe, freshFrameOverflow, measureContent } from './screenshot.ts'
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
  'Sizes the frame to its content, measured in a browser, instead of guessing a size and checking screenshots. "height": the frame becomes as tall as its content at its width; parts sized in vh are laid out at the fitted height, and a design whose content always outgrows its viewport (a 100vh hero with more below) is refused. "width": the frame narrows to hug its content and never gets wider; for a component main, a badge or a card, not a screen, where a centred max-width layout would lose its side margins. "both": hugs the width, then fits the height at it, and hugs the width again at that height until the two agree. Each fitted axis is checked for document overflow on a fresh load before saving.'

/** fit_to_content's full description on each tool, the same for MCP agents and the resident. */
export const FIT_ON = {
  create: `${FIT_DESCRIPTION} width and height are where the measuring starts. If the fit cannot be made, the frame is still created and the result says why.`,
  set: `${FIT_DESCRIPTION} If the fit cannot be made, the new HTML still stands and the result says why.`,
  update: `${FIT_DESCRIPTION} "height" is measured at the new width, and "width" at the new height, when you pass one. Not with height when fitting the height, nor with width when fitting the width. If the fit cannot be made, nothing else in the call is applied either.`,
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
 *    content there and shrinks to it (searched from there when vh parts inside it still grow),
 *    a height:100vh one collapses and keeps its height. */
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
    if (!(floor > 1 && floor < from && clamp(tiny.flow) >= floor)) return { kind: 'fits', height: from }
    /* a box held at the viewport's height (border-box with padding, a vh child inside) spills out
       of it there, where a min-height wrapper grows with its content: that is a screen */
    const atFloor = await measure(floor)
    if (atFloor.spills > opening.spills) return { kind: 'fits', height: from }
    /* a floor that holds is the height; one whose content still grows with the viewport (vh parts
       inside the min-height wrapper) is where the search starts */
    point = { at: floor, content: Math.round(atFloor.painted) }
    if (point.content === floor) return { kind: 'fits', height: floor }
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
      const slope = reached.at > below.at ? (reached.content - below.content) / (reached.at - below.at) : 0
      /* content that grows with its frame is no taller in a frame of its own height, so the
         frame takes the height the content measured, not the step's rounded-up guess */
      if (slope > STEEPEST_FIT) return { kind: 'outgrows' }
      /* content that grows with the viewport may measure rounded up (600.5 at 601), and then fits a
         px lower exactly; content that does not grow is exact already */
      const height = clamp(reached.content)
      const lower = slope > 0 && height > 1 && height < FIT_HEIGHT_MAX ? await probe(height - 1) : undefined
      return { kind: 'fits', height: lower && lower.content === lower.at ? lower.at : height }
    }
    previous = point
    point = reached
  }
  return { kind: 'outgrows' }
}

/** CSS fit-content supplies the starting width. At narrower breakpoints the unmodified
 * document may overflow it. Only return a width that Chromium observed to fit. */
async function hugWidth(probe: ContentProbe, from: number, height: number): Promise<number> {
  let width = Math.min(from, designPx(await probe.width(from, height)))
  for (let attempt = 0; attempt < 6; attempt++) {
    const extra = (await probe.overflow(width, height)).width
    if (!extra) return width
    if (width >= from) break
    width = Math.min(from, width + extra)
  }
  throw new Error('Could not fit the content within the starting width. Set width explicitly.')
}

/** Releasing a viewport-tall body for the intrinsic estimate can collapse percentage children.
 * If the original CSS overflows at the estimate, bracket a passing height, then bisect. Both
 * loops are bounded by log2(FIT_HEIGHT_MAX). */
async function fitScrollableHeight(probe: ContentProbe, width: number, proposal: number): Promise<number> {
  const overflow = async (height: number) => (await probe.overflow(width, height)).height
  const extra = await overflow(proposal)
  if (!extra) return proposal
  let low = proposal
  let high = Math.min(proposal + extra, FIT_HEIGHT_MAX)
  while (high === low || (await overflow(high))) {
    if (high === FIT_HEIGHT_MAX)
      throw new Error(`The document still overflows at the ${FIT_HEIGHT_MAX}px export limit. Set height explicitly.`)
    low = high
    high = Math.min(high * 2, FIT_HEIGHT_MAX)
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    if (await overflow(mid)) low = mid
    else high = mid
  }
  return high
}

type FitSize = { width: number; height: number }

/** How many times "both" hugs the width and settles the height before giving up on them agreeing. */
const BOTH_PASSES = 3

const OUTGROWS =
  'this design grows with its frame (parts sized in vh, such as a 100vh hero, push the rest below the viewport at any height): set height instead, or size those parts in px'

/** The frame's size once fitted along `axes`, measured from `from` (the size the patch asks
 *  for, the frame's own where it asks none; the page loads at it too, so a script reading the
 *  viewport sees it): a width is hugged at that height, and a height settled at the fitted
 *  width. "both" hugs again at the settled height, since a height query or a vh width can lay
 *  the content out wider there, until a width and the height settled at it agree. */
async function measuredSize(frame: Frame, from: FitSize, axes: FitAxes): Promise<PageToolResult<FitSize>> {
  if (!frame.html.trim()) return { ok: false, error: FIT_NEEDS_HTML }
  if (!(Number.isFinite(from.width) && from.width > 0 && Number.isFinite(from.height) && from.height > 0))
    return { ok: false, error: 'A fit needs positive frame dimensions.' }
  const hug = (probe: ContentProbe, height: number) => hugWidth(probe, designPx(from.width), height)
  try {
    const candidate = await measureContent({ ...frame, ...from }, async (probe): Promise<PageToolResult<FitSize>> => {
      let width = fitsWidth(axes) ? await hug(probe, from.height) : from.width
      if (!fitsHeight(axes)) return { ok: true, value: { width, height: from.height } }
      let height = from.height
      for (let pass = 0; pass < BOTH_PASSES; pass++) {
        const settled = await settleHeight(height, (at) => probe.height(width, at))
        if (settled.kind !== 'fits') return { ok: false, error: OUTGROWS }
        height = await fitScrollableHeight(probe, width, settled.height)
        if (!fitsWidth(axes)) return { ok: true, value: { width, height } }
        const rehugged = await hug(probe, height)
        if (rehugged === width) return { ok: true, value: { width, height } }
        width = rehugged
      }
      return {
        ok: false,
        error: `the content's width and height keep changing each other (a height media query or a width in vh): pass width or height and fit the other side`,
      }
    })
    if (!candidate.ok) return candidate
    const extra = await freshFrameOverflow({ ...frame, ...candidate.value })
    if ((fitsWidth(axes) && extra.width) || (fitsHeight(axes) && extra.height))
      return {
        ok: false,
        error: 'The document still overflows when loaded at the fitted size. Set the dimensions explicitly.',
      }
    return candidate
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

/** The patch through the canvas write entry (server/canvasWrites.ts), as update_frame writes it. */
async function writeFrameMeta(
  canvas: Canvas,
  frameId: string,
  patch: FrameMetaPatch,
  actor: Actor,
): Promise<PageToolResult<Frame>> {
  return (
    (await runCanvasWrite(canvas.id, { type: 'frame-meta', frameId, patch, actor })) ?? {
      ok: false,
      error: `frame ${frameId} not found`,
    }
  )
}

/** update_frame, for agents on MCP and the resident agent: the patch written,
 *  and with `fit` the frame measured (at the patch's width and height, its own
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
    const updated = await writeFrameMeta(canvas, frameId, patch, actor)
    return updated.ok ? { ok: true, value: { frame: updated.value } } : updated
  }
  const clash = fitClash(patch, fit)
  if (clash) return { ok: false, error: clash }
  const checked = checkFrameMeta(canvas, patch, { allowEmpty: true })
  if (!checked.ok) return checked
  const measured = store.getFrame(frameId)
  if (!measured || measured.canvasId !== canvas.id) return { ok: false, error: `frame ${frameId} not found` }
  if (actions.isFrameMidStream(frameId))
    return { ok: false, error: 'the frame is still streaming: fit it once the stream is done' }
  const snapshot = { ...measured }
  const size = await measuredSize(
    snapshot,
    { width: patch.width ?? snapshot.width, height: patch.height ?? snapshot.height },
    fit,
  )
  if (!size.ok) return size
  const current = store.getFrame(frameId)
  if (!current || current.canvasId !== canvas.id) return { ok: false, error: `frame ${frameId} not found` }
  if (
    current.html !== snapshot.html ||
    current.width !== snapshot.width ||
    current.height !== snapshot.height ||
    actions.isFrameMidStream(frameId)
  )
    return {
      ok: false,
      error: 'the frame changed while it was measured: call update_frame with fit_to_content to fit what it is now',
    }
  /* only the sides measured: a fit at a size someone changes meanwhile is refused above */
  const fitted = {
    ...patch,
    ...(fitsWidth(fit) ? { width: size.value.width } : {}),
    ...(fitsHeight(fit) ? { height: size.value.height } : {}),
  }
  const updated = await writeFrameMeta(canvas, frameId, fitted, actor)
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
