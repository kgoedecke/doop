import * as actions from './actions.ts'
import { store } from './store.ts'
import { workspaceMemberIds } from './workspaces.ts'
import { canAccessCanvas } from './access.ts'
import { mailerConfigured, sendMail } from './mailer.ts'
import { mailableForComments, type Mailable } from './notificationPrefs.ts'
import { commentLink, settingsLink } from './links.ts'
import type { CanvasEvent } from './events.ts'
import type { ActorKind, Canvas, ElementComment } from '../shared/types.ts'

/**
 * Comment email: tells the people a canvas is shared with about comments and
 * replies they were not in the room to see. Listens to the canvas event bus
 * (server/events.ts), so REST and MCP comments both count.
 *
 * Who: the owner, invited members, the members of the canvas's workspace, and
 * everyone who already wrote in the thread — minus the person who just wrote,
 * and minus anyone who can no longer open the canvas by the time it sends.
 * An agent's reply is news to everyone, including the account whose key or
 * session ran the agent: that account did not type the words.
 *
 * When: not instantly. A review session is a burst of comments, so each
 * recipient's mail for a canvas is held for COALESCE_MS and sent as one
 * message. Held mail is in memory only — a restart during the window drops
 * it, which is acceptable for a courtesy email and keeps this state-free.
 *
 * Requires SMTP (server/mailer.ts). Without it nothing is queued: an email
 * nobody receives is not worth logging on every comment.
 */

export const COALESCE_MS = 2 * 60_000

export interface PendingComment {
  comment: ElementComment
  frameName: string
  actorKind: ActorKind
}

interface Batch {
  userId: string
  canvasId: string
  items: PendingComment[]
  timer: ReturnType<typeof setTimeout>
}

const batches = new Map<string, Batch>() // `${userId}\n${canvasId}`

/** User ids a comment is news to. Pure given the in-memory canvas and thread. */
export function recipientsFor(canvas: Canvas, comment: ElementComment, actorKind: ActorKind): string[] {
  const ids = new Set<string>()
  if (canvas.ownerId) ids.add(canvas.ownerId)
  for (const id of canvas.memberIds ?? []) ids.add(id)
  if (canvas.workspaceId) for (const id of workspaceMemberIds(canvas.workspaceId)) ids.add(id)
  /* share-link visitors leave no durable trace — the thread they wrote in is
     the only record that they care about it */
  for (const c of actions.commentThread(comment)) if (c.fromUserId) ids.add(c.fromUserId)
  if (actorKind === 'user' && comment.fromUserId) ids.delete(comment.fromUserId)
  return [...ids]
}

export function onCanvasEvent(canvasId: string, event: CanvasEvent): void {
  if (event.type !== 'comment.created' && event.type !== 'comment.replied') return
  if (!mailerConfigured) return
  const canvas = store.getCanvasMetadata(canvasId)
  if (!canvas) return
  const item: PendingComment = { comment: event.comment, frameName: event.frame.name, actorKind: event.actorKind }
  for (const userId of recipientsFor(canvas, event.comment, event.actorKind)) queue(userId, canvasId, item)
}

function queue(userId: string, canvasId: string, item: PendingComment) {
  const key = `${userId}\n${canvasId}`
  let batch = batches.get(key)
  if (!batch) {
    const timer = setTimeout(() => void flush(key), COALESCE_MS)
    /* a pending courtesy email must not keep the process alive */
    timer.unref?.()
    batch = { userId, canvasId, items: [], timer }
    batches.set(key, batch)
  }
  batch.items.push(item)
}

async function flush(key: string) {
  const batch = batches.get(key)
  batches.delete(key)
  if (!batch) return
  try {
    /* the canvas may have been deleted, the person removed from it (or the
       share link turned off), banned or opted out during the window — all
       of which mean: send nothing. Access is checked here, not only when
       the batch opened, so a comment never reaches someone who could no
       longer open the canvas to read it. */
    const canvas = store.getCanvasMetadata(batch.canvasId)
    if (!canvas || !canAccessCanvas(batch.userId, canvas)) return
    const [person] = await mailableForComments([batch.userId])
    if (!person) return
    await sendMail(digest(person, canvas, batch.items))
  } catch (err) {
    console.error(`[comments] notification email to ${batch.userId} failed`, err)
  }
}

const quote = (s: string) => `“${s}”`

/** One plain-text email for everything that landed on a canvas during the window. */
export function digest(
  person: Mailable,
  canvas: Pick<Canvas, 'id' | 'name'>,
  items: PendingComment[],
): { to: string; subject: string; text: string } {
  const authors = [...new Set(items.map((i) => i.comment.from))]
  const n = items.length
  const first = items[0]
  const subject =
    n === 1 && first
      ? `${first.comment.from} ${first.comment.parentId ? 'replied' : 'commented'} on ${quote(canvas.name)}`
      : authors.length === 1
        ? `${authors[0]} left ${n} comments on ${quote(canvas.name)}`
        : `${n} new comments on ${quote(canvas.name)}`
  const body = items
    .map(({ comment, frameName }) => {
      const verb = comment.parentId ? 'replied in' : 'commented on'
      const text = comment.text.length > 600 ? `${comment.text.slice(0, 597)}…` : comment.text
      return `${comment.from} ${verb} ${quote(frameName)}:\n\n  ${quote(text.replace(/\n/g, '\n  '))}\n  ${commentLink(comment)}`
    })
    .join('\n\n')
  const text = `Hi ${person.name || 'there'},\n\n${body}\n\n—\nYou get this because you collaborate on ${quote(canvas.name)}. Turn comment emails off under Settings → Your account: ${settingsLink('account')}\n`
  return { to: person.email, subject, text }
}

/** Test seam: how many recipient batches are waiting to go out. */
export function pendingBatches(): number {
  return batches.size
}
