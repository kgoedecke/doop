import { inArray, or } from 'drizzle-orm'
import { db } from './db/index.ts'
import { user } from './db/auth-schema.ts'
import { workspaceMembers, workspaces } from './db/schema.ts'
import { companyPolicy, CompanyPolicyError } from './companyPolicy.ts'
import { store } from './store.ts'

/** Validate before readiness, without changing account or membership rows. */
export async function validateCompanySetup(): Promise<void> {
  const bindings = companyPolicy.bindings
  if (bindings.length === 0) return
  const botIds = bindings.map((binding) => binding.botUserId)
  const workspaceIds = bindings.map((binding) => binding.workspaceId)
  const [users, spaces, memberships] = await Promise.all([
    db.select({ id: user.id, role: user.role }).from(user).where(inArray(user.id, botIds)).limit(129),
    db
      .select({ id: workspaces.id, ownerId: workspaces.ownerId })
      .from(workspaces)
      .where(or(inArray(workspaces.id, workspaceIds), inArray(workspaces.ownerId, botIds)))
      .limit(257),
    db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .where(inArray(workspaceMembers.userId, botIds))
      .limit(129),
  ])
  if (memberships.length > 128) throw new CompanyPolicyError()
  companyPolicy.validate({ users, workspaces: spaces, memberships, canvases: store.allCanvases() })
}
