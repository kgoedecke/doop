import type { Frame } from '../../shared/types'
import { api } from './api'
import { useStore } from './store'
import { posthog } from './posthog'
import { recordCreate } from './history'

/**
 * World-space top-left for a new frame of the given size, centered in the
 * current viewport.
 *
 * Same math `pasteFrameCentered` (frameClipboard.ts) already uses for ⌘V,
 * pulled out so the toolbar's "Add frame" can use it too: a frame you add
 * lands where you're looking, instead of always at the right edge of the
 * canvas (which can be off-screen on a large board - see issue #98).
 */
export function frameCenterPosition(
  viewport: { x: number; y: number; zoom: number },
  viewportSize: { width: number; height: number },
  frameSize: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: (viewportSize.width / 2 - viewport.x) / viewport.zoom - frameSize.width / 2,
    y: (viewportSize.height / 2 - viewport.y) / viewport.zoom - frameSize.height / 2,
  }
}

/**
 * A new frame's default size. Written down once here and sent explicitly
 * with every create request below, so it can never quietly drift apart from
 * the placement math that centers around it - store.ts's own `?? 640` /
 * `?? 480` fallback exists only for callers that skip this helper (the MCP
 * tool, imports, etc.) and matches this value today, but the two used to be
 * two independent literals that happened to agree.
 */
export const DEFAULT_FRAME_SIZE = { width: 640, height: 480 } as const

/**
 * The viewport a new frame should center in: the Stage's own rendered size,
 * not the window's. The Stage sits below the top bar and any app inset, so
 * window.innerWidth/innerHeight over-counts by that chrome and pushes the
 * calculated center down - on a short window a 480px-tall frame can land
 * partly below the visible area. Same `.stage` query frameClipboard.ts's
 * `pasteFrameAtScreen` already uses to map a click into the canvas. Falls
 * back to the window if the Stage isn't mounted, which should not happen
 * from the entry points that call this.
 */
function stageViewportSize(): { width: number; height: number } {
  const rect = document.querySelector('.stage')?.getBoundingClientRect()
  return rect ? { width: rect.width, height: rect.height } : { width: window.innerWidth, height: window.innerHeight }
}

/**
 * Create a frame centered in the current view (issue #98), like Figma,
 * instead of always to the right of the right-most frame - which can be
 * off-screen on a large canvas. Pulled out of CanvasPage so the Stage-bounds
 * and viewport wiring driving "+ Frame" has something to test directly, the
 * same way frameClipboard.ts's paste helpers already do.
 */
export async function createCenteredFrame(canvasId: string, name: string, html: string): Promise<Frame> {
  const { x, y } = frameCenterPosition(useStore.getState().viewport, stageViewportSize(), DEFAULT_FRAME_SIZE)
  const frame = await api.createFrame(canvasId, { name, html, x, y, ...DEFAULT_FRAME_SIZE })
  posthog.capture('frame_created')
  recordCreate(frame)
  return frame
}
