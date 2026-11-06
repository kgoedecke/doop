import { Fragment, useState } from 'react'
import { posthog } from '../lib/posthog'
import { navigate } from '../App'
import { cn } from '@/lib/utils'
import { BrandMark, type Brand } from './ui/brand-mark'
import { EffortSlider } from './ConnectionTable'
import { DoopMark } from './Logo'
import { useAgentModels } from './ModelAccount'
import { useAgentRunners, useRunnerPick } from '../lib/runnerPick'
import { resolveRunnerPick, type AgentRunner, type RunnerOption, type RunnerProvider } from '../../shared/agentRunner'
import { useT, type PlainMessageKey } from '@/lib/i18n'
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { MenuButton } from './ui/menu-button'

/* the brand mark each connection's models wear in the picker */
const PROVIDER_MARK: Partial<Record<RunnerProvider, Brand>> = {
  'claude-local': 'claude',
  'anthropic-key': 'claude',
  chatgpt: 'openai',
  'openai-key': 'openai',
  'gemini-key': 'gemini',
  'openrouter-key': 'openrouter',
}

/* the effort ids stay as sent to the server; only their names are translated */
const EFFORT_NAMES: Record<string, PlainMessageKey> = {
  low: 'models.effortLow',
  medium: 'models.effortMedium',
  high: 'models.effortHigh',
  xhigh: 'models.effortXhigh',
  max: 'models.effortMax',
}
const EFFORT_BLURBS: Record<string, PlainMessageKey> = {
  low: 'models.effortLowBlurb',
  medium: 'models.effortMediumBlurb',
  high: 'models.effortHighBlurb',
  xhigh: 'models.effortXhighBlurb',
}
/* the Claude Plan's dial reads differently: it is the CLI's own levels */
const CLAUDE_EFFORT_BLURBS: Record<string, PlainMessageKey> = {
  low: 'models.claudeEffortLowBlurb',
  medium: 'models.claudeEffortMediumBlurb',
  high: 'models.claudeEffortHighBlurb',
  xhigh: 'models.claudeEffortXhighBlurb',
  max: 'models.claudeEffortMaxBlurb',
}

function modelName(models: RunnerOption[], id: string): string {
  return models.find((m) => m.id === id)?.name ?? id
}

/**
 * Where the next task goes: every connection the person has — the Claude
 * Plan on their desktop, their ChatGPT or API key — with its models, as a
 * quiet dropdown beside the composer's send button. The pick rides on the
 * card (this browser remembers it) and is independent of the Settings
 * default, which is what comments, @mentions and automations run on. With
 * nothing connected there is nothing to choose between, so it says so and
 * links to Settings.
 */
export function ModelPicker({ disabled = false }: { disabled?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const runners = useAgentRunners()
  const stored = useRunnerPick((s) => s.stored)
  const setPick = useRunnerPick((s) => s.setPick)
  const resolved = resolveRunnerPick(runners, stored)
  /* the picked account's live catalog, asked for once the menu opens; the
     other connections show their curated menus */
  const liveKind = resolved && resolved.runner.provider !== 'claude-local' ? resolved.runner.provider : undefined
  const catalog = useAgentModels(liveKind, open)
  const modelsOf = (runner: AgentRunner): RunnerOption[] =>
    runner.provider === liveKind && catalog?.live ? catalog.models : runner.models

  const label = resolved ? modelName(modelsOf(resolved.runner), resolved.pick.model ?? '') : 'Doop Agent'
  const mark = resolved ? PROVIDER_MARK[resolved.runner.provider] : undefined
  /* the effort reads after the model, lighter, as in Settings */
  const effortId = resolved?.pick.effort
  const effortKey = effortId ? EFFORT_NAMES[effortId] : undefined
  const effortLabel = effortId
    ? effortKey
      ? t(effortKey)
      : resolved?.runner.efforts?.find((e) => e.id === effortId)?.name
    : undefined

  function choose(runner: AgentRunner, model: string) {
    const effort = resolved?.runner.provider === runner.provider ? resolved.pick.effort : runner.effort
    setPick({ provider: runner.provider, model, ...(effort ? { effort } : {}) })
    posthog.capture('agent_runner_picked', { provider: runner.provider, model, via: 'composer' })
  }

  function chooseEffort(effort: string) {
    if (!resolved) return
    setPick({ ...resolved.pick, effort })
    posthog.capture('agent_effort_changed', { effort, provider: resolved.runner.provider, via: 'composer' })
  }

  const effortBlurbs = resolved?.runner.provider === 'claude-local' ? CLAUDE_EFFORT_BLURBS : EFFORT_BLURBS

  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <MenuButton
          variant="quiet"
          disabled={disabled || !runners}
          aria-label={t('panels.modelAria', { label })}
          className={cn('min-w-0 gap-[5px]')}
          icon={
            <span className="grid size-3 flex-none place-items-center">
              {mark ? (
                <BrandMark brand={mark} size={12} />
              ) : (
                /* no connection behind it: the agent's own mark */
                <DoopMark size={11} className="block" />
              )}
            </span>
          }
        >
          <span className="truncate">{label}</span>
          {effortLabel && <span className="flex-none text-ink-faint">{effortLabel}</span>}
        </MenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" width="auto">
        {runners && runners.runners.length > 0 ? (
          <>
            {runners.runners.map((runner) => (
              <Fragment key={runner.provider}>
                {/* one connection needs no name; several are told apart by theirs */}
                <DropdownMenuCaption>
                  {runners.runners.length > 1 ? runner.name : t('models.model')}
                </DropdownMenuCaption>
                <DropdownMenuRadioGroup
                  value={resolved?.runner.provider === runner.provider ? (resolved.pick.model ?? '') : ''}
                  onValueChange={(model) => choose(runner, model)}
                >
                  {modelsOf(runner).map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id} title={m.blurb}>
                      {m.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </Fragment>
            ))}
            {catalog?.error && liveKind && (
              <DropdownMenuCaption className="pb-2 text-ink-faint">{catalog.error}</DropdownMenuCaption>
            )}
            {resolved?.runner.efforts && (
              <>
                <DropdownMenuSeparator />
                <EffortSlider
                  efforts={resolved.runner.efforts.map((e) => {
                    const name = EFFORT_NAMES[e.id]
                    const blurb = effortBlurbs[e.id]
                    return {
                      id: e.id,
                      name: name ? t(name) : e.name,
                      blurb: blurb ? t(blurb) : t('models.effortServerDefault'),
                    }
                  })}
                  effort={resolved.pick.effort}
                  onEffort={chooseEffort}
                />
              </>
            )}
            <DropdownMenuSeparator />
          </>
        ) : (
          <DropdownMenuCaption className="pb-2 text-ink-soft">{t('panels.modelNoAccount')}</DropdownMenuCaption>
        )}
        <DropdownMenuItem onSelect={() => navigate('/settings?pane=agent')}>
          {runners && runners.runners.length > 0 ? t('panels.modelSettings') : t('panels.modelConnect')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
