import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { linearOAuthStates, liveActivities, liveActivityStarters, slackOAuthStates } from './db/schema.ts'
import { store } from './store.ts'
import { removeMember as leaveWorkspace, workspaceIdsFor } from './workspaces.ts'

/**
 * Everything a user owns or belongs to, before better-auth removes the user
 * row (App Store rule 5.1.1(v) requires in-app account deletion). Canvases only
 * the user could reach are deleted; canvases shared with other people or living
 * in a workspace stay with them, with the user removed from the member list.
 */
export async function purgeUserData(userId: string): Promise<{ deletedCanvases: number }> {
  /* The agent installations go first: left behind, a Slack or Linear
     installation keeps its bot token, keeps queueing work billed to the
     vanished account, and blocks anyone else from connecting that workspace.
     Both job modules import auth.ts, which imports this module — hence lazy. */
  const [slack, linear] = await Promise.all([import('./slack/jobs.ts'), import('./linear/jobs.ts')])
  await slack.disconnectAgent(userId)
  await linear.disconnectAgent(userId)
  await db.delete(slackOAuthStates).where(eq(slackOAuthStates.userId, userId))
  await db.delete(linearOAuthStates).where(eq(linearOAuthStates.userId, userId))
  let deletedCanvases = 0
  for (const canvas of store.allCanvases()) {
    const others = (canvas.memberIds ?? []).filter((id) => id !== userId)
    if (canvas.ownerId === userId && others.length === 0 && !canvas.workspaceId) {
      await store.deleteCanvas(canvas.id)
      deletedCanvases += 1
    } else if (canvas.memberIds?.includes(userId)) {
      store.removeMember(canvas.id, userId)
    }
  }
  for (const workspaceId of workspaceIdsFor(userId)) await leaveWorkspace(workspaceId, userId)
  await db.delete(liveActivities).where(eq(liveActivities.userId, userId))
  await db.delete(liveActivityStarters).where(eq(liveActivityStarters.userId, userId))
  return { deletedCanvases }
}
