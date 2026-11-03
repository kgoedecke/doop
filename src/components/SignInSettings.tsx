import { useEffect, useState } from 'react'
import { adminApi, ApiError, type AdminInstanceSettings } from '../lib/api'
import { useT, type PlainMessageKey } from '../lib/i18n'
import type { InstanceSettingsPatch, InstanceSettingsRefusal } from '../../shared/instanceSettings'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'
import { Switch } from './ui/switch'
import { Callout } from './ui/callout'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/* the Select cannot carry an empty value, so "no default workspace" is this */
const NONE = '__none__'

const REFUSALS: Record<InstanceSettingsRefusal, PlainMessageKey> = {
  sso_not_configured: 'admin.refusalSsoNotConfigured',
  sso_no_admin_signed_in: 'admin.refusalSsoNoAdmin',
  workspace_not_found: 'admin.refusalWorkspaceNotFound',
  invalid: 'admin.refusalInvalid',
}

function refusalOf(error: unknown): InstanceSettingsRefusal | null {
  if (!(error instanceof ApiError)) return null
  const refusal = error.body.refusal
  return typeof refusal === 'string' && refusal in REFUSALS ? (refusal as InstanceSettingsRefusal) : null
}

/**
 * Admin → Sign-in: the instance's sign-in policy (shared/instanceSettings.ts)
 * over the providers its environment wired up. Each control saves on change;
 * a refused change puts the control back and says why.
 */
export function SignInSettings() {
  const t = useT()
  const [view, setView] = useState<AdminInstanceSettings | null>(null)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    adminApi
      .instanceSettings()
      .then(setView)
      .catch(() => setFailed(true))
  }, [])

  async function save(patch: InstanceSettingsPatch) {
    setBusy(true)
    setError(null)
    try {
      setView(await adminApi.updateInstanceSettings(patch))
    } catch (e) {
      const refusal = refusalOf(e)
      setError(t(refusal ? REFUSALS[refusal] : 'admin.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (failed) return <p className="mt-7 text-copy text-ink-soft">{t('admin.signInLoadFailed')}</p>
  if (!view) return <p className="mt-7 text-copy text-ink-soft">{t('admin.loading')}</p>

  const { settings, providers, workspaces } = view
  const sso = providers.displayName ?? 'SSO'
  const social = [providers.google && 'Google', providers.microsoft && 'Microsoft', providers.apple && 'Apple'].filter(
    (name): name is string => !!name,
  )
  /* why the auto-redirect switch is off-limits right now, if it is */
  const redirectBlocker = !providers.enabled
    ? t('admin.ssoAutoRedirectUnavailable')
    : !view.ssoAdminSignedIn && !settings.ssoAutoRedirect
      ? t('admin.ssoAutoRedirectGuard', { provider: sso })
      : null

  return (
    <div className="mt-4 flex flex-col gap-4">
      {error && <Callout tone="error">{error}</Callout>}
      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('admin.methodsTitle')}</CardTitle>
          <CardDescription>{t('admin.methodsDescription')}</CardDescription>
        </CardHeader>
        <CardRow label={t('admin.providerEmail')}>
          <Setting
            id="email-password-signup"
            checked={settings.emailPasswordSignup}
            disabled={busy}
            onChange={(checked) => void save({ emailPasswordSignup: checked })}
            label={t('admin.emailPasswordSignup')}
            hint={t('admin.emailPasswordSignupHint')}
          />
        </CardRow>
        {social.map((name) => (
          <CardRow key={name} label={name}>
            <span className="text-body text-ink-soft">{t('admin.providerSocialHint')}</span>
          </CardRow>
        ))}
        <CardRow label={t('admin.providerSso', { provider: sso })}>
          {providers.enabled ? (
            <Setting
              id="sso-auto-redirect"
              checked={settings.ssoAutoRedirect}
              disabled={busy || !!redirectBlocker}
              onChange={(checked) => void save({ ssoAutoRedirect: checked })}
              label={t('admin.ssoAutoRedirect')}
              hint={`${t('admin.ssoAutoRedirectHint')} ${t('admin.ssoAutoRedirectEscape')}`}
              blocker={redirectBlocker}
            />
          ) : (
            <span className="text-body text-ink-soft">{t('admin.ssoNotConfigured')}</span>
          )}
        </CardRow>
      </SettingsCard>

      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('admin.newAccountsTitle')}</CardTitle>
          <CardDescription>{t('admin.newAccountsDescription')}</CardDescription>
        </CardHeader>
        <CardRow
          label={t('admin.defaultWorkspace')}
          control={
            <Select
              value={settings.defaultWorkspaceId ?? NONE}
              disabled={busy}
              onValueChange={(value) => void save({ defaultWorkspaceId: value === NONE ? null : value })}
            >
              <SelectTrigger aria-label={t('admin.defaultWorkspace')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('admin.defaultWorkspaceNone')}</SelectItem>
                {workspaces.map((ws) => (
                  <SelectItem value={ws.id} key={ws.id}>
                    {ws.name} · {t('admin.workspaceMembers', { count: ws.memberCount })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          <span className="text-body text-ink-soft">{t('admin.defaultWorkspaceHint')}</span>
        </CardRow>
      </SettingsCard>
    </div>
  )
}

/** One method's own setting: the switch beside the words that say what it
 *  does, so each row carries a different control rather than a shared
 *  column of toggles that all look like "method on or off". */
function Setting({
  id,
  checked,
  disabled,
  onChange,
  label,
  hint,
  blocker,
}: {
  id: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
  label: string
  hint: string
  /** why the switch cannot be turned on right now, if it cannot */
  blocker?: string | null
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2.5">
        <Switch id={id} size="sm" checked={checked} disabled={disabled} onCheckedChange={onChange} />
        <label htmlFor={id} className="text-body text-ink">
          {label}
        </label>
      </div>
      <span className="text-caption text-ink-faint">
        {hint}
        {blocker && <span className="block text-warning-ink">{blocker}</span>}
      </span>
    </div>
  )
}
