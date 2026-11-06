/**
 * Which connection a Doop Agent task runs on.
 *
 * A person can have two connections at once: the one model account
 * (ChatGPT, or an OpenAI / Claude / OpenRouter / Gemini key) and the Claude
 * Plan on their desktop. The composer offers every connected one and the
 * card carries the pick, so a task runs on what the person chose for it.
 * Work the resident picks up on its own — @mention comments, automations —
 * carries no pick and runs on the Settings default.
 */
import { ACCOUNT_KIND_LABELS, type AccountKindName } from './modelMenu.ts'

export type RunnerProvider = 'claude-local' | AccountKindName

export const RUNNER_PROVIDERS: readonly RunnerProvider[] = [
  'claude-local',
  ...(Object.keys(ACCOUNT_KIND_LABELS) as AccountKindName[]),
]

export const RUNNER_NAMES: Record<RunnerProvider, string> = { 'claude-local': 'Claude Plan', ...ACCOUNT_KIND_LABELS }

/** What a card asks to run on. The model and effort are checked against the
 *  provider when the run is picked; an id the provider does not know runs on
 *  the connection's configured one. */
export interface RunnerPick {
  provider: RunnerProvider
  model?: string
  effort?: string
}

const MAX_MODEL_ID = 120
const MAX_EFFORT_ID = 20

export function isRunnerProvider(value: unknown): value is RunnerProvider {
  return typeof value === 'string' && RUNNER_PROVIDERS.some((provider) => provider === value)
}

/** The pick a request carried, or nothing when it carried none or nonsense. */
export function parseRunnerPick(value: unknown): RunnerPick | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { provider, model, effort } = value as Record<string, unknown>
  if (!isRunnerProvider(provider)) return undefined
  const text = (field: unknown, max: number) =>
    typeof field === 'string' && field.trim() && field.length <= max ? field.trim() : undefined
  const pick: RunnerPick = { provider }
  const modelId = text(model, MAX_MODEL_ID)
  if (modelId) pick.model = modelId
  const effortId = text(effort, MAX_EFFORT_ID)
  if (effortId) pick.effort = effortId
  return pick
}

/** One run claims only work that agrees on this: the same connection, model
 *  and effort. No pick is the Settings default, keyed as the empty string. */
export function runnerKey(pick: RunnerPick | undefined): string {
  if (!pick) return ''
  return [pick.provider, pick.model ?? '', pick.effort ?? ''].join('|')
}

export interface RunnerOption {
  id: string
  name: string
  blurb: string
}

/** One connection the composer may send a task to, as the server lists it. */
export interface AgentRunner {
  provider: RunnerProvider
  /** 'Claude Plan', 'ChatGPT', 'OpenAI'… */
  name: string
  email?: string
  /** the Claude Plan: whether the desktop that runs it is polling right now */
  online?: boolean
  /** what the connection runs on when a pick names no model */
  model: string
  effort?: string
  models: RunnerOption[]
  /** the effort dial, where the provider has one */
  efforts?: RunnerOption[]
}

export interface AgentRunners {
  runners: AgentRunner[]
  /** what work without a pick runs on: the Settings default. Absent when the
   *  person has no connection of their own (the server tier runs it). */
  default?: RunnerProvider | 'gemini-cloud'
}

/** The pick resolved against what is connected now: a stored pick names a
 *  connection that is gone, or a model its menu lost, and the default takes
 *  over. Nothing when there is nothing to pick from. */
export function resolveRunnerPick(
  runners: AgentRunners | null,
  stored: RunnerPick | null,
): { runner: AgentRunner; pick: RunnerPick } | undefined {
  if (!runners || runners.runners.length === 0) return undefined
  const runner =
    (stored && runners.runners.find((r) => r.provider === stored.provider)) ??
    runners.runners.find((r) => r.provider === runners.default) ??
    runners.runners[0]
  if (!runner) return undefined
  const model = stored?.provider === runner.provider && stored.model ? stored.model : runner.model
  const effort =
    stored?.provider === runner.provider && stored.effort && runner.efforts?.some((e) => e.id === stored.effort)
      ? stored.effort
      : runner.effort
  return { runner, pick: { provider: runner.provider, model, ...(effort ? { effort } : {}) } }
}
