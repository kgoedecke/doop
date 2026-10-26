/* Share-link roles, shared by the server's access gate and the editor's
   read-only mode. Spec: .context/specs/share-link-roles.md */

/** What a canvas's share link grants people who are not its owner, an
 *  invited member or a member of its workspace. */
export type LinkAccess = 'none' | 'view' | 'comment' | 'edit'

/** What one person may do on a canvas, from least to most. */
export type CanvasRole = 'view' | 'comment' | 'edit'

export const LINK_ACCESS_LEVELS: readonly LinkAccess[] = ['none', 'view', 'comment', 'edit']

const RANK: Record<CanvasRole, number> = { view: 0, comment: 1, edit: 2 }

export function isLinkAccess(value: unknown): value is LinkAccess {
  return typeof value === 'string' && (LINK_ACCESS_LEVELS as readonly string[]).includes(value)
}

/** A stored or legacy value read back as a level: anything unknown is 'none'. */
export function toLinkAccess(value: unknown): LinkAccess {
  return isLinkAccess(value) ? value : 'none'
}

/** The level as a canvas carries it: 'none' (private) is stored as unset. */
export function storedLinkAccess(value: unknown): Exclude<LinkAccess, 'none'> | undefined {
  const level = toLinkAccess(value)
  return level === 'none' ? undefined : level
}

/** Does `role` include everything `need` allows? */
export function roleAllows(role: CanvasRole | null | undefined, need: CanvasRole): boolean {
  return !!role && RANK[role] >= RANK[need]
}
