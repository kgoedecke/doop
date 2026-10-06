import type { ElementComment } from '../shared/types.ts'

/** The instance's public origin, for links that leave the browser: email,
 *  webhooks. BETTER_AUTH_URL is already the one URL every deploy must set. */
export const ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:4300'

export const canvasLink = (canvasId: string) => `${ORIGIN}/c/${canvasId}`

/** Stage honours ?frame= by zooming to that frame on arrival. */
export const frameLink = (canvasId: string, frameId: string) =>
  `${canvasLink(canvasId)}?frame=${encodeURIComponent(frameId)}`

/** Opens the canvas on the frame with the thread expanded. Always the ROOT's
 *  id (FrameView honours ?comment= for pins, and only roots have pins). */
export function commentLink(comment: ElementComment): string {
  const root = comment.parentId ?? comment.id
  return `${frameLink(comment.canvasId, comment.frameId)}&comment=${encodeURIComponent(root)}`
}

export const settingsLink = (pane: string) => `${ORIGIN}/settings?pane=${pane}`
