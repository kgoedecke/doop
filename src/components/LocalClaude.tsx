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
import { AvailableRow, ConnectionRow, ModelSelect } from './ConnectionTable'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Disclosure } from './ui/collapsible'
import { AppIcon } from './ui/brand-mark'
import { DownloadIcon } from './ui/icons'
import { cn } from '@/lib/utils'
import { DOWNLOAD_URL } from '../lib/siteLinks'

/* a path or command inside the panel's prose */
const codeChip =
  'inline-block rounded-[6px] bg-surface px-[7px] py-px font-mono text-[11.5px] text-ink shadow-ring [overflow-wrap:anywhere]'

/** How the desktop found the Claude Code it runs, beside its version. */
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

/** What the Settings pane tells the Plan's row: whether it is the default,
 *  how to make it so, and what to re-read after the row changes the Plan. */
interface PlanRowProps {
  isDefault?: boolean
  onMakeDefault?: () => void
  onChange?: () => void
}

/** The plan as a browser sees it: nothing to connect here, so the row points
 *  at the desktop app instead of offering controls it cannot run. */
function DesktopOnlyClaudeRow({ active }: { active: boolean }) {
  const t = useT()
  return (
    <AvailableRow
      mark={<AppIcon brand="claude-code" />}
      name={t('models.claudePlan')}
      sub={active ? t('models.waitingDesktop') : t('models.desktopOnly')}
      action={
        <a
          className="inline-flex items-center gap-[6px] py-1 text-[12.5px] font-medium text-brand hover:underline"
          href={DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
        >
          <DownloadIcon width={14} height={14} strokeWidth={1.8} aria-hidden />
          {t('models.downloadShort')}
        </a>
      }
    />
  )
}

export function LocalClaudeRow({ isDefault = false, onMakeDefault, onChange }: PlanRowProps = {}) {
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
      /* the pane's default can follow the Plan switching on or off */
      onChange?.()
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
  const [pin, setPin] = useState('')
  /* Connecting turns the Plan on; once connected, a model or effort change
     keeps the switch where it is, and the switch alone turns it on or off. */
  const choose = (next: { model?: ClaudeModel; effort?: ClaudeEffort | undefined; enabled?: boolean } = {}) =>
    act(async () => {
      if (!userId) return
      const enabled = next.enabled ?? (connected ? active : true)
      if (enabled && (!active || !connected)) {
        const { native: current } = await refreshLocalAgent(userId)
        if (!current?.installed) throw new Error(t('models.installToConnect'))
        if (!current.connected) throw new Error(t('models.signInToConnect'))
      }
      const effort = 'effort' in next ? next.effort : selectedEffort
      await selectLocalAgent(userId, {
        enabled,
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

  /* the Claude Code settings (which CLI, a pinned model), from the row's menu */
  const [settingsOpen, setSettingsOpen] = useState(false)

  if (!isDesktopShell()) return <DesktopOnlyClaudeRow active={active} />

  const models = [
    ...CLAUDE_MODELS.map((model) => ({ id: model.id, name: modelName(model), blurb: t(MODEL_BLURBS[model.id]) })),
    /* a pinned id is a model of its own until an alias is picked again */
    ...(pinnedModel ? [{ id: pinnedModel, name: pinnedModel, blurb: t('models.pinnedBlurb') }] : []),
  ]
  const efforts = [
    { id: 'default', name: t('models.effortDefault'), blurb: t('models.effortDefaultBlurb') },
    ...CLAUDE_EFFORT_OPTIONS.map((effort) => ({
      id: effort.id,
      name: t(EFFORT_LABELS[effort.id].name),
      blurb: t(EFFORT_LABELS[effort.id].blurb),
    })),
  ]

  /* which Claude Code runs: its version and how it was found, the path on a
     line of its own, then the buttons to pick another or go back */
  const cliChooser =
    supported && native && canChooseClaude() ? (
      <div className="flex flex-col gap-2.5">
        {!native.installed && <p>{t('models.notFoundHere')}</p>}
        {native.chosenMissing && (
          <p>
            {t('models.chosenMissingBefore')}
            <code className={codeChip}>{native.chosenMissing}</code>
            {t('models.chosenMissingAfter')}
          </p>
        )}
        {/* an outdated install is already named in the warning above */}
        {native.installed && !native.outdated && native.cliPath && (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-body font-medium text-ink">
                {native.cliVersion ? t('models.usingVersion', { version: native.cliVersion }) : t('models.using')}
              </span>
              {native.cliSource && (
                <span className="text-label text-ink-faint">{t(CLI_SOURCE_NOTE[native.cliSource])}</span>
              )}
            </div>
            <code
              title={native.cliPath}
              className="block truncate rounded-control bg-sub px-3 py-2 font-mono text-label text-ink shadow-ring"
            >
              {native.cliPath}
            </code>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || running} onClick={chooseCli}>
            {t('models.chooseCli')}
          </Button>
          {(native.cliSource === 'chosen' || native.chosenMissing) && (
            <Button variant="ghost" disabled={busy || running} onClick={resetCli}>
              {t('models.useDefault')}
            </Button>
          )}
        </div>
      </div>
    ) : null

  /* an exact model id in place of the alias */
  const pinField = (
    <div className="flex items-center gap-2">
      <Input
        aria-label={t('models.pinAria')}
        className="min-w-0 flex-1 font-mono"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        placeholder={t('models.pinPlaceholder')}
        spellCheck={false}
        disabled={busy || running}
      />
      <Button
        className="flex-none"
        disabled={busy || running || !isClaudeModel(pin.trim())}
        onClick={() => choose({ model: pin.trim() })}
      >
        {t('models.pin')}
      </Button>
    </div>
  )

  const panel = (
    <div className="flex flex-col gap-[10px]">
      {!supported && <p>{t('models.updateDoop')}</p>}
      {supported && native?.installed && native.outdated && (
        <p>
          {t('models.outdatedBefore', { version: native.cliVersion ?? '' })}
          <code className={codeChip}>{native.cliPath}</code>
          {t('models.outdatedMiddle', { min: native.minVersion ?? '' })}
          <code className={codeChip}>claude update</code>
          {t('models.outdatedAfter', {
            fix: canChooseClaude() ? t('models.outdatedChoose') : t('models.outdatedRemove'),
          })}
        </p>
      )}
      {/* shown with no install found too: one Doop did not find can still be
          picked; once connected it lives in the Claude Code settings */}
      {!connected && cliChooser}
      {supported && native && !native.installed && (
        <p>
          <a className="underline" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
            {t('models.installGuide')}
          </a>
        </p>
      )}
      {active && !connected && <p>{t('models.waitingDesktop')}</p>}
      {supported && (
        <div className="flex flex-wrap gap-2 empty:hidden max-md:[&>button]:flex-1">
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
      {(running || runnerError) && (
        <Disclosure
          label={running ? t('models.working') : t('models.lastTaskFailed')}
          className="text-ink-soft"
          triggerClassName={cn(runnerError && 'text-accent-ink')}
        >
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-sans" aria-live="polite">
            {runnerError || progress}
          </pre>
        </Disclosure>
      )}
      {error && (
        <p role="alert" className="text-accent-ink">
          {error}
        </p>
      )}
    </div>
  )

  if (!connected) {
    return (
      <AvailableRow
        mark={<AppIcon brand="claude-code" />}
        name={t('models.claudePlan')}
        sub={t('models.claudePlanShort')}
        action={
          /* a shell without the CLI bridge can only point at an update, in the panel */
          supported ? (
            <Button size="sm" disabled={busy} onClick={() => void choose({ enabled: true })}>
              {t('models.connect')}
            </Button>
          ) : undefined
        }
        /* which Claude Code runs, and what is missing, before anyone connects */
        panel={panel}
        open
      />
    )
  }

  /* under a connected row only while there is something to see: the pin
     field, a task under way or failed, a warning */
  const showPanel = running || !!runnerError || !!error || !!native?.outdated
  const menuItems = [{ label: t('models.claudeCodeSettings'), onSelect: () => setSettingsOpen(true) }]

  return (
    <>
      <ConnectionRow
        mark={<AppIcon brand="claude-code" />}
        name={t('models.claudePlan')}
        sub={
          native?.plan
            ? `${t('models.thisMac')} · ${native.plan.charAt(0).toUpperCase()}${native.plan.slice(1)}`
            : t('models.thisMac')
        }
        state={active ? 'on' : 'off'}
        isDefault={isDefault}
        busy={busy || running}
        model={
          <ModelSelect
            name={t('models.claudePlan')}
            models={models}
            model={selectedModel}
            onModel={(model) => void choose({ model })}
            efforts={efforts}
            effort={selectedEffort ?? 'default'}
            onEffort={(effort) => choose({ effort: effort === 'default' ? undefined : (effort as ClaudeEffort) })}
            disabled={busy || running}
          />
        }
        onToggle={(on) => void choose({ enabled: on })}
        {...(onMakeDefault ? { onMakeDefault } : {})}
        onDisconnect={() => void act(() => disconnectLocalAgent(userId!))}
        menuItems={menuItems}
        panel={showPanel ? panel : undefined}
      />
      {settingsOpen && (
        <Modal size="sm" onClose={() => setSettingsOpen(false)}>
          <ModalTitle>{t('models.claudeCodeTitle')}</ModalTitle>
          <ModalLede>{t('models.claudeCodeLede')}</ModalLede>
          <div className="mt-5 flex flex-col text-body text-ink-soft">
            {cliChooser && (
              <section className="border-b border-line-soft pb-5">
                <h3 className="mb-2.5 text-caption font-medium text-ink-faint">{t('models.claudeCodeWhich')}</h3>
                {cliChooser}
              </section>
            )}
            <section className={cn(cliChooser && 'pt-5')}>
              <h3 className="mb-1 text-caption font-medium text-ink-faint">{t('models.pinTitle')}</h3>
              <p className="mb-2.5 text-label">
                {pinnedModel ? t('models.pinnedNow', { model: pinnedModel }) : t('models.pinLede')}
              </p>
              {pinField}
            </section>
          </div>
          <ModalActions>
            <Button variant="ghost" onClick={() => setSettingsOpen(false)}>
              {t('common.close')}
            </Button>
          </ModalActions>
        </Modal>
      )}
    </>
  )
}
