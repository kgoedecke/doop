import { useState } from 'react'
import type { ClientIntegration, SettingsCardProps } from '../index'
import { ApiError, req, type IntegrationsStatus } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { DisconnectButton, IntegrationCard } from '../ui'

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
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.29),
        background: '#5E6AD2',
        color: 'white',
        fontWeight: 600,
      }}
    >
      L
    </span>
  )
}

function LinearSettingsCard({ status, busy, setBusy, setStatus, requestDisconnect, showToast }: SettingsCardProps) {
  const linear = statusOf(status)
  const [token, setToken] = useState('')
  const [replacing, setReplacing] = useState(false)
  const hasKey = linear.personalConnected ?? (linear.connected && !linear.agent?.connected)
  const [error, setError] = useState<string | null>(null)

  async function installAgent() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { url } = await req<{ url: string }>('/api/integrations/linear/start', { method: 'POST' })
      location.assign(url)
    } catch (error) {
      setError(
        error instanceof ApiError ? String(error.body.error ?? 'Could not install Doop.') : 'Could not install Doop.',
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
      showToast(hasKey ? 'Linear key replaced.' : 'Linear connected.')
    } catch (error) {
      setError(
        error instanceof ApiError
          ? String(error.body.error ?? 'Could not connect Linear.')
          : 'Could not connect Linear.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <IntegrationCard
      tile={<LinearTile size={36} />}
      name="Linear"
      detail={
        linear.agent?.connected
          ? `Doop agent · ${linear.agent.workspaceName}`
          : linear.connected
            ? (linear.accountName ?? 'Linear account')
            : 'Delegate tickets to the Doop design agent'
      }
      connected={linear.connected}
      footnote={
        linear.agent?.connected
          ? 'Delegate an issue to Doop in Linear. The design and canvas link arrive automatically.'
          : linear.connected
            ? 'Read-only ticket access'
            : ''
      }
      actions={
        linear.connected ? (
          <>
            {hasKey && !replacing && (
              <Button
                variant="bare"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setToken('')
                  setError(null)
                  setReplacing(true)
                }}
              >
                Replace key
              </Button>
            )}
            <DisconnectButton disabled={busy} onClick={requestDisconnect} />
          </>
        ) : null
      }
    >
      {linear.agentConfigured && !linear.agent?.connected && (
        <div className="flex flex-col gap-2">
          <p className="text-[11.5px] leading-[1.45] text-ink-faint">
            Install Doop in a Linear workspace you administer. Delegated tickets create private canvases in your Doop
            account and run on your connected model account or task allowance. Workspace members who can delegate to
            Doop can start these runs.
          </p>
          <Button size="sm" disabled={busy} onClick={() => void installAgent()}>
            Install Doop agent
          </Button>
        </div>
      )}
      {!linear.agentConfigured && !linear.agent?.connected && (
        <p className="text-[11.5px] text-ink-faint">
          Automatic design pickup needs a Linear app configured by this server’s administrator.
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11.5px] text-accent-ink">
          {error}
        </p>
      )}
      {(!linear.connected || replacing) && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void connect()
          }}
        >
          <p className="text-[11.5px] leading-[1.45] text-ink-faint">
            Create a personal API key in Linear under{' '}
            <a
              href="https://linear.app/settings/account/security"
              target="_blank"
              rel="noreferrer"
              className="text-ink-soft underline underline-offset-2"
            >
              Settings → Security &amp; access
            </a>{' '}
            with read access to the teams you want agents to see. The key is stored on the server.
          </p>
          <div className="flex gap-2">
            <Input
              type="password"
              autoComplete="off"
              aria-label="Linear personal API key"
              placeholder="lin_api_…"
              value={token}
              disabled={busy}
              className="min-w-0 flex-1 bg-paper focus:ring-0"
              onChange={(event) => {
                setToken(event.target.value)
                setError(null)
              }}
            />
            <Button type="submit" size="sm" disabled={busy || !token.trim()}>
              {busy ? 'Checking…' : replacing ? 'Save key' : 'Connect'}
            </Button>
          </div>
          {replacing && (
            <>
              <p className="text-[11.5px] text-ink-faint">
                Your current key stays connected until the replacement is verified.
              </p>
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
                Cancel
              </Button>
            </>
          )}
        </form>
      )}
    </IntegrationCard>
  )
}

export const linearIntegration: ClientIntegration = {
  id: 'linear',
  name: 'Linear',
  Tile: LinearTile,
  SettingsCard: LinearSettingsCard,
  isConnected: (status) => statusOf(status).connected,
  disconnect: () => req<IntegrationsStatus>('/api/integrations/linear', { method: 'DELETE' }),
  disconnectCopy:
    'Stop automatic pickup and pending Linear design work, and remove ticket access. Existing canvases stay. To remove the Doop agent from Linear too, uninstall the app in Linear Settings.',
}
