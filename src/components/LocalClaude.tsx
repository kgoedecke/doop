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
  type ClaudeModelAlias,
} from '../../shared/localAgent'
import { useT, type PlainMessageKey } from '../lib/i18n'
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
const CLI_SOURCE_NOTE: Record<'chosen' | 'shell' | 'found', PlainMessageKey> = {
  chosen: 'models.cliSourceChosen',
  shell: 'models.cliSourceShell',
  found: 'models.cliSourceFound',
}

/** The shared model list's blurbs in the reader's language. The alias names
 *  (Fable, Opus…) are model names and stay; only the default gets a label. */
const MODEL_BLURBS: Record<ClaudeModelAlias, PlainMessageKey> = {
  fable: 'models.claudeFableBlurb',
  opus: 'models.claudeOpusBlurb',
  sonnet: 'models.claudeSonnetBlurb',
  haiku: 'models.claudeHaikuBlurb',
  default: 'models.claudeDefaultBlurb',
}

/** `--effort` labels; the ids are what the CLI is given. */
const EFFORT_LABELS: Record<ClaudeEffort, { name: PlainMessageKey; blurb: PlainMessageKey }> = {
  low: { name: 'models.effortLow', blurb: 'models.claudeEffortLowBlurb' },
  medium: { name: 'models.effortMedium', blurb: 'models.claudeEffortMediumBlurb' },
  high: { name: 'models.effortHigh', blurb: 'models.claudeEffortHighBlurb' },
  xhigh: { name: 'models.effortXhigh', blurb: 'models.claudeEffortXhighBlurb' },
  max: { name: 'models.effortMax', blurb: 'models.claudeEffortMaxBlurb' },
}

/** A model chip's name: the alias as is, the CLI default in words. */
function useModelName(): (model: (typeof CLAUDE_MODELS)[number]) => string {
  const t = useT()
  return (model) => (model.id === 'default' ? t('models.claudeDefaultModel') : model.name)
}

/** The plan as a browser sees it: nothing to connect here, so the row is
 *  muted and its only action is getting the desktop app. */
function DesktopOnlyClaudeRow({ active }: { active: boolean }) {
  const t = useT()
  const modelName = useModelName()
  return (
    <section aria-label={t('models.claudePlanDesktopAria')} className={cn(planRow(false), 'bg-paper-deep/60')}>
      <span aria-hidden="true" className={cn(planMark(false), 'border-line bg-paper-deep opacity-50 grayscale')}>
        <AgentIcon name="claude" size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-[10px] max-md:flex-wrap max-md:items-start max-md:gap-x-[9px] max-md:gap-y-[6px]">
          <h3 className="font-display text-[18px] font-extrabold normal-case tracking-[-0.02em] text-ink-soft max-md:text-[17px]">
            {t('models.claudePlan')}
          </h3>
          <span className={cn(planPill(false), 'inline-flex items-center gap-[5px] bg-paper-deep text-ink-soft')}>
            <DesktopIcon width={14} height={14} aria-hidden />
            {t('models.desktopApp')}
          </span>
        </div>
        <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-soft max-md:text-[13.5px]">
          {t('models.claudePlanLede')}
        </p>
        <div className="mt-[18px] flex flex-wrap gap-[9px]">
          {CLAUDE_MODELS.map((model) => (
            <ToggleChip key={model.id} state="idle" className="bg-paper-deep text-ink-faint opacity-100">
              {modelName(model)}
            </ToggleChip>
          ))}
        </div>
        <div className="mt-[13px] flex items-center justify-between gap-5 max-md:flex-col max-md:items-start max-md:gap-2">
          <p className="text-[13px] text-ink-faint">{active ? t('models.waitingDesktop') : t('models.useInDesktop')}</p>
          <a
            className="inline-flex items-center gap-[7px] py-1 text-[13px] font-semibold text-brand hover:underline"
            href={DESKTOP_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer"
          >
            <DownloadIcon width={15} height={15} strokeWidth={1.8} aria-hidden />
            {t('models.downloadDesktop')}
          </a>
        </div>
      </div>
    </section>
  )
}

export function LocalClaudeRow() {
  const t = useT()
  const modelName = useModelName()
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
  const selectedAlias = CLAUDE_MODELS.find((model) => model.id === selectedModel)
  const selectedBlurb = pinnedModel ? t('models.pinnedBlurb') : selectedAlias && t(MODEL_BLURBS[selectedAlias.id])
  const [pin, setPin] = useState('')
  const choose = (next: { model?: ClaudeModel; effort?: ClaudeEffort | undefined } = {}) =>
    act(async () => {
      if (!userId) return
      if (!active || !connected) {
        const { native: current } = await refreshLocalAgent(userId)
        if (!current?.installed) throw new Error(t('models.installToConnect'))
        if (!current.connected) throw new Error(t('models.signInToConnect'))
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
            {t('models.claudePlan')}
          </h3>
          <span className={planPill(connected)}>
            {connected ? (active ? t('models.activeConnected') : t('models.connected')) : t('models.notConnected')}
          </span>
        </div>
        <p className="mt-1.5 text-[14px] leading-[1.55] text-ink-soft max-md:text-[13.5px]">
          {t('models.claudePlanLede')}
        </p>
        {connected && native?.email && (
          <dl className="mt-[14px] grid grid-cols-[auto_auto] items-center justify-start gap-x-[14px] gap-y-2 text-[13px] text-ink-soft max-md:grid-cols-1 max-md:gap-[3px]">
            <dt>{t('models.connectedAs')}</dt>
            <dd className="min-w-0">
              <code className={planAsCode}>{native.email}</code>
            </dd>
            {native.plan && (
              <>
                <dt className="max-md:mt-2">{t('models.plan')}</dt>
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
              aria-label={t('models.claudeModelAria')}
              value={pinnedModel ? '' : selectedModel}
              disabled={busy || running}
              onValueChange={(model) => choose({ model })}
            >
              {CLAUDE_MODELS.map((model) => (
                <ToggleChipItem key={model.id} value={model.id} title={t(MODEL_BLURBS[model.id])}>
                  {model.id === selectedModel && (
                    <CheckIcon width={13} height={13} strokeWidth={2.5} color="var(--success-ink)" aria-hidden />
                  )}
                  {modelName(model)}
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
                  {modelName(model)}
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
                  {installing ? t('models.installing') : t('models.installClaude')}
                </Button>
              )}
              {!connected && (error || native?.outdated) && (
                <Button variant="ghost" disabled={busy} onClick={() => act(() => refreshLocalAgent(userId!, true))}>
                  {t('models.refresh')}
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
                  {busy ? t('models.signingIn') : t('models.signIn')}
                </Button>
              )}
              {native?.connected && (!active || !connected) && (
                <Button disabled={busy} onClick={() => choose()}>
                  {active ? t('models.connect') : t('models.useInstead')}
                </Button>
              )}
              {connected && (
                <Button variant="danger" disabled={busy} onClick={() => act(() => disconnectLocalAgent(userId!))}>
                  {t('models.disconnect')}
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
                  {t('models.stopTask')}
                </Button>
              )}
            </div>
          )}
        </div>
        {connected && (
          <>
            <p className="mt-[10px] text-[13px] text-ink-faint">{selectedBlurb}</p>
            <div className="mt-[10px] flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-[13px] text-ink-soft">{t('models.reasoningEffort')}</span>
              <Segmented
                aria-label={t('models.reasoningEffort')}
                value={selectedEffort ?? 'default'}
                disabled={busy || running}
                onValueChange={(effort) =>
                  choose({ effort: effort === 'default' ? undefined : (effort as ClaudeEffort) })
                }
              >
                <SegmentedItem value="default" title={t('models.effortDefaultBlurb')}>
                  {t('models.effortDefault')}
                </SegmentedItem>
                {CLAUDE_EFFORT_OPTIONS.map((effort) => (
                  <SegmentedItem key={effort.id} value={effort.id} title={t(EFFORT_LABELS[effort.id].blurb)}>
                    {t(EFFORT_LABELS[effort.id].name)}
                  </SegmentedItem>
                ))}
              </Segmented>
            </div>
            <div className="mt-[10px] flex flex-wrap items-center gap-2">
              <Input
                aria-label={t('models.pinAria')}
                className="w-[260px] max-md:w-full"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder={t('models.pinPlaceholder')}
                spellCheck={false}
                disabled={busy || running}
              />
              <Button
                disabled={busy || running || !isClaudeModel(pin.trim())}
                onClick={() => choose({ model: pin.trim() })}
              >
                {t('models.pin')}
              </Button>
            </div>
          </>
        )}
        {!supported && <p className="mt-[10px] text-[13px] text-ink-faint">{t('models.updateDoop')}</p>}
        {supported && native?.installed && native.outdated && (
          <p className="mt-[10px] text-[13px] text-ink-faint">
            {t('models.outdatedBefore', { version: native.cliVersion ?? '' })}
            <code className={planAsCode}>{native.cliPath}</code>
            {t('models.outdatedMiddle', { min: native.minVersion ?? '' })}
            <code className={planAsCode}>claude update</code>
            {t('models.outdatedAfter', {
              fix: canChooseClaude() ? t('models.outdatedChoose') : t('models.outdatedRemove'),
            })}
          </p>
        )}
        {/* shown with no install found too: one Doop did not find can still be picked */}
        {supported && native && canChooseClaude() && (
          <div className="mt-[10px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-faint">
            {!native.installed && <p className="min-w-0">{t('models.notFoundHere')}</p>}
            {/* an outdated install is already named in the warning above */}
            {native.installed && !native.outdated && (
              <p className="min-w-0">
                {native.chosenMissing && (
                  <>
                    {t('models.chosenMissingBefore')}
                    <code className={planAsCode}>{native.chosenMissing}</code>
                    {t('models.chosenMissingAfter')}{' '}
                  </>
                )}
                {native.cliVersion ? t('models.usingVersion', { version: native.cliVersion }) : t('models.using')}{' '}
                <code className={planAsCode}>{native.cliPath}</code>
                {native.cliSource ? t(CLI_SOURCE_NOTE[native.cliSource]) : '.'}
              </p>
            )}
            <Button variant="link" size="inline" disabled={busy || running} onClick={chooseCli}>
              {t('models.chooseCli')}
            </Button>
            {(native.cliSource === 'chosen' || native.chosenMissing) && (
              <Button variant="link" size="inline" disabled={busy || running} onClick={resetCli}>
                {t('models.useDefault')}
              </Button>
            )}
          </div>
        )}
        {supported && native && !native.installed && (
          <p className="mt-[10px] text-[13px] text-ink-faint">
            <a className="underline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
              {t('models.installGuide')}
            </a>
          </p>
        )}
        {active && !connected && <p className="mt-[10px] text-[13px] text-ink-faint">{t('models.waitingDesktop')}</p>}
        {(running || runnerError) && (
          <Disclosure
            label={running ? t('models.working') : t('models.lastTaskFailed')}
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
