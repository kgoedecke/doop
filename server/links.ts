import { env } from './env.ts'
import type { ElementComment } from '../shared/types.ts'

/** The instance's public origin, for links that leave the browser: email,
 *  webhooks. BETTER_AUTH_URL is already the one URL every deploy must set. */
export const ORIGIN = env.BETTER_AUTH_URL

export const canvasLink = (canvasId: string) => `${ORIGIN}/c/${canvasId}`

/** Stage honours ?frame= by zooming to that frame on arrival. */
export const frameLink = (canvasId: string, frameId: string) =>
  `${canvasLink(canvasId)}?frame=${encodeURIComponent(frameId)}`

/** Opens the canvas with the thread expanded: on its frame for an element
 *  comment, on its page for a canvas comment (Stage honours ?page= and flies
 *  to the pin). Always the ROOT's id (pins honour ?comment=, and only roots
 *  have pins). */
export function commentLink(comment: ElementComment): string {
  const root = comment.parentId ?? comment.id
  const page = comment.pageId ? `?page=${encodeURIComponent(comment.pageId)}&` : '?'
  const base = comment.frameId
    ? `${frameLink(comment.canvasId, comment.frameId)}&`
    : `${canvasLink(comment.canvasId)}${page}`
  return `${base}comment=${encodeURIComponent(root)}`
}

export const settingsLink = (pane: string) => `${ORIGIN}/settings?pane=${pane}`
