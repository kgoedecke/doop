import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { api } from '../lib/api'
import { isDesktopShell } from '../lib/shell'
import {
  disconnectLocalAgent,
  hasLocalClaude,
  invokeClaude,
  refreshLocalAgent,
  selectLocalAgent,
  useLocalAgent,
} from '../lib/localAgent'
import { CLAUDE_MODELS, normalizeClaudeModel, type ClaudeModel } from '../../shared/localAgent'
import { Button } from './ui/button'
import { AgentIcon } from './AgentIcon'
import { ToggleChip, ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { CheckIcon } from './ui/icons'
import { planRow, planMark, planPill, planAsCode, actionsRow } from './ui/model-plan'

export function LocalClaudeRow() {
  const { data: session } = authClient.useSession()
  const userId = session?.user.id
  const { preference, native, running, progress, error: runnerError } = useLocalAgent()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!userId) return
    const refresh = () => {
      refreshLocalAgent(userId).catch((e: unknown) => setError(String(e)))
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [userId])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const active = preference?.enabled ?? false
  const connected = !!native?.connected && !!native?.enabled
  const supported = hasLocalClaude()
  const selectedModel = normalizeClaudeModel(preference?.model)
  const choose = (model: ClaudeModel = selectedModel) =>
    act(async () => {
      if (!userId) return
      await selectLocalAgent(userId, { enabled: true, model })
    })

  return (
    <section className={planRow(active)}>
      <span aria-hidden="true" className={planMark(active)}>
        <AgentIcon name="claude" size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]">
          <h3 className="font-display text-[18px] font-extrabold normal-case tracking-[-0.02em] text-ink max-md:text-[17px]">
            Claude Plan
          </h3>
          <span className={planPill(connected)}>
            {connected ? (active ? 'Active · Connected' : 'Connected') : 'Not connected'}
          </span>
        </div>
        <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-soft max-md:text-[13.5px]">
          Route Claude models through your Claude subscription
        </p>
        {connected && native?.email && (
          <dl className="mt-[14px] grid grid-cols-[auto_auto] items-center justify-start gap-x-[14px] gap-y-2 text-[13px] text-ink-soft max-md:grid-cols-1 max-md:gap-[3px]">
            <dt>Connected as</dt>
            <dd className="min-w-0">
              <code className={planAsCode}>{native.email}</code>
            </dd>
            {native.plan && (
              <>
                <dt className="max-md:mt-2">Plan</dt>
                <dd className="min-w-0">
                  <code className={planAsCode}>{native.plan.charAt(0).toUpperCase() + native.plan.slice(1)}</code>
                </dd>
              </>
            )}
          </dl>
        )}
        <div className={actionsRow}>
          {connected ? (
            <ToggleChipGroup
              aria-label="Claude model"
              value={selectedModel}
              disabled={busy || running}
              onValueChange={(model) => choose(model as ClaudeModel)}
            >
              {CLAUDE_MODELS.map((model) => (
                <ToggleChipItem key={model.id} value={model.id}>
                  {model.id === selectedModel && (
                    <CheckIcon width={13} height={13} strokeWidth={2.5} color="#1a6b43" aria-hidden />
                  )}
                  {model.name}
                </ToggleChipItem>
              ))}
            </ToggleChipGroup>
          ) : (
            <div className="flex flex-wrap gap-[9px]">
              {CLAUDE_MODELS.map((model) => (
                <ToggleChip key={model.id} state="idle">
                  {model.name}
                </ToggleChip>
              ))}
            </div>
          )}
          {supported && (
            <div className="flex flex-wrap gap-2 max-md:[&>button]:flex-1">
              {!connected && (
                <Button variant="ghost" disabled={busy} onClick={() => act(() => refreshLocalAgent(userId!))}>
                  Refresh
                </Button>
              )}
              {native?.installed && !native.connected && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await invokeClaude('claude_login')
                      await refreshLocalAgent(userId!)
                    })
                  }
                >
                  {busy ? 'Signing in…' : 'Sign in'}
                </Button>
              )}
              {native?.connected && (!active || !connected) && (
                <Button disabled={busy} onClick={() => choose()}>
                  {active ? 'Connect' : 'Use instead'}
                </Button>
              )}
              {connected && (
                <Button variant="danger" disabled={busy} onClick={() => act(() => disconnectLocalAgent(userId!))}>
                  Disconnect
                </Button>
              )}
              {running && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await invokeClaude('claude_stop')
                      await api.stopLocalAgent()
                    })
                  }
                >
                  Stop task
                </Button>
              )}
            </div>
          )}
        </div>
        {!supported && (
          <p className="mt-[10px] text-[13px] text-ink-faint">
            {isDesktopShell() ? 'Update Doop to connect Claude.' : 'Connect in the desktop app.'}
          </p>
        )}
        {supported && native && !native.installed && (
          <p className="mt-[10px] text-[13px] text-ink-faint">
            <a className="underline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
              Install Claude Code
            </a>
            , then refresh.
          </p>
        )}
        {active && !connected && (
          <p className="mt-[10px] text-[13px] text-ink-faint">Waiting for a connected desktop.</p>
        )}
        {(running || runnerError) && (
          <details className="mt-[10px] text-[13px] text-ink-soft">
            <summary className={runnerError ? 'cursor-pointer text-accent-ink' : 'cursor-pointer'}>
              {running ? 'Working…' : 'Last task failed'}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-sans" aria-live="polite">
              {runnerError || progress}
            </pre>
          </details>
        )}
        {error && (
          <p role="alert" className="mt-[10px] text-[12.5px] text-accent-ink">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}
