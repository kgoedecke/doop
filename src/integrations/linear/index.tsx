import { connectIntegration } from '../../lib/integrationConnect'
import { useState } from 'react'
import type { ClientIntegration, SettingsCardProps } from '../index'
import { ApiError, req, type IntegrationsStatus } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from '../../components/ui/modal'
import { Note } from '../../components/ui/note'
import { DisconnectButton, IntegrationCard } from '../ui'
import { BrandMark } from '@/components/ui/brand-mark'
import { useT } from '@/lib/i18n'

interface LinearStatus {
  connected: boolean
  personalConnected?: boolean
  accountName?: string
  connectedAt?: number
  agentConfigured?: boolean
  agent?: { connected: boolean; workspaceName?: string }
}

function statusOf(status: IntegrationsStatus): LinearStatus {
  return (status.linear ?? { connected: false }) as LinearStatus
}

function LinearTile({ size = 24, className }: { size?: number; className?: string }) {
  return <BrandMark brand="linear" size={size} className={className} />
}

function LinearSettingsCard({ status, busy, setBusy, setStatus, requestDisconnect, showToast }: SettingsCardProps) {
  const t = useT()
  const linear = statusOf(status)
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [replacing, setReplacing] = useState(false)
  const hasKey = linear.personalConnected ?? (linear.connected && !linear.agent?.connected)
  const [error, setError] = useState<string | null>(null)

  function closeSetup() {
    if (busy) return
    setOpen(false)
    setToken('')
    setError(null)
    setReplacing(false)
  }

  async function installAgent() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if ((await connectIntegration('linear')) === 'browser') setBusy(false)
    } catch (error) {
      setError(
        error instanceof ApiError
          ? String(error.body.error ?? t('automations.installFailed'))
          : t('automations.installFailed'),
      )
      setBusy(false)
    }
  }

  async function connect() {
    if (busy || !token.trim()) return
    setBusy(true)
    setError(null)
    try {
      setStatus(
        await req<IntegrationsStatus>('/api/integrations/linear/token', {
          method: 'POST',
          body: JSON.stringify({ token: token.trim() }),
        }),
      )
      setToken('')
      setReplacing(false)
      setOpen(false)
      showToast(hasKey ? t('automations.linearKeyReplaced') : t('automations.linearConnected'))
    } catch (error) {
      setError(
        error instanceof ApiError
          ? String(error.body.error ?? t('automations.linearConnectFailed'))
          : t('automations.linearConnectFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <IntegrationCard
        tile={<LinearTile size={36} />}
        name="Linear"
        detail={
          linear.agent?.connected
            ? t('automations.doopAgentIn', { workspace: linear.agent.workspaceName ?? '' })
            : linear.connected
              ? (linear.accountName ?? t('automations.linearAccount'))
              : t('automations.linearPitch')
        }
        connected={linear.connected}
        footnote={
          linear.agent?.connected
            ? t('automations.automaticPickup')
            : linear.connected
              ? t('automations.readOnlyAccess')
              : ''
        }
        actions={
          <>
            <Button
              variant={linear.connected ? 'bare' : 'default'}
              size="sm"
              disabled={busy}
              onClick={() => setOpen(true)}
            >
              {linear.connected ? t('automations.manage') : t('automations.connect')}
            </Button>
            {linear.connected && <DisconnectButton disabled={busy} onClick={requestDisconnect} />}
          </>
        }
      />
      <Modal open={open} onClose={closeSetup} size="md">
        <ModalTitle>{linear.connected ? t('automations.manageLinear') : t('automations.connectLinear')}</ModalTitle>
        <ModalLede>{t('automations.linearLede')}</ModalLede>
        <div className="mt-5 flex flex-col gap-5">
          {linear.agent?.connected && <p className="text-copy text-ink-soft">{t('automations.linearDelegate')}</p>}
          {linear.agentConfigured && !linear.agent?.connected && (
            <div className="flex flex-col gap-2">
              <h3 className="text-copy font-semibold">{t('automations.automaticPickup')}</h3>
              <p className="text-copy leading-relaxed text-ink-soft">{t('automations.linearInstallBody')}</p>
              <Button size="sm" disabled={busy} onClick={() => void installAgent()}>
                {t('automations.installAgent')}
              </Button>
            </div>
          )}
          {!linear.agentConfigured && !linear.agent?.connected && <Note>{t('automations.linearNeedsApp')}</Note>}
          {error && (
            <Note role="alert" tone="error">
              {error}
            </Note>
          )}
          {hasKey && !replacing && (
            <Button variant="bare" size="sm" disabled={busy} onClick={() => setReplacing(true)}>
              {t('automations.replaceKey')}
            </Button>
          )}
          {(!linear.connected || replacing) && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void connect()
              }}
            >
              <h3 className="text-copy font-semibold">{t('automations.readOnlyAccess')}</h3>
              <p className="text-copy leading-relaxed text-ink-soft">
                {t('automations.linearKeyBefore')}{' '}
                <a
                  href="https://linear.app/settings/account/security"
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink-soft underline underline-offset-2"
                >
                  {t('automations.linearKeyLink')}
                </a>{' '}
                {t('automations.linearKeyAfter')}
              </p>
              <div className="flex gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label={t('automations.linearKeyLabel')}
                  placeholder="lin_api_…"
                  value={token}
                  disabled={busy}
                  variant="well"
                  className="min-w-0 flex-1"
                  onChange={(event) => {
                    setToken(event.target.value)
                    setError(null)
                  }}
                />
                <Button type="submit" size="sm" disabled={busy || !token.trim()}>
                  {busy ? t('automations.checking') : replacing ? t('automations.saveKey') : t('automations.connect')}
                </Button>
              </div>
              {replacing && (
                <>
                  <Note>{t('automations.linearKeyStays')}</Note>
                  <Button
                    type="button"
                    variant="bare"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setToken('')
                      setError(null)
                      setReplacing(false)
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                </>
              )}
            </form>
          )}
        </div>
        <ModalActions>
          <Button variant="bare" disabled={busy} onClick={closeSetup}>
            {t('common.close')}
          </Button>
        </ModalActions>
      </Modal>
    </>
  )
}

export const linearIntegration: ClientIntegration = {
  id: 'linear',
  name: 'Linear',
  Tile: LinearTile,
  SettingsCard: LinearSettingsCard,
  isConnected: (status) => statusOf(status).connected,
  disconnect: () => req<IntegrationsStatus>('/api/integrations/linear', { method: 'DELETE' }),
  disconnectCopy: 'automations.linearDisconnectCopy',
}
