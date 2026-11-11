/**
 * Instance-wide sign-in policy, set by instance admins in Admin → Sign-in and
 * kept in one database row (server/instanceSettings.ts). Env keeps the
 * secrets and the provider wiring (OIDC_*, GOOGLE_*, SMTP_*); this is the
 * policy on top of them, changeable without a redeploy.
 */
export interface InstanceSettings {
  /** May visitors create an account with an email and a password? Off hides
   *  the sign-up form and refuses the sign-up call; existing password
   *  accounts still sign in, and SSO or social sign-ups are unaffected. */
  emailPasswordSignup: boolean
  /** Send signed-out visitors straight to the OIDC provider instead of
   *  showing the sign-in card. Needs OIDC configured. `?manual=1` on the
   *  sign-in page still shows the card. */
  ssoAutoRedirect: boolean
  /** The workspace every new account joins as a member, or null. */
  defaultWorkspaceId: string | null
}

export const DEFAULT_INSTANCE_SETTINGS: InstanceSettings = {
  emailPasswordSignup: true,
  ssoAutoRedirect: false,
  defaultWorkspaceId: null,
}

/** What the sign-in page needs from the settings: the public half. */
export interface LoginPolicy {
  emailPasswordSignup: boolean
  ssoAutoRedirect: boolean
}

export type InstanceSettingsPatch = Partial<InstanceSettings>

/** The strings PATCH /api/admin/instance-settings refuses with. */
export type InstanceSettingsRefusal =
  'sso_not_configured' | 'sso_no_admin_signed_in' | 'workspace_not_found' | 'invalid'

export function isInstanceSettingsPatch(value: unknown): value is InstanceSettingsPatch {
  if (!value || typeof value !== 'object') return false
  const patch = value as Record<string, unknown>
  for (const key of Object.keys(patch)) {
    if (key === 'emailPasswordSignup' || key === 'ssoAutoRedirect') {
      if (typeof patch[key] !== 'boolean') return false
    } else if (key === 'defaultWorkspaceId') {
      if (patch[key] !== null && typeof patch[key] !== 'string') return false
    } else return false
  }
  return true
}
