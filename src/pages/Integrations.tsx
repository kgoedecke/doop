import { useEffect, useState } from 'react'
import type { CanvasMeta } from '../../shared/types'
import type { Automation } from '../../shared/automations'
import { api, type IntegrationsStatus } from '../lib/api'
import { posthog } from '../lib/posthog'
import { connectIntegration } from '../lib/integrationConnect'
import { MetaTile } from '../components/AutomateShell'
import { AppRail, railLayout } from '../components/AppRail'
import { clientIntegrations } from '../integrations'
import { DisconnectButton, IntegrationCard } from '../integrations/ui'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { Skeleton } from '../components/ui/skeleton'
import { Toast } from '../components/ui/toast'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import { DashContent, DashHeader, DashLayout, DashMain, DashTitle } from '../components/ui/dash'
import { t as translate, useT } from '../lib/i18n'

/** Meta plus every registered extension — what the disconnect dialog names. */
type Disconnectable = { name: string; copy: string; disconnect: () => Promise<IntegrationsStatus> }

/** The OAuth round-trips land back here with their outcome in the query. */
function readNotice(): { tone: 'error' | 'success'; text: string } | null {
  const q = new URLSearchParams(location.search)
  const providers = [{ id: 'meta', name: 'Meta' }, ...clientIntegrations]
  for (const p of providers) {
    const error = q.get(`${p.id}Error`)
    if (error) return { tone: 'error', text: error }
    if (q.get(p.id) === 'connected')
      return { tone: 'success', text: translate('automations.providerConnected', { name: p.name }) }
  }
  return null
}

/**
 * Integrations: the outside services this account is connected to, one
 * card each. Connections are per user, not per canvas — an automation or
 * an import you start draws on them wherever it runs.
 */
export function Integrations() {
  const t = useT()
  const [status, setStatus] = useState<IntegrationsStatus | null>(null)
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  const [automations, setAutomations] = useState<Automation[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState<Disconnectable | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /* read once: the warning is about the week ahead, not this render */
  const [soon] = useState(() => Date.now() + 7 * 86_400_000)
  /* read once (initialisers run twice under StrictMode, so the URL is
     cleaned in an effect, not here) */
  const [notice] = useState(readNotice)

  useEffect(() => {
    api.integrations().then(setStatus).catch(console.error)
    api.listCanvases().then(setCanvases).catch(console.error)
    api.listAutomations().then(setAutomations).catch(console.error)
    if (notice) history.replaceState(null, '', location.pathname)
  }, [notice])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  /** Leave for Meta's consent screen. */
  async function connectMeta() {
    if (busy) return
    setBusy(true)
    try {
      const destination = await connectIntegration('meta', () =>
        posthog.capture('integration_connect_started', { provider: 'meta' }),
      )
      if (destination === 'browser') setBusy(false)
    } catch (error) {
      console.error(error)
      showToast(t('automations.metaStartFailed'))
      setBusy(false)
    }
  }

  function requestDisconnect(target: Disconnectable, provider: string) {
    setConfirmDisconnect({
      ...target,
      disconnect: async () => {
        const fresh = await target.disconnect()
        posthog.capture('integration_disconnected', { provider })
        return fresh
      },
    })
  }

  async function runDisconnect(target: Disconnectable) {
    setBusy(true)
    try {
      setStatus(await target.disconnect())
    } catch (error) {
      console.error(error)
      showToast(t('automations.disconnectFailed'))
    } finally {
      setBusy(false)
    }
  }

  const meta = status?.meta
  const usedBy = automations.filter((a) => a.steps.some((s) => s.type === 'pull')).length

  return (
    <DashLayout className={railLayout}>
      <AppRail active="integrations" canvases={canvases} />
      <DashMain className="[background:var(--paper)]">
        <DashHeader variant="bare">
          <span className="flex-1" />
        </DashHeader>

        <DashContent className="pt-2 md:pt-3">
          <DashTitle className="mb-5">{t('rail.integrations')}</DashTitle>

          {notice && (
            <Callout tone={notice.tone} className="mb-4 max-w-[720px]">
              {notice.text}
            </Callout>
          )}

          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {!meta || !status ? (
              <>
                <Skeleton shape="card" />
                <Skeleton shape="card" />
              </>
            ) : (
              <>
                {clientIntegrations.map((integration) => (
                  <integration.SettingsCard
                    key={integration.id}
                    status={status}
                    busy={busy}
                    setBusy={setBusy}
                    setStatus={setStatus}
                    showToast={showToast}
                    requestDisconnect={() =>
                      requestDisconnect(
                        {
                          name: integration.name,
                          copy: t(integration.disconnectCopy),
                          disconnect: integration.disconnect,
                        },
                        integration.id,
                      )
                    }
                  />
                ))}

                <IntegrationCard
                  tile={<MetaTile size={36} />}
                  name="Meta Ads"
                  detail={
                    meta.connected
                      ? t('automations.metaAccounts', {
                          name: meta.accountName ?? 'Meta',
                          count: meta.accounts?.length ?? 0,
                        })
                      : t('automations.metaPitch')
                  }
                  connected={meta.connected}
                  footnote={
                    meta.connected
                      ? usedBy > 0
                        ? t('automations.usedBy', { count: usedBy })
                        : t('automations.notUsedYet')
                      : ''
                  }
                  actions={
                    meta.connected ? (
                      <>
                        <Button
                          variant="bare"
                          size="sm"
                          disabled={busy || !meta.enabled}
                          onClick={() => void connectMeta()}
                        >
                          {t('automations.reconnect')}
                        </Button>
                        <DisconnectButton
                          disabled={busy}
                          onClick={() =>
                            requestDisconnect(
                              {
                                name: 'Meta',
                                copy: t('automations.metaDisconnectCopy'),
                                disconnect: api.disconnectMeta,
                              },
                              'meta',
                            )
                          }
                        />
                      </>
                    ) : (
                      <Button
                        variant="default"
                        size="sm"
                        disabled={busy || !meta.enabled}
                        onClick={() => void connectMeta()}
                      >
                        {t('automations.connect')}
                      </Button>
                    )
                  }
                >
                  {meta.connected && meta.expiresAt && meta.expiresAt < soon && (
                    <p className="text-caption text-accent-ink">{t('automations.metaExpiresSoon')}</p>
                  )}
                  {!meta.enabled && <p className="text-caption text-ink-faint">{t('automations.metaNotConfigured')}</p>}
                </IntegrationCard>
              </>
            )}
          </div>
        </DashContent>
      </DashMain>
      <ConfirmDialog
        open={!!confirmDisconnect}
        onOpenChange={(open) => !open && setConfirmDisconnect(null)}
        title={t('automations.disconnectTitle', { name: confirmDisconnect?.name ?? '' })}
        description={confirmDisconnect?.copy ?? ''}
        confirmLabel={t('automations.disconnect')}
        destructive
        onConfirm={() => {
          const target = confirmDisconnect
          setConfirmDisconnect(null)
          if (target) void runDisconnect(target)
        }}
      />
      {toast && <Toast>{toast}</Toast>}
    </DashLayout>
  )
}
