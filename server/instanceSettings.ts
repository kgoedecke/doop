import { and, eq, inArray } from 'drizzle-orm'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as authSchema from './db/auth-schema.ts'
import * as workspaces from './workspaces.ts'
import {
  DEFAULT_INSTANCE_SETTINGS,
  type InstanceSettings,
  type InstanceSettingsPatch,
  type InstanceSettingsRefusal,
  type LoginPolicy,
} from '../shared/instanceSettings.ts'

/**
 * The instance's sign-in policy: who may create an account, whether the
 * sign-in page goes straight to SSO, and which workspace newcomers join.
 * One row, read into memory at boot (the sign-in page and every signup ask
 * for it) and written through on each change by an instance admin.
 */

const ROW_ID = 'instance'

let current: InstanceSettings = { ...DEFAULT_INSTANCE_SETTINGS }

export async function hydrateInstanceSettings(): Promise<void> {
  const [row] = await db.select().from(t.instanceSettings).where(eq(t.instanceSettings.id, ROW_ID))
  current = row
    ? {
        emailPasswordSignup: row.emailPasswordSignup,
        ssoAutoRedirect: row.ssoAutoRedirect,
        defaultWorkspaceId: row.defaultWorkspaceId,
      }
    : { ...DEFAULT_INSTANCE_SETTINGS }
}

/** The settings as they stand, with a default workspace that no longer
 *  exists read as none (a deleted workspace does not have to clean up here). */
export function getInstanceSettings(): InstanceSettings {
  const defaultWorkspaceId =
    current.defaultWorkspaceId && workspaces.getWorkspace(current.defaultWorkspaceId)
      ? current.defaultWorkspaceId
      : null
  return { ...current, defaultWorkspaceId }
}

/** What the sign-in page is told. Auto-redirect is only ever reported on
 *  when SSO is actually configured, whatever the row says. */
export function loginPolicy(ssoConfigured: boolean): LoginPolicy {
  const settings = getInstanceSettings()
  return {
    emailPasswordSignup: settings.emailPasswordSignup,
    ssoAutoRedirect: settings.ssoAutoRedirect && ssoConfigured,
  }
}

/** The facts a patch is checked against, gathered by the caller so the
 *  rule itself stays a pure function (and a unit-testable one). */
export interface PatchContext {
  ssoConfigured: boolean
  /** has any instance admin signed in through the OIDC provider? */
  ssoAdminSignedIn: boolean
  workspaceExists: (id: string) => boolean
}

/**
 * Why a patch must be refused, or null. Auto-redirect needs SSO to exist,
 * and needs an admin to have come in through it already: turning every
 * visitor towards a provider nobody has proven works would lock the
 * instance out of its own admin pages.
 */
export function refusalFor(patch: InstanceSettingsPatch, ctx: PatchContext): InstanceSettingsRefusal | null {
  if (patch.ssoAutoRedirect) {
    if (!ctx.ssoConfigured) return 'sso_not_configured'
    if (!ctx.ssoAdminSignedIn) return 'sso_no_admin_signed_in'
  }
  if (patch.defaultWorkspaceId && !ctx.workspaceExists(patch.defaultWorkspaceId)) return 'workspace_not_found'
  return null
}

/** Whether any admin account has an OIDC sign-in behind it. */
export async function ssoAdminSignedIn(): Promise<boolean> {
  const admins = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(authSchema.user.role, 'admin'))
  if (!admins.length) return false
  const [row] = await db
    .select({ id: authSchema.account.id })
    .from(authSchema.account)
    .where(
      and(
        eq(authSchema.account.providerId, 'oidc'),
        inArray(
          authSchema.account.userId,
          admins.map((a) => a.id),
        ),
      ),
    )
    .limit(1)
  return !!row
}

/** Apply an admin's patch: checked, written, then live. The write is awaited
 *  so a refused or failed change never shows as applied. */
export async function updateInstanceSettings(
  patch: InstanceSettingsPatch,
  updatedBy: string,
  ssoConfigured: boolean,
): Promise<{ settings: InstanceSettings } | { refusal: InstanceSettingsRefusal }> {
  const refusal = refusalFor(patch, {
    ssoConfigured,
    ssoAdminSignedIn: patch.ssoAutoRedirect ? await ssoAdminSignedIn() : false,
    workspaceExists: (id) => workspaces.getWorkspace(id) !== undefined,
  })
  if (refusal) return { refusal }
  const next: InstanceSettings = { ...getInstanceSettings(), ...patch }
  const row = { ...next, updatedAt: Date.now(), updatedBy }
  await db
    .insert(t.instanceSettings)
    .values({ id: ROW_ID, ...row })
    .onConflictDoUpdate({ target: t.instanceSettings.id, set: row })
  current = next
  return { settings: next }
}
