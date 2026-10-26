import type { Canvas, ClientMessage } from '../shared/types.ts'
import { roleAllows, type CanvasRole } from '../shared/canvasRole.ts'
import { hasRole, isWorkspaceMember } from './workspaces.ts'

/**
 * Canvas access, Figma-style: private by default. The owner always has
 * access; invited members (canvas_members) always have access; so does
 * every member of the workspace a canvas lives in; everyone else gets in
 * only through the share link, at the level its owner set (linkAccess
 * 'view' | 'comment' | 'edit' — unset means 'none').
 * Ownerless (pre-auth/legacy) canvases stay open so they can be claimed.
 *
 * Every canvas-scoped surface — REST, the WS join, MCP tools — must gate
 * through canvasRole and the three helpers built on it: canAccessCanvas
 * (read), canCommentCanvas and canEditCanvas. A write gated on read alone
 * hands a view link edit rights.
 */
/**
 * Instance admins. Deliberately NOT consulted by canAccessCanvas: that gate
 * is shared with MCP, so an admin branch there would hand every agent holding
 * an admin's OAuth token read/write on every canvas in the instance. Admins
 * get their own routes (server/admin.ts), and reach a specific canvas by
 * impersonating its owner — which goes through the gate below as that owner,
 * leaving session.impersonatedBy behind as the audit trail.
 */
export function isAdmin(user: { role?: string | null } | undefined): boolean {
  return user?.role === 'admin'
}

/** What this user may do on this canvas, or null for no access at all. The
 *  owner, invited members and workspace members edit; anyone else gets the
 *  share link's level. */
export function canvasRole(userId: string | undefined, canvas: Canvas): CanvasRole | null {
  if (!canvas.ownerId) return 'edit'
  if (!userId) return null
  if (hasDurableCanvasAccess(userId, canvas)) return 'edit'
  const link = canvas.linkAccess
  return link === 'view' || link === 'comment' || link === 'edit' ? link : null
}

/** May this user read the canvas (open it, join its room, see its frames)? */
export function canAccessCanvas(userId: string | undefined, canvas: Canvas): boolean {
  return canvasRole(userId, canvas) !== null
}

/** May this user comment, reply, resolve and react? */
export function canCommentCanvas(userId: string | undefined, canvas: Canvas): boolean {
  return roleAllows(canvasRole(userId, canvas), 'comment')
}

/** May this user change the canvas: frames, pages, docs, assets, imports,
 *  agent work, approvals, versions? */
export function canEditCanvas(userId: string | undefined, canvas: Canvas): boolean {
  return roleAllows(canvasRole(userId, canvas), 'edit')
}

/** Durable access only: the owner, invited members and workspace members —
 *  NOT share-link visitors at any level. Gates anything that would outlive the visit itself, like
 *  design-sync keys: a bearer secret minted or read through a share link
 *  would keep writing frames long after the owner turns the link off. */
export function hasDurableCanvasAccess(userId: string | undefined, canvas: Canvas): boolean {
  if (!userId || !canvas.ownerId) return false
  if (canvas.ownerId === userId || !!canvas.memberIds?.includes(userId)) return true
  return !!canvas.workspaceId && isWorkspaceMember(canvas.workspaceId, userId)
}

/** Who may delete a canvas, or move it out of its workspace: its owner,
 *  and the owner/admins of the workspace it lives in — the org keeps
 *  control of the work done in its space. */
export function canManageCanvas(userId: string | undefined, canvas: Canvas): boolean {
  if (!userId) return false
  if (canvas.ownerId === userId) return true
  return !!canvas.workspaceId && hasRole(canvas.workspaceId, userId, 'admin')
}

/** The role an inbound room (WebSocket) message needs: cursors and viewports
 *  for anyone who can read, anything that marks or moves a frame for editors
 *  only. Unknown messages need edit, so a new type is closed until placed. */
export function roomMessageNeeds(msg: ClientMessage): CanvasRole {
  switch (msg.type) {
    case 'join':
    case 'cursor':
    case 'viewport':
      return 'view'
    case 'editing':
    case 'frame:drag':
      return 'edit'
    default:
      return 'edit'
  }
}
