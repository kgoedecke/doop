import { useState } from 'react'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { isDesktopShell } from '../lib/shell'
import { useT } from '../lib/i18n'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field } from './ui/field'
import { Note } from './ui/note'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { CardDescription, CardHeader, CardRow, CardTitle, SettingsCard } from './ui/card'

/** Whether this account can prove itself with a password: one that only ever
 *  signed in through Google / Microsoft / Apple / SSO has none, and better-auth
 *  then accepts a fresh session instead. Throws rather than guessing, as the
 *  iOS app does: a lookup that failed must not drop the password. */
async function accountHasPassword(): Promise<boolean> {
  const { data, error } = await authClient.listAccounts()
  if (error) throw new Error(error.message)
  return data.some((account) => account.providerId === 'credential')
}

/** After the account is gone the session is too: leave for the signed-out
 *  page the way logging out does (the desktop shell opens on /auth). */
function leaveDeletedAccount() {
  posthog.reset()
  location.assign(isDesktopShell() ? '/auth' : '/')
}

/** The last card of Settings → Your account: deleting the account through
 *  better-auth's `POST /api/auth/delete-user`, the same call the iOS app
 *  makes. The server's `beforeDelete` hook (`server/accountDeletion.ts`)
 *  removes canvases only this person could reach first. */
export function DeleteAccountCard() {
  const t = useT()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /* null while the dialog is closed; otherwise whether it asks for a password */
  const [asking, setAsking] = useState<{ password: boolean } | null>(null)

  async function begin() {
    setChecking(true)
    setError(null)
    try {
      setAsking({ password: await accountHasPassword() })
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('account.deleteCheckFailed'))
    } finally {
      setChecking(false)
    }
  }

  return (
    <SettingsCard>
      <CardHeader>
        <CardTitle>{t('account.deleteTitle')}</CardTitle>
        <CardDescription>{t('account.deleteDescription')}</CardDescription>
      </CardHeader>
      <CardRow
        label={t('account.deleteRow')}
        action={
          <Button size="sm" variant="danger" disabled={checking} onClick={() => void begin()}>
            {t('account.deleteButton')}
          </Button>
        }
      >
        {error ? <Note tone="error">{error}</Note> : <Note>{t('account.deleteHint')}</Note>}
      </CardRow>
      {asking && <DeleteAccountDialog askPassword={asking.password} onClose={() => setAsking(null)} />}
    </SettingsCard>
  )
}

function DeleteAccountDialog({ askPassword, onClose }: { askPassword: boolean; onClose: () => void }) {
  const t = useT()
  const [password, setPassword] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setDeleting(true)
    setError(null)
    /* a request that never got an answer (offline, a dropped connection)
       rejects rather than returning an error; it must not leave the dialog
       stuck on Deleting… with every way out disabled */
    const { error: failed } = await authClient
      .deleteUser(askPassword ? { password } : {})
      .catch(() => ({ error: { status: 0, message: '' } }))
    if (failed) {
      setDeleting(false)
      /* without a password better-auth wants a session younger than its
         freshAge (a day); an older one is refused with a 400 */
      if (!askPassword && failed.status === 400) return setError(t('account.deleteNeedsFreshSession'))
      return setError(failed.message || t('account.deleteFailed'))
    }
    posthog.capture('account_deleted')
    leaveDeletedAccount()
  }

  return (
    <Modal size="sm" onClose={() => !deleting && onClose()}>
      <ModalTitle>{t('account.deleteDialogTitle')}</ModalTitle>
      <ModalLede>{t('account.deleteDialogLede')}</ModalLede>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void confirm()
        }}
      >
        {askPassword && (
          <Field
            className="mt-5"
            label={t('account.deletePasswordLabel')}
            labelVariant="form"
            htmlFor="delete-password"
          >
            <Input
              id="delete-password"
              variant="well"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setError(null)
              }}
            />
          </Field>
        )}
        {error && (
          <Note tone="error" className="mt-3 block">
            {error}
          </Note>
        )}
        <ModalActions>
          <Button type="button" variant="ghost" disabled={deleting} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="danger-solid" disabled={deleting || (askPassword && !password)}>
            {deleting ? t('account.deleting') : t('account.deleteConfirm')}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  )
}
