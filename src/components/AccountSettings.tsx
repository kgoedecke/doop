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
import { Card, CardDescription, CardHeader, CardRow, CardTitle } from './ui/card'

/* settings fields are a fixed column on desktop and full width on a phone */
const settingsCard = 'mt-4 max-w-[1000px] overflow-hidden sm:mt-5'
const settingsInput = 'w-full sm:w-[280px]'

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
    if (error) return setNameError(error.message || 'That name could not be saved')
    posthog.capture('account_name_changed')
    setDraft(null)
    setNameNote('Saved — agents pick it up within a minute')
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
    if (error) return setPwError(error.message || 'That password could not be changed')
    posthog.capture('account_password_changed')
    setCurrent('')
    setNext('')
    setPwNote('Password updated — every other session was signed out')
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
      setNotifyError('That could not be saved — try again')
      refreshNotify()
    } finally {
      setSavingNotify(false)
    }
  }

  async function resendVerification() {
    if (!user?.email) return
    setVerifyNote('')
    const { error } = await authClient.sendVerificationEmail({ email: user.email })
    setVerifyNote(error ? error.message || 'That email could not be sent' : 'Verification email sent')
  }

  return (
    <>
      <Card className={settingsCard}>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Your name is the identity shown on cursors, in the activity feed, and on everything you leave for an agent.
            Agents see the change within a minute.
          </CardDescription>
        </CardHeader>

        <CardRow
          label="Name"
          action={
            <Button size="sm" disabled={!dirty || savingName} onClick={saveName}>
              {savingName ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          <Input
            className={settingsInput}
            value={name}
            onChange={(e) => {
              setDraft(e.target.value)
              setNameNote('')
              setNameError('')
            }}
            maxLength={60}
            aria-label="Display name"
          />
          {nameError ? (
            <Note tone="error">{nameError}</Note>
          ) : nameNote ? (
            <Note tone="success">{nameNote}</Note>
          ) : dirty ? (
            <Note>Changed — not saved yet</Note>
          ) : null}
        </CardRow>

        <CardRow
          label="Email"
          action={
            user?.emailVerified ? (
              <Note>Sign-in address — not changeable yet</Note>
            ) : (
              <Button size="sm" onClick={resendVerification}>
                Resend verification
              </Button>
            )
          }
        >
          <span className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere]">{user?.email}</span>
          {user?.emailVerified ? (
            <Badge className="border-success/35 bg-success/10 text-[10.5px] text-success-ink">verified</Badge>
          ) : (
            <Badge className="text-[10.5px]">unverified</Badge>
          )}
          {verifyNote && <Note tone="success">{verifyNote}</Note>}
        </CardRow>
      </Card>

      <Card className={settingsCard}>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>
            Email about what happens on your canvases while you are not looking at them. Your own comments never trigger
            one.
          </CardDescription>
        </CardHeader>
        <CardRow label="Comment emails">
          <label className="relative flex cursor-pointer items-center gap-2.5 text-[13px] text-ink">
            <Checkbox
              checked={notify?.commentEmails ?? true}
              disabled={!notify || !notify.emailConfigured || savingNotify}
              onChange={(e) => void setCommentEmails(e.target.checked)}
              aria-label="Email me about new comments and replies"
            />
            <span>
              New comments and replies on canvases you own, were invited to, or wrote in — bundled into one email per
              canvas every couple of minutes.
            </span>
          </label>
          {notify && !notify.emailConfigured ? (
            <Note>This doop has no email set up (SMTP_HOST), so nothing is sent either way.</Note>
          ) : notifyError ? (
            <Note tone="error">{notifyError}</Note>
          ) : null}
        </CardRow>
      </Card>

      <Card className={settingsCard}>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Changing it signs out every other browser and device — this one stays signed in.
          </CardDescription>
        </CardHeader>
        <CardRow label="Current password">
          <Input
            className={settingsInput}
            type="password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value)
              setPwError('')
            }}
            autoComplete="current-password"
            aria-label="Current password"
          />
        </CardRow>
        <CardRow
          label="New password"
          action={
            <Button size="sm" disabled={savingPw || !current || next.length < 8} onClick={savePassword}>
              {savingPw ? 'Updating…' : 'Update password'}
            </Button>
          }
        >
          <Input
            className={settingsInput}
            type="password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value)
              setPwError('')
            }}
            autoComplete="new-password"
            aria-label="New password"
          />
          {pwError ? (
            <Note tone="error">{pwError}</Note>
          ) : pwNote ? (
            <Note tone="success">{pwNote}</Note>
          ) : (
            <Note>At least 8 characters</Note>
          )}
        </CardRow>
      </Card>
    </>
  )
}
