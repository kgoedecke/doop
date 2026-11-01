import { useCallback, useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { api } from '../lib/api'
import type { NotificationSettings } from '../../shared/notifications'
import { posthog } from '../lib/posthog'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Note } from './ui/note'
import { Checkbox } from './ui/checkbox'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'

/* settings fields are a fixed column on desktop and full width on a phone */

/** The "Your account" pane of /settings: who you are on a canvas, and how you
 *  get back into one. Everything here is better-auth's own account surface —
 *  no endpoints of ours. */
export function AccountSettings() {
  const t = useT()
  const { data: session } = authClient.useSession()
  const user = session?.user

  /* null while untouched, so the field tracks the session until you type */
  const [draft, setDraft] = useState<string | null>(null)
  const name = draft ?? user?.name ?? ''
  const dirty = name.trim().length > 0 && name.trim() !== (user?.name ?? '')

  const [savingName, setSavingName] = useState(false)
  const [nameNote, setNameNote] = useState('')
  const [nameError, setNameError] = useState('')

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [savingPw, setSavingPw] = useState(false)
  const [pwNote, setPwNote] = useState('')
  const [pwError, setPwError] = useState('')

  const [verifyNote, setVerifyNote] = useState('')

  /* null until the server has answered — the switch renders inert meanwhile */
  const [notify, setNotify] = useState<NotificationSettings | null>(null)
  const [notifyError, setNotifyError] = useState('')
  /* one save at a time: two in flight could land out of order and show the older choice */
  const [savingNotify, setSavingNotify] = useState(false)
  const refreshNotify = useCallback(() => {
    api.notificationSettings().then(setNotify, () => {})
  }, [])
  useEffect(refreshNotify, [refreshNotify])

  async function saveName() {
    setSavingName(true)
    setNameNote('')
    setNameError('')
    const { error } = await authClient.updateUser({ name: name.trim() })
    setSavingName(false)
    if (error) return setNameError(error.message || t('account.nameSaveFailed'))
    posthog.capture('account_name_changed')
    setDraft(null)
    setNameNote(t('account.nameSaved'))
  }

  async function savePassword() {
    setSavingPw(true)
    setPwNote('')
    setPwError('')
    /* revoking is the point: a password change you make because you fear a
       device is compromised is useless if that device stays signed in */
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    })
    setSavingPw(false)
    if (error) return setPwError(error.message || t('account.passwordChangeFailed'))
    posthog.capture('account_password_changed')
    setCurrent('')
    setNext('')
    setPwNote(t('account.passwordUpdated'))
  }

  async function setCommentEmails(on: boolean) {
    if (!notify || savingNotify) return
    setSavingNotify(true)
    setNotify({ ...notify, commentEmails: on })
    setNotifyError('')
    try {
      setNotify(await api.setNotificationPrefs({ commentEmails: on }))
      posthog.capture('comment_emails_toggled', { on })
    } catch {
      setNotifyError(t('account.notifySaveFailed'))
      refreshNotify()
    } finally {
      setSavingNotify(false)
    }
  }

  async function resendVerification() {
    if (!user?.email) return
    setVerifyNote('')
    const { error } = await authClient.sendVerificationEmail({ email: user.email })
    setVerifyNote(error ? error.message || t('account.verificationSendFailed') : t('account.verificationSent'))
  }

  return (
    <>
      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('account.profileTitle')}</CardTitle>
          <CardDescription>{t('account.profileDescription')}</CardDescription>
        </CardHeader>

        <CardRow
          label={t('account.nameRow')}
          action={
            <Button size="sm" disabled={!dirty || savingName} onClick={saveName}>
              {savingName ? t('account.saving') : t('common.save')}
            </Button>
          }
          control={
            <Input
              value={name}
              onChange={(e) => {
                setDraft(e.target.value)
                setNameNote('')
                setNameError('')
              }}
              maxLength={60}
              aria-label={t('account.displayNameAria')}
            />
          }
        >
          {nameError ? (
            <Note tone="error">{nameError}</Note>
          ) : nameNote ? (
            <Note tone="success">{nameNote}</Note>
          ) : dirty ? (
            <Note>{t('account.nameUnsaved')}</Note>
          ) : null}
        </CardRow>

        <CardRow
          label={t('account.emailRow')}
          action={
            user?.emailVerified ? (
              <Note>{t('account.emailNotChangeable')}</Note>
            ) : (
              <Button size="sm" onClick={resendVerification}>
                {t('account.resendVerification')}
              </Button>
            )
          }
        >
          <span className="min-w-0 font-mono text-body [overflow-wrap:anywhere]">{user?.email}</span>
          {user?.emailVerified ? (
            <Badge tone="success">{t('account.verified')}</Badge>
          ) : (
            <Badge>{t('account.unverified')}</Badge>
          )}
          {verifyNote && <Note tone="success">{verifyNote}</Note>}
        </CardRow>
      </SettingsCard>

      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('account.notificationsTitle')}</CardTitle>
          <CardDescription>{t('account.notificationsDescription')}</CardDescription>
        </CardHeader>
        <CardRow label={t('account.commentEmailsRow')}>
          <label className="relative flex cursor-pointer items-center gap-2.5 text-body text-ink">
            <Checkbox
              checked={notify?.commentEmails ?? true}
              disabled={!notify || !notify.emailConfigured || savingNotify}
              onChange={(e) => void setCommentEmails(e.target.checked)}
              aria-label={t('account.commentEmailsAria')}
            />
            <span>{t('account.commentEmailsLabel')}</span>
          </label>
          {notify && !notify.emailConfigured ? (
            <Note>{t('account.emailNotConfigured')}</Note>
          ) : notifyError ? (
            <Note tone="error">{notifyError}</Note>
          ) : null}
        </CardRow>
      </SettingsCard>

      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('account.passwordTitle')}</CardTitle>
          <CardDescription>{t('account.passwordDescription')}</CardDescription>
        </CardHeader>
        <CardRow
          label={t('account.currentPassword')}
          control={
            <Input
              type="password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                setPwError('')
              }}
              autoComplete="current-password"
              aria-label={t('account.currentPassword')}
            />
          }
        />
        <CardRow
          label={t('account.newPassword')}
          action={
            <Button size="sm" disabled={savingPw || !current || next.length < 8} onClick={savePassword}>
              {savingPw ? t('account.updatingPassword') : t('account.updatePassword')}
            </Button>
          }
          control={
            <Input
              type="password"
              value={next}
              onChange={(e) => {
                setNext(e.target.value)
                setPwError('')
              }}
              autoComplete="new-password"
              aria-label={t('account.newPassword')}
            />
          }
        >
          {pwError ? (
            <Note tone="error">{pwError}</Note>
          ) : pwNote ? (
            <Note tone="success">{pwNote}</Note>
          ) : (
            <Note>{t('account.passwordMinLength')}</Note>
          )}
        </CardRow>
      </SettingsCard>
    </>
  )
}
