import { useEffect, useState } from 'react'
import { IconButton } from './ui/icon-button'
import { GearIcon } from './ui/icons'
import { Modal, ModalActions, ModalLede, ModalSpacer, ModalTitle } from './ui/modal'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { useT } from '../lib/i18n'
import {
  canChooseServer,
  chooseServer,
  serverErrorMessage,
  serverHost,
  serverStatus,
  type ServerStatus,
} from '../lib/desktopServer'

/* The sign-in screen's cog in the desktop app: which Doop server the app
   opens (src/lib/desktopServer.ts). The shell does the checking, the
   confirming and the restart; this only collects the address. Browsers and
   shells that cannot switch never draw it. */
export function ServerSettings() {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!canChooseServer()) return null
  return (
    <>
      <IconButton aria-label={t('auth.serverSettings')} className="fixed bottom-3 left-3" onClick={() => setOpen(true)}>
        <GearIcon size="rail" />
      </IconButton>
      {open && <ServerModal onClose={() => setOpen(false)} />}
    </>
  )
}

function ServerModal({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    serverStatus()
      .then((current) => {
        if (!live) return
        setStatus(current)
        setAddress((typed) => typed || current.url)
      })
      .catch((err: unknown) => live && setError(serverErrorMessage(err, t('auth.serverFailed'))))
    return () => {
      live = false
    }
  }, [t])

  const choose = async (url: string) => {
    setBusy(true)
    setError(null)
    try {
      /* true: the app is restarting onto it; false: same server, or a no */
      if (!(await chooseServer(url))) setBusy(false)
    } catch (err) {
      setError(serverErrorMessage(err, t('auth.serverFailed')))
      setBusy(false)
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <ModalTitle>{t('auth.serverTitle')}</ModalTitle>
      <ModalLede>
        {status ? t('auth.serverLede', { host: serverHost(status.url) }) : t('auth.serverLedeLoading')}
      </ModalLede>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void choose(address)
        }}
      >
        <Input
          variant="well"
          className="mt-5"
          autoFocus
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://doop.example.com"
          value={address}
          disabled={busy}
          onChange={(event) => setAddress(event.target.value)}
          aria-label={t('auth.serverAddress')}
        />
        <p className="mt-2 text-caption text-ink-faint">{t('auth.serverHint')}</p>
        {error && <p className="mt-2 text-label text-accent-ink">{error}</p>}
        <ModalActions>
          {status?.custom && (
            <>
              <Button type="button" variant="link" disabled={busy} onClick={() => void choose(status.defaultUrl)}>
                {t('auth.serverUseDefault', { host: serverHost(status.defaultUrl) })}
              </Button>
              <ModalSpacer />
            </>
          )}
          <Button type="button" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !address.trim()}>
            {busy ? t('auth.serverConnecting') : t('auth.serverConnect')}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  )
}
