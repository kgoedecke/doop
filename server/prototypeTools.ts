import { env } from './env.ts'
import * as actions from './actions.ts'
import { canvasPages, framePageId } from '../shared/pages.ts'
import { actionString, flowStartFrame, prototypeLinks, targetsFrame, triggerString } from '../shared/prototype.ts'
import type { Actor, Canvas, CanvasPageInfo } from '../shared/types.ts'

/**
 * The prototype tools every agent gets, whether it connects over MCP
 * (server/mcp.ts) or runs in the server (server/resident.ts): one reading of
 * the wiring and one way to move a page's flow start, so the two surfaces
 * cannot drift apart. Spec: .context/specs/prototyping.md.
 */

export function prototypeUrl(canvasId: string): string {
  return `${env.BETTER_AUTH_URL}/c/${canvasId}/proto`
}

/** Each page's flow start and every interaction, flagging targets that are not on the canvas. */
export function prototypeReport(canvas: Canvas) {
  const names = new Map(canvas.frames.map((f) => [f.id, f.name]))
  return {
    prototype_url: prototypeUrl(canvas.id),
    pages: canvasPages(canvas).map((page) => {
      const start = flowStartFrame(canvas, page.id)
      return {
        id: page.id,
        name: page.name,
        startFrameId: start?.id ?? null,
        startIsExplicit: !!page.startFrameId && page.startFrameId === start?.id,
      }
    }),
    interactions: prototypeLinks(canvas).map((link) => ({
      frameId: link.fromFrameId,
      frameName: names.get(link.fromFrameId),
      element: link.element,
      on: triggerString(link.interaction),
      action: actionString(link.interaction),
      ...(targetsFrame(link.interaction) ? { targetName: names.get(link.interaction.target) ?? null } : {}),
      transition: link.interaction.transition,
      duration: link.interaction.duration,
      ...(link.problem ? { problem: link.problem } : {}),
    })),
  }
}

export type FlowStartResult = { ok: true; pages: CanvasPageInfo[] } | { ok: false; error: string }

/**
 * Point a page's flow at a frame, or clear it with null. The page defaults to
 * the frame's own page (the first page when clearing); a frame on another
 * page, or one that does not exist, is refused.
 */
export function setPrototypeStart(
  canvas: Canvas,
  pageId: string | undefined,
  frameId: string | null,
  actor: Actor,
): FlowStartResult {
  const frame = frameId ? canvas.frames.find((f) => f.id === frameId) : undefined
  if (frameId && !frame)
    return { ok: false, error: `no frame ${frameId} on canvas ${canvas.id} — use a frame id from the canvas` }
  const pages = canvasPages(canvas)
  const page = pageId ?? (frame ? framePageId(canvas, frame) : pages[0]!.id)
  if (!pages.some((p) => p.id === page)) return { ok: false, error: `no page ${page} on canvas ${canvas.id}` }
  if (frame && framePageId(canvas, frame) !== page)
    return { ok: false, error: 'the start frame must be on the same page' }
  const saved = actions.setFlowStart(canvas.id, page, frame?.id ?? null, actor)
  if (!saved) return { ok: false, error: `canvas ${canvas.id} not found` }
  return { ok: true, pages: saved }
}
