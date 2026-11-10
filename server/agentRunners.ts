/**
 * The connections a person's composer may send a task to, as
 * `GET /api/agent-runners` lists them: the Claude Plan while it is on, and
 * every model account that is on. `default` is what work carrying no pick
 * runs on (agentDefaults.ts). The Settings pane gets every account, on or
 * off, through `accountsView`.
 */
import { AGENT_MODELS, effortFor } from './openaiAgent.ts'
import { geminiCloudWorkerFor } from './geminiCloudRuns.ts'
import { localAgentRuns } from './localAgentRuns.ts'
import { readConnections } from './agentDefaults.ts'
import {
  accountModelFor,
  chatgptConnectEnabled,
  statusOf,
  takesReasoningEffort,
  type AccountStatus,
  type BuiltinAccountKind,
  type ModelAccount,
} from './modelAccounts.ts'
import { customMenu } from './customProviders.ts'
import { customProvidersEnabled } from './customProviderFetch.ts'
import { CLAUDE_EFFORT_OPTIONS, CLAUDE_MODELS } from '../shared/localAgent.ts'
import {
  ANTHROPIC_MODELS,
  DEEPSEEK_MODELS,
  GEMINI_MODELS,
  KIMI_CODE_MODELS,
  KIMI_MODELS,
  OPENROUTER_MODELS,
  reasoningEffortOptions,
} from '../shared/modelMenu.ts'
import type { ModelOption } from '../shared/modelMenu.ts'
import { RUNNER_NAMES, type AgentRunner, type AgentRunners, type RunnerProvider } from '../shared/agentRunner.ts'

/** the curated menu each built-in account kind's picker opens with */
export const MODEL_MENUS: Record<BuiltinAccountKind, ModelOption[]> = {
  chatgpt: AGENT_MODELS.map((m) => ({ ...m, vision: true })),
  'openai-key': AGENT_MODELS.map((m) => ({ ...m, vision: true })),
  'anthropic-key': ANTHROPIC_MODELS,
  'openrouter-key': OPENROUTER_MODELS,
  'gemini-key': GEMINI_MODELS,
  'deepseek-key': DEEPSEEK_MODELS,
  'kimi-key': KIMI_MODELS,
  'kimi-code': KIMI_CODE_MODELS,
}

/** The menu one connected account's picker opens with: the curated one, or
 *  the models a custom provider's person listed. */
export function menuFor(account: ModelAccount): ModelOption[] {
  if (account.custom) return customMenu(account.custom)
  return MODEL_MENUS[account.kind as BuiltinAccountKind]
}

/** What the composer and the meter call a connection. */
function nameOf(account: ModelAccount): string {
  return account.custom?.name ?? RUNNER_NAMES[account.kind as BuiltinAccountKind]
}

export async function listRunners(userId: string): Promise<AgentRunners> {
  const connections = await readConnections(userId)
  const runners: AgentRunner[] = []
  const { plan } = connections
  if (plan.enabled) {
    runners.push({
      provider: 'claude-local',
      name: RUNNER_NAMES['claude-local'],
      online: localAgentRuns.online(userId),
      model: plan.model,
      ...(plan.effort ? { effort: plan.effort } : {}),
      models: CLAUDE_MODELS,
      efforts: CLAUDE_EFFORT_OPTIONS,
    })
  }
  for (const account of connections.accounts) {
    if (!account.enabled) continue
    const effort = takesReasoningEffort(account.kind) ? effortFor(account) : undefined
    runners.push({
      provider: account.kind,
      name: nameOf(account),
      ...(account.email ? { email: account.email } : {}),
      model: accountModelFor(account),
      ...(effort ? { effort } : {}),
      models: menuFor(account).map(({ id, name, blurb }) => ({ id, name, blurb })),
      ...(effort ? { efforts: reasoningEffortOptions(effort) } : {}),
    })
  }
  const fallback = geminiCloudWorkerFor(userId) ? ('gemini-cloud' as const) : connections.default
  return { runners, ...(fallback ? { default: fallback } : {}) }
}

/** What the Settings pane renders: every connected account, on or off, and
 *  which connection is the default. Every account route answers with it, so
 *  the pane re-renders straight from the response. */
export interface AccountsView {
  accounts: AccountStatus[]
  default?: RunnerProvider
  chatgptEnabled: boolean
  /** the menu per kind: the built-in curated ones, and each connected
   *  custom provider's own list */
  menus: Record<string, ModelOption[]>
  /** whether this server lets people add custom providers at all */
  customProviders: boolean
}

export async function accountsView(userId: string): Promise<AccountsView> {
  const connections = await readConnections(userId)
  return {
    accounts: connections.accounts.map(statusOf),
    ...(connections.default ? { default: connections.default } : {}),
    chatgptEnabled: chatgptConnectEnabled(),
    menus: {
      ...MODEL_MENUS,
      ...Object.fromEntries(connections.accounts.flatMap((a) => (a.custom ? [[a.kind, customMenu(a.custom)]] : []))),
    },
    customProviders: customProvidersEnabled(),
  }
}
