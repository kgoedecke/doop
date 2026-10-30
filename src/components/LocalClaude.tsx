import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { api } from '../lib/api'
import { isDesktopShell } from '../lib/shell'
import {
  disconnectLocalAgent,
  hasLocalClaude,
  canChooseClaude,
  canInstallClaude,
  invokeClaude,
  refreshLocalAgent,
  selectLocalAgent,
  useLocalAgent,
} from '../lib/localAgent'
import {
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODELS,
  isClaudeModel,
  normalizeClaudeModel,
  type ClaudeEffort,
  type ClaudeModel,
} from '../../shared/localAgent'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Segmented, SegmentedItem } from './ui/segmented'
import { Disclosure } from './ui/collapsible'
import { AgentIcon } from './AgentIcon'
import { ToggleChip, ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { CheckIcon, DesktopIcon, DownloadIcon } from './ui/icons'
import { cn } from '@/lib/utils'
import { planRow, planMark, planPill, planAsCode, actionsRow } from './ui/model-plan'

const DESKTOP_DOWNLOAD_URL = 'https://doop.design/download/mac'

/** How the desktop found the Claude Code it runs, closing the "Using …" line. */
const CLI_SOURCE_NOTE = {
  chosen: ', chosen by you.',
  shell: ', the one your terminal runs.',
  found: ', the newest install found.',
} as const

/** The plan as a browser sees it: nothing to connect here, so the row is
 *  muted and its only action is getting the desktop app. */
function DesktopOnlyClaudeRow({ active }: { active: boolean }) {
  return (
    <section aria-label="Claude Plan — desktop app" className={cn(planRow(false), 'bg-paper-deep/60')}>
      <span aria-hidden="true" className={cn(planMark(false), 'border-line bg-paper-deep opacity-50 grayscale')}>
        <AgentIcon name="claude" size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]">
          <h3 className="font-display text-[18px] font-extrabold normal-case tracking-[-0.02em] text-ink-soft max-md:text-[17px]">
            Claude Plan
          </h3>
          <span className={cn(planPill(false), 'inline-flex items-center gap-[5px] bg-paper-deep text-ink-soft')}>
            <DesktopIcon width={14} height={14} aria-hidden />
            Desktop app
          </span>
        </div>
        <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-soft max-md:text-[13.5px]">
          Use your Claude subscription locally.
        </p>
        <div className="mt-[18px] flex flex-wrap gap-[9px]">
          {CLAUDE_MODELS.map((model) => (
            <ToggleChip key={model.id} state="idle" className="bg-paper-deep text-ink-faint opacity-100">
              {model.name}
            </ToggleChip>
          ))}
        </div>
        <div className="mt-[13px] flex items-center justify-between gap-5 max-md:flex-col max-md:items-start max-md:gap-2">
          <p className="text-[13px] text-ink-faint">
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
  const selectedEffort = preference?.effort
  /* an alias is on the chip row; a pinned id wears its own chip beside them */
  const pinnedModel = CLAUDE_MODELS.some((model) => model.id === selectedModel) ? undefined : selectedModel
  const selectedBlurb = pinnedModel
    ? 'Pinned to this exact model id; the aliases follow new releases on their own.'
    : CLAUDE_MODELS.find((model) => model.id === selectedModel)?.blurb
  const [pin, setPin] = useState('')
  const choose = (next: { model?: ClaudeModel; effort?: ClaudeEffort | undefined } = {}) =>
    act(async () => {
      if (!userId) return
      if (!active || !connected) {
        const { native: current } = await refreshLocalAgent(userId)
        if (!current?.installed) throw new Error('Install Claude Code to connect.')
        if (!current.connected) throw new Error('Sign in to Claude Code to connect.')
      }
      const effort = 'effort' in next ? next.effort : selectedEffort
      await selectLocalAgent(userId, {
        enabled: true,
        model: next.model ?? selectedModel,
        ...(effort ? { effort } : {}),
      })
      setPin('')
    })
  const chooseCli = () =>
    act(async () => {
      if (await invokeClaude<boolean>('claude_choose_cli')) await refreshLocalAgent(userId!)
    })
  const resetCli = () =>
    act(async () => {
      await invokeClaude('claude_reset_cli')
      await refreshLocalAgent(userId!)
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
              value={pinnedModel ? '' : selectedModel}
              disabled={busy || running}
              onValueChange={(model) => choose({ model })}
            >
              {CLAUDE_MODELS.map((model) => (
                <ToggleChipItem key={model.id} value={model.id} title={model.blurb}>
                  {model.id === selectedModel && (
                    <CheckIcon width={13} height={13} strokeWidth={2.5} color="var(--success-ink)" aria-hidden />
                  )}
                  {model.name}
                </ToggleChipItem>
              ))}
              {pinnedModel && (
                <ToggleChip state="on" title={selectedBlurb}>
                  <CheckIcon width={13} height={13} strokeWidth={2.5} color="var(--success-ink)" aria-hidden />
                  {pinnedModel}
                </ToggleChip>
              )}
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
              {!connected && (error || native?.outdated) && (
                <Button variant="ghost" disabled={busy} onClick={() => act(() => refreshLocalAgent(userId!, true))}>
                  Refresh
                </Button>
              )}
              {native?.installed && !native.connected && !native.outdated && (
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
        {connected && (
          <>
            <p className="mt-[10px] text-[13px] text-ink-faint">{selectedBlurb}</p>
            <div className="mt-[10px] flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-[13px] text-ink-soft">Reasoning effort</span>
              <Segmented
                aria-label="Reasoning effort"
                value={selectedEffort ?? 'default'}
                disabled={busy || running}
                onValueChange={(effort) =>
                  choose({ effort: effort === 'default' ? undefined : (effort as ClaudeEffort) })
                }
              >
                <SegmentedItem value="default" title="Whatever your Claude Code is set to">
                  Default
                </SegmentedItem>
                {CLAUDE_EFFORT_OPTIONS.map((effort) => (
                  <SegmentedItem key={effort.id} value={effort.id} title={effort.blurb}>
                    {effort.name}
                  </SegmentedItem>
                ))}
              </Segmented>
            </div>
            <div className="mt-[10px] flex flex-wrap items-center gap-2">
              <Input
                aria-label="Pin a model id"
                className="w-[260px] max-md:w-full"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="Pin a model id, e.g. claude-opus-5-20260901"
                spellCheck={false}
                disabled={busy || running}
              />
              <Button
                disabled={busy || running || !isClaudeModel(pin.trim())}
                onClick={() => choose({ model: pin.trim() })}
              >
                Pin
              </Button>
            </div>
          </>
        )}
        {!supported && <p className="mt-[10px] text-[13px] text-ink-faint">Update Doop to connect Claude.</p>}
        {supported && native?.installed && native.outdated && (
          <p className="mt-[10px] text-[13px] text-ink-faint">
            Claude Code {native.cliVersion ?? ''} at <code className={planAsCode}>{native.cliPath}</code> is older than
            the {native.minVersion ?? ''} Doop needs. Run <code className={planAsCode}>claude update</code> in a
            terminal, or {canChooseClaude() ? 'choose another install' : 'remove it so Doop finds your newer install'},
            then Refresh.
          </p>
        )}
        {/* shown with no install found too: one Doop did not find can still be picked */}
        {supported && native && canChooseClaude() && (
          <div className="mt-[10px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-faint">
            {!native.installed && <p className="min-w-0">Installed somewhere Doop did not look?</p>}
            {/* an outdated install is already named in the warning above */}
            {native.installed && !native.outdated && (
              <p className="min-w-0">
                {native.chosenMissing && (
                  <>
                    The Claude Code you chose at <code className={planAsCode}>{native.chosenMissing}</code> is
                    gone.{' '}
                  </>
                )}
                Using Claude Code{native.cliVersion ? ` ${native.cliVersion}` : ''} at{' '}
                <code className={planAsCode}>{native.cliPath}</code>
                {native.cliSource ? CLI_SOURCE_NOTE[native.cliSource] : '.'}
              </p>
            )}
            <Button variant="link" size="inline" disabled={busy || running} onClick={chooseCli}>
              Choose…
            </Button>
            {(native.cliSource === 'chosen' || native.chosenMissing) && (
              <Button variant="link" size="inline" disabled={busy || running} onClick={resetCli}>
                Use default
              </Button>
            )}
          </div>
        )}
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
          <Disclosure
            label={running ? 'Working…' : 'Last task failed'}
            className="mt-[10px] text-[13px] text-ink-soft"
            triggerClassName={cn(runnerError && 'text-accent-ink')}
          >
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-sans" aria-live="polite">
              {runnerError || progress}
            </pre>
          </Disclosure>
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
