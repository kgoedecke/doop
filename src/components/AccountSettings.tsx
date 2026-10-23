import { useCallback, useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { api } from '../lib/api'
import type { NotificationSettings } from '../../shared/notifications'
import { posthog } from '../lib/posthog'
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
    if (error) return setNameError(error.message || 'Your name could not be saved')
    posthog.capture('account_name_changed')
    setDraft(null)
    setNameNote('Saved. Agents see the change within a minute.')
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
    if (error) return setPwError(error.message || 'Your password could not be changed')
    posthog.capture('account_password_changed')
    setCurrent('')
    setNext('')
    setPwNote('Password updated. Every other session was signed out.')
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
      setNotifyError('Your notification setting could not be saved. Try again.')
      refreshNotify()
    } finally {
      setSavingNotify(false)
    }
  }

  async function resendVerification() {
    if (!user?.email) return
    setVerifyNote('')
    const { error } = await authClient.sendVerificationEmail({ email: user.email })
    setVerifyNote(error ? error.message || 'The verification email could not be sent' : 'Verification email sent')
  }

  return (
    <>
      <SettingsCard>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Your name appears on cursors, in the activity feed, and on everything you leave for an agent. Agents see the
            change within a minute.
          </CardDescription>
        </CardHeader>

        <CardRow
          label="Name"
          action={
            <Button size="sm" disabled={!dirty || savingName} onClick={saveName}>
              {savingName ? 'Saving…' : 'Save'}
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
              aria-label="Display name"
            />
          }
        >
          {nameError ? (
            <Note tone="error">{nameError}</Note>
          ) : nameNote ? (
            <Note tone="success">{nameNote}</Note>
          ) : dirty ? (
            <Note>You have unsaved changes</Note>
          ) : null}
        </CardRow>

        <CardRow
          label="Email"
          action={
            user?.emailVerified ? (
              <Note>Your sign-in address cannot be changed yet</Note>
            ) : (
              <Button size="sm" onClick={resendVerification}>
                Resend verification
              </Button>
            )
          }
        >
          <span className="min-w-0 font-mono text-body [overflow-wrap:anywhere]">{user?.email}</span>
          {user?.emailVerified ? <Badge tone="success">verified</Badge> : <Badge>unverified</Badge>}
          {verifyNote && <Note tone="success">{verifyNote}</Note>}
        </CardRow>
      </SettingsCard>

      <SettingsCard>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>
            Receive emails about activity on your canvases while you’re not viewing them. Your own comments never
            trigger an email.
          </CardDescription>
        </CardHeader>
        <CardRow label="Comment emails">
          <label className="relative flex cursor-pointer items-center gap-2.5 text-body text-ink">
            <Checkbox
              checked={notify?.commentEmails ?? true}
              disabled={!notify || !notify.emailConfigured || savingNotify}
              onChange={(e) => void setCommentEmails(e.target.checked)}
              aria-label="Email me about new comments and replies"
            />
            <span>
              Receive new comments and replies on canvases you own, were invited to, or wrote in, grouped into one email
              per canvas every couple of minutes.
            </span>
          </label>
          {notify && !notify.emailConfigured ? (
            <Note>
              Email is not configured for this doop (SMTP_HOST). No emails are sent, regardless of this setting.
            </Note>
          ) : notifyError ? (
            <Note tone="error">{notifyError}</Note>
          ) : null}
        </CardRow>
      </SettingsCard>

      <SettingsCard>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Changing your password signs out every other browser and device. This one stays signed in.
          </CardDescription>
        </CardHeader>
        <CardRow
          label="Current password"
          control={
            <Input
              type="password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                setPwError('')
              }}
              autoComplete="current-password"
              aria-label="Current password"
            />
          }
        />
        <CardRow
          label="New password"
          action={
            <Button size="sm" disabled={savingPw || !current || next.length < 8} onClick={savePassword}>
              {savingPw ? 'Updating…' : 'Update password'}
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
              aria-label="New password"
            />
          }
        >
          {pwError ? (
            <Note tone="error">{pwError}</Note>
          ) : pwNote ? (
            <Note tone="success">{pwNote}</Note>
          ) : (
            <Note>At least 8 characters</Note>
          )}
        </CardRow>
      </SettingsCard>
    </>
  )
}
