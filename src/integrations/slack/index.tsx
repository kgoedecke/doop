import { connectIntegration } from '../../lib/integrationConnect'
import { useState } from 'react'
import type { ClientIntegration, SettingsCardProps } from '../index'
import { ApiError, req, type IntegrationsStatus } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Note } from '../../components/ui/note'
import { DisconnectButton, IntegrationCard } from '../ui'
import { BrandMark } from '@/components/ui/brand-mark'

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
  return <BrandMark brand="slack" size={size} className={className} />
}

function SlackSettingsCard({ status, busy, setBusy, requestDisconnect }: SettingsCardProps) {
  const slack = statusOf(status)
  const [error, setError] = useState<string | null>(null)

  async function install() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if ((await connectIntegration('slack')) === 'browser') setBusy(false)
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
        <Note role="alert" tone="error">
          {error}
        </Note>
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
