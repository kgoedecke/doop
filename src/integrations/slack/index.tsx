import { connectIntegration } from '../../lib/integrationConnect'
import { useState } from 'react'
import type { ClientIntegration, SettingsCardProps } from '../index'
import { ApiError, req, type IntegrationsStatus } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Note } from '../../components/ui/note'
import { DisconnectButton, IntegrationCard } from '../ui'
import { BrandMark } from '@/components/ui/brand-mark'
import { useT } from '@/lib/i18n'

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
  const t = useT()
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
        error instanceof ApiError
          ? String(error.body.error ?? t('automations.installFailed'))
          : t('automations.installFailed'),
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
          ? t('automations.doopAgentIn', { workspace: slack.workspaceName ?? t('automations.slackWorkspace') })
          : t('automations.slackPitch')
      }
      connected={slack.connected}
      footnote={
        slack.agentConfigured || slack.connected ? t('automations.slackFootnote') : t('automations.slackNeedsApp')
      }
      actions={
        slack.connected ? (
          <DisconnectButton disabled={busy} onClick={requestDisconnect} />
        ) : (
          <Button size="sm" disabled={busy || !slack.agentConfigured} onClick={() => void install()}>
            {t('automations.installSlack')}
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
  disconnectCopy: 'automations.slackDisconnectCopy',
}
