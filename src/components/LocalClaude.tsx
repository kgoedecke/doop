import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { api } from '../lib/api'
import { isDesktopShell } from '../lib/shell'
import {
  disconnectLocalAgent,
  hasLocalClaude,
  canInstallClaude,
  invokeClaude,
  refreshLocalAgent,
  selectLocalAgent,
  useLocalAgent,
} from '../lib/localAgent'
import { CLAUDE_MODELS, normalizeClaudeModel, type ClaudeModel } from '../../shared/localAgent'
import { Button } from './ui/button'
import { AgentIcon } from './AgentIcon'
import { ToggleChip, ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { CheckIcon, DesktopIcon, DownloadIcon } from './ui/icons'
import { cn } from '@/lib/utils'
import { planRow, planMark, planPill, planAsCode, actionsRow } from './ui/model-plan'

const DESKTOP_DOWNLOAD_URL = 'https://doop.design/download/mac'

/** The plan as a browser sees it: nothing to connect here, so the row is
 *  muted and its only action is getting the desktop app. */
function DesktopOnlyClaudeRow({ active }: { active: boolean }) {
  return (
    <section aria-label="Claude Plan — desktop app" className={cn(planRow(false), 'bg-[#fafafa]')}>
      <span aria-hidden="true" className={cn(planMark(false), 'border-[#e5e5e3] bg-[#f0f0ef] opacity-45 grayscale')}>
        <AgentIcon name="claude" size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]">
          <h3 className="font-display text-[18px] font-extrabold normal-case tracking-[-0.02em] text-[#8a8a86] max-md:text-[17px]">
            Claude Plan
          </h3>
          <span className={cn(planPill(false), 'inline-flex items-center gap-[5px] bg-[#ededeb] text-[#74746e]')}>
            <DesktopIcon width={14} height={14} aria-hidden />
            Desktop app
          </span>
        </div>
        <p className="mt-1.5 text-[14px] leading-[1.55] text-[#92928d] max-md:text-[13.5px]">
          Use your Claude subscription locally.
        </p>
        <div className="mt-[18px] flex flex-wrap gap-[9px]">
          {CLAUDE_MODELS.map((model) => (
            <ToggleChip key={model.id} state="idle" className="bg-[#f0f0ee] text-[#9b9b96] opacity-100">
              {model.name}
            </ToggleChip>
          ))}
        </div>
        <div className="mt-[13px] flex items-center justify-between gap-5 max-md:flex-col max-md:items-start max-md:gap-2">
          <p className="text-[13px] text-[#7b7b75]">
            {active ? 'Waiting for a connected desktop.' : 'Use this plan in the Doop desktop app.'}
          </p>
          <a
            className="inline-flex items-center gap-[7px] py-1 text-[13px] font-semibold text-brand hover:underline"
            href={DESKTOP_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer"
          >
            <DownloadIcon width={15} height={15} strokeWidth={1.8} aria-hidden />
            Download desktop app
          </a>
        </div>
      </div>
    </section>
  )
}

export function LocalClaudeRow() {
  const { data: session } = authClient.useSession()
  const userId = session?.user.id
  const { preference, native, running, progress, error: runnerError } = useLocalAgent()
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(false)
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
  const selectedBlurb = CLAUDE_MODELS.find((model) => model.id === selectedModel)?.blurb
  const choose = (model: ClaudeModel = selectedModel) =>
    act(async () => {
      if (!userId) return
      if (!active || !connected) {
        const { native: current } = await refreshLocalAgent(userId)
        if (!current?.installed) throw new Error('Install Claude Code to connect.')
        if (!current.connected) throw new Error('Sign in to Claude Code to connect.')
      }
      await selectLocalAgent(userId, { enabled: true, model })
    })

  if (!isDesktopShell()) return <DesktopOnlyClaudeRow active={active} />

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
          Use your Claude subscription locally.
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
                <ToggleChipItem key={model.id} value={model.id} title={model.blurb}>
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
              {native && !native.installed && canInstallClaude() && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      setInstalling(true)
                      try {
                        await invokeClaude('claude_install')
                        await refreshLocalAgent(userId!)
                      } finally {
                        setInstalling(false)
                      }
                    })
                  }
                >
                  {installing ? 'Installing…' : 'Install Claude Code'}
                </Button>
              )}
              {!connected && error && (
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
        {connected && <p className="mt-[10px] text-[13px] text-ink-faint">{selectedBlurb}</p>}
        {!supported && <p className="mt-[10px] text-[13px] text-ink-faint">Update Doop to connect Claude.</p>}
        {supported && native && !native.installed && (
          <p className="mt-[10px] text-[13px] text-ink-faint">
            <a className="underline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
              Installation guide
            </a>
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
