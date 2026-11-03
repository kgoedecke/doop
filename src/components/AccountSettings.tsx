import { useCallback, useEffect, useRef, useState } from 'react'
import { authClient } from '../lib/auth'
import { api } from '../lib/api'
import type { NotificationSettings } from '../../shared/notifications'
import { AVATAR_ACCEPT, MAX_AVATAR_BYTES, avatarUrl } from '../../shared/avatar'
import { colorFor } from '../../shared/types'
import { posthog } from '../lib/posthog'
import { useT, type PlainMessageKey, type Translate } from '../lib/i18n'
import { Avatar } from './ui/avatar'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Note } from './ui/note'
import { Checkbox } from './ui/checkbox'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'

/* settings fields are a fixed column on desktop and full width on a phone */

/* A message kept in state: our own as a key, translated where it renders so a
   language switch reaches it too; the server's as the text it sent. */
type Notice = { key: PlainMessageKey } | { text: string }

function noticeText(t: Translate, notice: Notice): string {
  return 'key' in notice ? t(notice.key) : notice.text
}

/** The server's message when it sent one, else our own fallback. */
function errorNotice(message: string | undefined, fallback: PlainMessageKey): Notice {
  return message ? { text: message } : { key: fallback }
}

/** The "Your account" pane of /settings: who you are on a canvas, and how you
 *  get back into one. Everything here is better-auth's own account surface —
 *  no endpoints of ours. */
export function AccountSettings() {
  const t = useT()
  const { data: session, refetch: refetchSession } = authClient.useSession()
  const user = session?.user
  const photo = avatarUrl(user?.image)

  /* the photo: bytes go to /api/me/avatar, then the session is re-read so
     every face on the page (the account menu included) turns at once */
  const photoInput = useRef<HTMLInputElement>(null)
  const [savingPhoto, setSavingPhoto] = useState(false)
  const [photoNote, setPhotoNote] = useState<Notice | null>(null)
  const [photoError, setPhotoError] = useState<Notice | null>(null)

  /* null while untouched, so the field tracks the session until you type */
  const [draft, setDraft] = useState<string | null>(null)
  const name = draft ?? user?.name ?? ''
  const dirty = name.trim().length > 0 && name.trim() !== (user?.name ?? '')

  const [savingName, setSavingName] = useState(false)
  const [nameNote, setNameNote] = useState<Notice | null>(null)
  const [nameError, setNameError] = useState<Notice | null>(null)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [savingPw, setSavingPw] = useState(false)
  const [pwNote, setPwNote] = useState<Notice | null>(null)
  const [pwError, setPwError] = useState<Notice | null>(null)

  const [verifyNote, setVerifyNote] = useState<Notice | null>(null)

  /* null until the server has answered — the switch renders inert meanwhile */
  const [notify, setNotify] = useState<NotificationSettings | null>(null)
  const [notifyError, setNotifyError] = useState<Notice | null>(null)
  /* one save at a time: two in flight could land out of order and show the older choice */
  const [savingNotify, setSavingNotify] = useState(false)
  const refreshNotify = useCallback(() => {
    api.notificationSettings().then(setNotify, () => {})
  }, [])
  useEffect(refreshNotify, [refreshNotify])

  async function uploadPhoto(file: File) {
    setPhotoNote(null)
    setPhotoError(null)
    if (file.size > MAX_AVATAR_BYTES) return setPhotoError({ key: 'account.photoTooLarge' })
    setSavingPhoto(true)
    try {
      await api.uploadAvatar(file)
      await refetchSession()
      posthog.capture('account_photo_changed')
      setPhotoNote({ key: 'account.photoSaved' })
    } catch (e) {
      setPhotoError(errorNotice(e instanceof Error ? e.message : undefined, 'account.photoSaveFailed'))
    } finally {
      setSavingPhoto(false)
    }
  }

  async function removePhoto() {
    setPhotoNote(null)
    setPhotoError(null)
    setSavingPhoto(true)
    try {
      await api.removeAvatar()
      await refetchSession()
      posthog.capture('account_photo_removed')
      setPhotoNote({ key: 'account.photoRemoved' })
    } catch (e) {
      setPhotoError(errorNotice(e instanceof Error ? e.message : undefined, 'account.photoSaveFailed'))
    } finally {
      setSavingPhoto(false)
    }
  }

  async function saveName() {
    setSavingName(true)
    setNameNote(null)
    setNameError(null)
    const { error } = await authClient.updateUser({ name: name.trim() })
    setSavingName(false)
    if (error) return setNameError(errorNotice(error.message, 'account.nameSaveFailed'))
    posthog.capture('account_name_changed')
    setDraft(null)
    setNameNote({ key: 'account.nameSaved' })
  }

  async function savePassword() {
    setSavingPw(true)
    setPwNote(null)
    setPwError(null)
    /* revoking is the point: a password change you make because you fear a
       device is compromised is useless if that device stays signed in */
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    })
    setSavingPw(false)
    if (error) return setPwError(errorNotice(error.message, 'account.passwordChangeFailed'))
    posthog.capture('account_password_changed')
    setCurrent('')
    setNext('')
    setPwNote({ key: 'account.passwordUpdated' })
  }

  async function setCommentEmails(on: boolean) {
    if (!notify || savingNotify) return
    setSavingNotify(true)
    setNotify({ ...notify, commentEmails: on })
    setNotifyError(null)
    try {
      setNotify(await api.setNotificationPrefs({ commentEmails: on }))
      posthog.capture('comment_emails_toggled', { on })
    } catch {
      setNotifyError({ key: 'account.notifySaveFailed' })
      refreshNotify()
    } finally {
      setSavingNotify(false)
    }
  }

  async function resendVerification() {
    if (!user?.email) return
    setVerifyNote(null)
    const { error } = await authClient.sendVerificationEmail({ email: user.email })
    setVerifyNote(
      error ? errorNotice(error.message, 'account.verificationSendFailed') : { key: 'account.verificationSent' },
    )
  }

  return (
    <>
      <SettingsCard>
        <CardHeader>
          <CardTitle>{t('account.profileTitle')}</CardTitle>
          <CardDescription>{t('account.profileDescription')}</CardDescription>
        </CardHeader>

        <CardRow
          label={t('account.photoRow')}
          action={
            <>
              <Button size="sm" disabled={savingPhoto} onClick={() => photoInput.current?.click()}>
                {savingPhoto
                  ? t('account.uploadingPhoto')
                  : photo
                    ? t('account.changePhoto')
                    : t('account.uploadPhoto')}
              </Button>
              {photo && (
                <Button size="sm" variant="ghost" disabled={savingPhoto} onClick={removePhoto}>
                  {t('account.removePhoto')}
                </Button>
              )}
            </>
          }
        >
          <Avatar name={user?.name ?? ''} image={photo} color={colorFor(user?.id ?? '')} size={48} />
          <Input
            ref={photoInput}
            type="file"
            accept={AVATAR_ACCEPT}
            aria-label={t('account.choosePhotoAria')}
            className="hidden"
            onChange={(event) => {
              const [file] = event.currentTarget.files ?? []
              event.currentTarget.value = ''
              if (file) void uploadPhoto(file)
            }}
          />
          {photoError ? (
            <Note tone="error">{noticeText(t, photoError)}</Note>
          ) : photoNote ? (
            <Note tone="success">{noticeText(t, photoNote)}</Note>
          ) : (
            <Note>{t('account.photoHint')}</Note>
          )}
        </CardRow>

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
                setNameNote(null)
                setNameError(null)
              }}
              maxLength={60}
              aria-label={t('account.displayNameAria')}
            />
          }
        >
          {nameError ? (
            <Note tone="error">{noticeText(t, nameError)}</Note>
          ) : nameNote ? (
            <Note tone="success">{noticeText(t, nameNote)}</Note>
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
          {verifyNote && <Note tone="success">{noticeText(t, verifyNote)}</Note>}
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
            <Note tone="error">{noticeText(t, notifyError)}</Note>
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
                setPwError(null)
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
                setPwError(null)
              }}
              autoComplete="new-password"
              aria-label={t('account.newPassword')}
            />
          }
        >
          {pwError ? (
            <Note tone="error">{noticeText(t, pwError)}</Note>
          ) : pwNote ? (
            <Note tone="success">{noticeText(t, pwNote)}</Note>
          ) : (
            <Note>{t('account.passwordMinLength')}</Note>
          )}
        </CardRow>
      </SettingsCard>
    </>
  )
}
