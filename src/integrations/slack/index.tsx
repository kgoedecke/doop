import { useState } from 'react'
import type { ClientIntegration, SettingsCardProps } from '../index'
import { ApiError, req, type IntegrationsStatus } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { DisconnectButton, IntegrationCard } from '../ui'
import slackLogo from './logo.svg'
import { cn } from '@/lib/utils'

interface SlackStatus {
  connected: boolean
  agentConfigured?: boolean
  workspaceName?: string
  connectedAt?: number
}

function statusOf(status: IntegrationsStatus): SlackStatus {
  return (status.slack ?? { connected: false }) as SlackStatus
}

function SlackTile({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-grid flex-none place-items-center', className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.29),
        background: '#4A154B',
      }}
    >
      <img src={slackLogo} alt="" width={Math.round(size * 0.55)} height={Math.round(size * 0.55)} />
    </span>
  )
}

function SlackSettingsCard({ status, busy, setBusy, requestDisconnect }: SettingsCardProps) {
  const slack = statusOf(status)
  const [error, setError] = useState<string | null>(null)

  async function install() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { url } = await req<{ url: string }>('/api/integrations/slack/start', { method: 'POST' })
      location.assign(url)
    } catch (error) {
      setError(
        error instanceof ApiError ? String(error.body.error ?? 'Could not install Doop.') : 'Could not install Doop.',
      )
      setBusy(false)
    }
  }

  return (
    <IntegrationCard
      tile={<SlackTile size={36} />}
      name="Slack"
      detail={
        slack.connected
          ? `Doop agent · ${slack.workspaceName ?? 'Slack workspace'}`
          : 'Mention @Doop with a design brief'
      }
      connected={slack.connected}
      footnote={
        slack.agentConfigured || slack.connected
          ? 'Anyone in the workspace can mention @Doop; every run spends your model account or task allowance'
          : 'Needs a Slack app configured by this server’s administrator'
      }
      actions={
        slack.connected ? (
          <DisconnectButton disabled={busy} onClick={requestDisconnect} />
        ) : (
          <Button size="sm" disabled={busy || !slack.agentConfigured} onClick={() => void install()}>
            Install Doop in Slack
          </Button>
        )
      }
    >
      {error && (
        <p role="alert" className="text-[11.5px] text-accent-ink">
          {error}
        </p>
      )}
    </IntegrationCard>
  )
}

export const slackIntegration: ClientIntegration = {
  id: 'slack',
  name: 'Slack',
  Tile: SlackTile,
  SettingsCard: SlackSettingsCard,
  isConnected: (status) => statusOf(status).connected,
  disconnect: () => req<IntegrationsStatus>('/api/integrations/slack', { method: 'DELETE' }),
  disconnectCopy:
    'Stop @Doop mentions and pending Slack design work in this workspace. Existing canvases stay. To remove Doop from Slack too, uninstall the app in Slack’s workspace settings.',
}
