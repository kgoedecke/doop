import { FREE_UPLOAD_BYTES, PRO_UPLOAD_BYTES } from '../shared/billing.ts'
import type { FontScope } from '../shared/fonts.ts'
import { billingEnabled } from './billing.ts'
import { store } from './store.ts'
import { getWorkspace, isActive, planFor } from './workspaces.ts'

/**
 * What the Pro plan adds beyond a shared workspace: bigger uploads and an
 * unlimited font library. Pro is a workspace subscription, so a perk applies
 * where the work happens in a paid workspace, and to anyone who belongs to
 * one, on their personal canvases too. A server without billing gives
 * everyone everything, as it does workspaces.
 */

/** Whether a person is on Pro: a member of a live paid workspace. */
export function isProUser(userId: string | undefined): boolean {
  if (!billingEnabled()) return true
  return !!userId && planFor(userId) === 'team'
}

function isProWorkspace(workspaceId: string | null | undefined): boolean {
  if (!workspaceId) return false
  const workspace = getWorkspace(workspaceId)
  return !!workspace && isActive(workspace)
}

/** The largest image a person may upload to a canvas. */
export function uploadLimit(input: { canvasId?: string; userId?: string }): number {
  if (isProUser(input.userId)) return PRO_UPLOAD_BYTES
  const canvas = input.canvasId ? store.getCanvas(input.canvasId) : undefined
  return isProWorkspace(canvas?.workspaceId) ? PRO_UPLOAD_BYTES : FREE_UPLOAD_BYTES
}

/** Whether a font library may grow past the Free plan's families. */
export function unlimitedFonts(scope: FontScope, userId: string): boolean {
  if (!billingEnabled()) return true
  return 'workspaceId' in scope ? isProWorkspace(scope.workspaceId) : isProUser(userId)
}

const MB = 1024 * 1024

/** What follows a Free limit in a refusal: what Pro allows. */
function proNote(limit: number): string {
  return limit < PRO_UPLOAD_BYTES ? ` on the Free plan; Pro uploads up to ${PRO_UPLOAD_BYTES / MB} MB` : ''
}

/** The cap createAsset applies to one person's upload, and its refusals:
 *  `message` for a file of known size, `exceeded` for a stream cut short. */
export function uploadCap(input: { canvasId?: string; userId?: string }) {
  const bytes = uploadLimit(input)
  return {
    bytes,
    message: (size: number) => `file is ${(size / MB).toFixed(1)} MB — the limit is ${bytes / MB} MB${proNote(bytes)}`,
    exceeded: `file exceeds the ${bytes / MB} MB limit${proNote(bytes)}`,
  }
}
