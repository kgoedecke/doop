import { and, eq, inArray, or, isNull } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import { workspaceMemberIds } from './workspaces.ts'
import { avatarUrl } from '../shared/avatar.ts'
import { resolvePersonMentions, type ResolvedMentions } from '../shared/personMentions.ts'
import type { Canvas, ElementComment } from '../shared/types.ts'
import { commentThread } from './actions.ts'

/** The people a comment on this canvas may @mention: everyone who has it for
 *  good (the owner, invited members, the members of its workspace). Share-link
 *  visitors are not listed: a link is not a membership, and their names would
 *  reach everyone else holding it. */
export function mentionableIds(canvas: Canvas): string[] {
  const ids = new Set<string>()
  if (canvas.ownerId) ids.add(canvas.ownerId)
  for (const id of canvas.memberIds ?? []) ids.add(id)
  if (canvas.workspaceId) for (const id of workspaceMemberIds(canvas.workspaceId)) ids.add(id)
  return [...ids]
}

export interface CanvasPerson {
  id: string
  name: string
  image?: string
}

/** Those people with their names and faces, banned accounts left out. */
export function mentionablePeople(canvas: Canvas): Promise<CanvasPerson[]> {
  return peopleByIds(mentionableIds(canvas))
}

async function peopleByIds(ids: string[]): Promise<CanvasPerson[]> {
  if (!ids.length) return []
  const rows = await db
    .select({ id: authSchema.user.id, name: authSchema.user.name, image: authSchema.user.image })
    .from(authSchema.user)
    .where(and(inArray(authSchema.user.id, ids), or(isNull(authSchema.user.banned), eq(authSchema.user.banned, false))))
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    if (!row) return []
    const image = avatarUrl(row.image)
    return [{ id, name: row.name, ...(image ? { image } : {}) }]
  })
}

/** Who a comment's text @mentions: the canvas's people and whoever already
 *  wrote in the thread (`authorIds`), each read by name against all of them
 *  before anything else is decided, so a name is never handed to a shorter
 *  one because its owner turned email off. `picked` is what the editor's
 *  picker chose, for a name several people share (an unknown id is ignored).
 *  Who is then actually told (the author, opt-outs, access) is the
 *  notifier's business. */
export async function resolveCommentMentions(
  canvas: Canvas,
  text: string,
  { authorIds = [], picked }: { authorIds?: readonly string[]; picked?: unknown } = {},
): Promise<ResolvedMentions> {
  if (!text.includes('@')) return { ids: [], roleText: text }
  try {
    const people = await peopleByIds([...new Set([...mentionableIds(canvas), ...authorIds])])
    return resolvePersonMentions(text, people, pickedIds(picked))
  } catch (err) {
    /* the comment still posts; nobody is emailed about a mention */
    console.error(`[comments] could not read the people on ${canvas.id}`, err)
    return { ids: [], roleText: text }
  }
}

/** Everyone a comment on this canvas may @mention, the thread's authors
 *  included; none when they cannot be read (nobody is then emailed). */
export async function commentPeople(canvas: Canvas, authorIds: readonly string[] = []): Promise<CanvasPerson[]> {
  try {
    return await peopleByIds([...new Set([...mentionableIds(canvas), ...authorIds])])
  } catch (err) {
    console.error(`[comments] could not read the people on ${canvas.id}`, err)
    return []
  }
}

/** The accounts that already wrote in a comment's thread. */
export function threadAuthorIds(comment: ElementComment): string[] {
  return commentThread(comment).flatMap((c) => (c.fromUserId ? [c.fromUserId] : []))
}

/** The ids a request sent as its picks, if they are a short list of strings. */
export function pickedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64).slice(0, 20)
}
