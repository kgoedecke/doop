import { useEffect, useState } from 'react'
import type { CanvasMeta } from '../../shared/types'
import type { Automation } from '../../shared/automations'
import { api, type IntegrationsStatus } from '../lib/api'
import { posthog } from '../lib/posthog'
import { AccountMenu } from '../components/DashShell'
import { MetaTile, WorkspaceRail } from '../components/AutomateShell'
import { Button } from '../components/ui/button'
import { Callout } from '../components/ui/callout'
import { Skeleton } from '../components/ui/skeleton'
import { Toast } from '../components/ui/toast'
import { ConfirmDialog } from '../components/ui/alert-dialog'
import { DashContent, DashHeader, DashLayout, DashMain, DashTitle } from '../components/ui/dash'
import { cn } from '@/lib/utils'

/**
 * Integrations: the outside services this account is connected to, one
 * card each. Connections are per user, not per canvas — an automation you
 * own draws on them wherever it runs. Meta is the only provider today.
 */
export function Integrations() {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null)
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  const [automations, setAutomations] = useState<Automation[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  /* read once: the warning is about the week ahead, not this render */
  const [soon] = useState(() => Date.now() + 7 * 86_400_000)
  /* the OAuth round-trip lands back here with its outcome in the query;
     read it once (initialisers run twice under StrictMode, so the URL is
     cleaned in an effect, not here) */
  const [notice] = useState(() => {
    const q = new URLSearchParams(location.search)
    const error = q.get('metaError')
    const connected = q.get('meta') === 'connected'
    return error
      ? { tone: 'error' as const, text: error }
      : connected
        ? { tone: 'success' as const, text: 'Meta connected.' }
        : null
  })

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

  async function connect() {
    if (busy) return
    setBusy(true)
    try {
      const { url } = await api.startMetaConnect()
      posthog.capture('integration_connect_started', { provider: 'meta' })
      location.assign(url)
    } catch (error) {
      console.error(error)
      showToast('Couldn’t start the Meta connection')
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      setStatus(await api.disconnectMeta())
      posthog.capture('integration_disconnected', { provider: 'meta' })
    } catch (error) {
      console.error(error)
      showToast('Couldn’t disconnect')
    } finally {
      setBusy(false)
    }
  }

  const meta = status?.meta
  const usedBy = automations.filter((a) => a.steps.some((s) => s.type === 'pull')).length

  return (
    <DashLayout>
      <WorkspaceRail
        active="integrations"
        canvases={canvases}
        automationCount={automations.length}
        integrationCount={meta?.connected ? 1 : 0}
      />
      <DashMain>
        <DashHeader>
          <span className="flex-1" />
          <AccountMenu />
        </DashHeader>

        <DashContent>
          <DashTitle className="mb-[26px]">
            Integrations<em className="not-italic text-brand">.</em>
          </DashTitle>

          {notice && (
            <Callout tone={notice.tone} className="mb-4 max-w-[720px]">
              {notice.text}
            </Callout>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {!meta ? (
              <Skeleton className="min-h-[150px] rounded-[14px]" />
            ) : (
              <div className="flex min-h-[150px] flex-col gap-3 rounded-[14px] border border-line bg-surface px-[18px] pb-4 pt-[18px] shadow-card">
                <div className="flex items-center gap-[11px]">
                  <MetaTile size={36} />
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold tracking-[-0.012em]">Meta Ads</div>
                    <div className="mt-0.5 truncate text-[12px] text-ink-soft">
                      {meta.connected
                        ? `${meta.accountName ?? 'Meta'} · ${meta.accounts?.length ?? 0} ad ${
                            meta.accounts?.length === 1 ? 'account' : 'accounts'
                          }`
                        : 'Pull ad creatives onto a canvas'}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'ml-auto inline-flex flex-none items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em]',
                      meta.connected ? 'text-ink-soft' : 'text-ink-faint',
                    )}
                  >
                    <span className={cn('size-[7px] rounded-full', meta.connected ? 'bg-[#3f9c52]' : 'bg-line')} />
                    {meta.connected ? 'connected' : 'not connected'}
                  </span>
                </div>
                {meta.connected && meta.expiresAt && meta.expiresAt < soon && (
                  <p className="text-[11.5px] text-accent-ink">
                    Meta’s access expires soon — reconnect to keep pulls running.
                  </p>
                )}
                {!meta.enabled && (
                  <p className="text-[11.5px] text-ink-faint">
                    Not configured on this server — set META_APP_ID and META_APP_SECRET.
                  </p>
                )}
                <div className="mt-auto flex items-center gap-2">
                  <span className="flex-1 text-[12px] text-ink-faint">
                    {meta.connected
                      ? usedBy > 0
                        ? `Used by ${usedBy} ${usedBy === 1 ? 'automation' : 'automations'}`
                        : 'Not used by an automation yet'
                      : ''}
                  </span>
                  {meta.connected ? (
                    <>
                      <Button variant="bare" size="sm" disabled={busy || !meta.enabled} onClick={connect}>
                        Reconnect
                      </Button>
                      <Button
                        variant="bare"
                        size="sm"
                        className="text-ink-soft"
                        disabled={busy}
                        onClick={() => setConfirmDisconnect(true)}
                      >
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <Button variant="default" size="sm" disabled={busy || !meta.enabled} onClick={connect}>
                      Connect
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </DashContent>
      </DashMain>
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={(open) => !open && setConfirmDisconnect(false)}
        title="Disconnect Meta?"
        description="Automations that pull from Meta will fail until you connect again. Frames already on your canvases stay."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => {
          setConfirmDisconnect(false)
          void disconnect()
        }}
      />
      {toast && <Toast>{toast}</Toast>}
    </DashLayout>
  )
}
