import { env } from './env.ts'
import { DESCRIBER_ANTHROPIC_MODEL, DESCRIBER_MODELS } from '../shared/modelMenu.ts'
import { readConnections, usableAccount, type Connections } from './agentDefaults.ts'
import { geminiCloudRuns, geminiCloudWorkerFor } from './geminiCloudRuns.ts'
import { localAgentRuns, type LocalHarnessRequest } from './localAgentRuns.ts'
import { isClaudeEffort, isClaudeModel, type LocalAgentResult } from '../shared/localAgent.ts'
import type { RunnerPick } from '../shared/agentRunner.ts'
import Anthropic from '@anthropic-ai/sdk'
import { withFreshToken, accountModelFor, accountVisionFor, accountWithPick, customModelFor } from './modelAccounts.ts'
import type { AccountKind, BuiltinAccountKind, ModelAccount } from './modelAccounts.ts'
import { customProviderFetch } from './customProviderFetch.ts'
import { isCustomProviderKind, type CustomModel, type CustomProviderConfig } from '../shared/customProvider.ts'
import { ModelAuthError, ModelUnavailableError, effortFor, runAzureTurn, runOpenAiTurn } from './openaiAgent.ts'
import type { StopReason, TurnBlock } from './openaiAgent.ts'
import {
  IMAGE_OMITTED_NOTE,
  deepseekConfig,
  geminiConfig,
  kimiCodeConfig,
  kimiConfig,
  openrouterConfig,
  runChatCompletionsTurn,
  type ChatCompletionsConfig,
} from './chatCompletionsAgent.ts'

/**
 * Which model runs a Doop Agent turn, and on whose bill.
 *
 * Two layers, resolved in this order:
 *
 *  - a user's own model account (their ChatGPT subscription or an OpenAI API
 *    key) — the moment one is connected, that user's runs move onto it and
 *    the free-task meter stops applying to them;
 *  - the server tier, which pays for the free tasks every account starts
 *    with. DOOP_AGENT_PROVIDER picks what it runs on: 'anthropic' (the
 *    default, on ANTHROPIC_API_KEY) or 'azure' (the AZURE_OPENAI_* vars).
 *
 * A run bills exactly ONE person: the requester behind the work it claims. The
 * queue is worked one requester at a time rather than sweeping several people's
 * cards into a single call, so nobody's subscription ever pays for someone
 * else's request.
 */

export type ServerProvider = 'anthropic' | 'azure'
export type Provider = ServerProvider | AccountKind | 'claude-local' | 'gemini-cloud'

export interface AgentTurnRequest {
  /** ordered system blocks; `cache` marks an Anthropic cache breakpoint */
  system: { text: string; cache?: boolean }[]
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  maxTokens: number
  /** aborts the turn mid-generation: the run's work was stopped */
  signal?: AbortSignal
}

export interface AgentTurnResult {
  content: TurnBlock[]
  stop_reason: StopReason
}

export interface AgentModel {
  provider: Provider
  /** for logs and the canvas status line, e.g. "ChatGPT (gpt-5)" */
  label: string
  /** the user whose account pays, when it isn't the server's key */
  userId?: string
  /** false = the model cannot see images and the run degrades to no visual
   *  review; absent means true (every pre-roster provider has vision) */
  vision?: boolean
  runHarness?: (req: LocalHarnessRequest) => Promise<LocalAgentResult>
  run(req: AgentTurnRequest): Promise<AgentTurnResult>
}

export { ModelAuthError, ModelUnavailableError }
export class ModelConfigurationError extends ModelAuthError {}

/* ---------------------------------------------------------------- */
/* the server tier: pays for everyone's free tasks                  */
/* ---------------------------------------------------------------- */

const ANTHROPIC_MODEL = env.DOOP_AGENT_MODEL

let anthropic: Anthropic | null = null

function anthropicTier(model: string = ANTHROPIC_MODEL): AgentModel | null {
  if (!env.ANTHROPIC_API_KEY) {
    warnOnce(
      '[doop-agent] ANTHROPIC_API_KEY not set — the free Doop Agent tier is off. Users who connect a model account of their own still get the agent; everyone else sees queued cards and @mentions go unpicked. See README → "The Doop Agent".',
    )
    return null
  }
  if (!anthropic) anthropic = new Anthropic()
  const client = anthropic
  return {
    provider: 'anthropic',
    label: `Doop (${model})`,
    run: (req) => runAnthropicTurn(client, model, req),
  }
}

/**
 * One Anthropic turn, streamed and collected into a message.
 *
 * Streaming is not for show here: it is what lets a turn run long. The SDK
 * refuses a non-streaming request whose max_tokens implies more than ten
 * minutes of generation ("Streaming is required for operations that may take
 * longer than 10 minutes"), and GitHub recon asks for 32k tokens per turn. A
 * bigger client timeout would silence that check but leave a silent HTTP
 * connection open for the whole generation, which proxies drop. Over SSE the
 * SDK's timeout only guards the wait for headers; the response itself stays
 * alive on the API's ping events until the message is complete.
 */
export async function runAnthropicTurn(
  client: Anthropic,
  model: string,
  req: AgentTurnRequest,
): Promise<AgentTurnResult> {
  const res = await client.messages
    .stream(
      {
        model,
        max_tokens: req.maxTokens,
        system: req.system.map((block) => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
        })),
        tools: req.tools,
        messages: req.messages,
      },
      { signal: req.signal },
    )
    .finalMessage()
  const stop: StopReason =
    res.stop_reason === 'refusal'
      ? 'refusal'
      : res.stop_reason === 'max_tokens'
        ? 'max_tokens'
        : res.stop_reason === 'tool_use'
          ? 'tool_use'
          : 'end_turn'
  return { content: res.content as TurnBlock[], stop_reason: stop }
}

function azureTier(): AgentModel | null {
  const endpoint = env.AZURE_OPENAI_ENDPOINT
  const deployment = env.AZURE_OPENAI_DEPLOYMENT
  const apiKey = env.AZURE_OPENAI_API_KEY
  if (!endpoint || !deployment || !apiKey) {
    warnOnce(
      '[doop-agent] DOOP_AGENT_PROVIDER=azure needs AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT and AZURE_OPENAI_API_KEY — the free Doop Agent tier is off until all three are set.',
    )
    return null
  }
  const config = { endpoint, deployment, apiKey }
  return {
    provider: 'azure',
    label: `Doop (${deployment})`,
    async run(req) {
      try {
        return await runAzureTurn(config, {
          system: joinSystem(req),
          tools: req.tools,
          messages: req.messages,
          maxTokens: req.maxTokens,
          signal: req.signal,
        })
      } catch (err) {
        /* these are the SERVER's credentials — "reconnect your account" would
           send users chasing a connection they don't have */
        if (err instanceof ModelAuthError) {
          throw new Error(
            'Azure OpenAI rejected this server’s credentials — check AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT',
            { cause: err },
          )
        }
        throw err
      }
    },
  }
}

const serverTiers: Record<ServerProvider, () => AgentModel | null> = {
  anthropic: anthropicTier,
  azure: azureTier,
}

/* an unknown DOOP_AGENT_PROVIDER fails at boot (server/env.ts) */
function serverProvider(): ServerProvider {
  return env.DOOP_AGENT_PROVIDER
}

/** What the boot banner reports: which provider the free tier would run on,
 *  and whether it actually can. */
export function serverTierInfo(): { provider: ServerProvider; ready: boolean } {
  const provider = serverProvider()
  return { provider, ready: serverTiers[provider]() !== null }
}

const warnedAbout = new Set<string>()
function warnOnce(message: string) {
  if (warnedAbout.has(message)) return
  warnedAbout.add(message)
  console.log(message)
}

/* ---------------------------------------------------------------- */
/* a user's own account                                             */
/* ---------------------------------------------------------------- */

const BYO_LABELS: Record<BuiltinAccountKind, string> = {
  chatgpt: 'ChatGPT',
  'openai-key': 'OpenAI',
  'anthropic-key': 'Claude API',
  'openrouter-key': 'OpenRouter',
  'gemini-key': 'Gemini',
  'deepseek-key': 'DeepSeek',
  'kimi-key': 'Kimi',
  'kimi-code': 'Kimi Code',
}

/* the account kinds that run on the Chat Completions transport */
const CHAT_COMPLETIONS_CONFIGS: Partial<
  Record<BuiltinAccountKind, (apiKey: string, model: string, vision: boolean) => ChatCompletionsConfig>
> = {
  'openrouter-key': openrouterConfig,
  'gemini-key': geminiConfig,
  'deepseek-key': deepseekConfig,
  'kimi-key': kimiConfig,
  'kimi-code': kimiCodeConfig,
}

/* the OpenAI-shaped transports take one system string; cache breakpoints are
   an Anthropic concept and simply flatten away */
function joinSystem(req: AgentTurnRequest): string {
  return req.system.map((block) => block.text).join('\n\n')
}

/* ---------------------------------------------------------------- */
/* a custom provider: an endpoint its person named                  */
/* ---------------------------------------------------------------- */

/** Where a custom provider's turns go and with what credentials. */
export interface CustomTarget {
  config: CustomProviderConfig
  apiKey?: string
  headers?: Record<string, string>
}

/**
 * One turn on a custom provider's model, over the API type its person
 * picked. Every request goes through customProviderFetch (public addresses
 * only, DNS pinned, no redirects), and the output budget is held to what the
 * model was said to allow.
 */
export function customTurn(target: CustomTarget, model: CustomModel): AgentModel['run'] {
  const { config, apiKey, headers = {} } = target
  const budget = (req: AgentTurnRequest) => Math.min(req.maxTokens, model.maxOutputTokens ?? req.maxTokens)
  if (config.apiType === 'anthropic') {
    const client = new Anthropic({
      apiKey: apiKey || null,
      baseURL: config.baseUrl,
      fetch: customProviderFetch,
      /* no key: say so explicitly, or the SDK refuses to send anything */
      defaultHeaders: { ...headers, ...(apiKey ? {} : { 'X-Api-Key': null }) },
    })
    return async (req) => {
      try {
        return await runAnthropicTurn(client, model.id, {
          ...req,
          messages: model.vision ? req.messages : withoutImages(req.messages),
          maxTokens: budget(req),
        })
      } catch (error) {
        if (error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403)) {
          throw new ModelAuthError(`${config.name} rejected the API key. Update it in Settings.`)
        }
        throw error
      }
    }
  }
  const chat: ChatCompletionsConfig = {
    url: `${config.baseUrl}/chat/completions`,
    headers: { ...headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    model: model.id,
    label: config.name,
    vision: model.vision,
    ...(config.echoReasoning ? { echoReasoning: true } : {}),
    ...(config.tokenParam ? { tokenParam: config.tokenParam } : {}),
    fetch: customProviderFetch,
  }
  return (req) =>
    runChatCompletionsTurn(chat, {
      system: joinSystem(req),
      tools: req.tools,
      messages: req.messages,
      maxTokens: budget(req),
      signal: req.signal,
    })
}

/**
 * The conversation with every image, top-level or inside a tool result,
 * swapped for the text note the Chat Completions transport uses: a model said
 * not to see images must not be sent any, whichever tool produced them.
 */
export function withoutImages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const note = { type: 'text' as const, text: IMAGE_OMITTED_NOTE }
  return messages.map((message) => {
    if (typeof message.content === 'string') return message
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === 'image') return note
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          return { ...block, content: block.content.map((part) => (part.type === 'image' ? note : part)) }
        }
        return block
      }),
    }
  })
}

function customModel(account: ModelAccount): AgentModel {
  const config = account.custom
  const model = customModelFor(account)
  if (!config || !model) throw new ModelConfigurationError('Add a model to this custom provider in Settings.')
  return {
    provider: account.kind,
    label: `${config.name} (${model.id})`,
    userId: account.userId,
    vision: model.vision,
    run: customTurn(
      {
        config,
        ...(account.apiKey ? { apiKey: account.apiKey } : {}),
        ...(account.headers ? { headers: account.headers } : {}),
      },
      model,
    ),
  }
}

function byoModel(account: ModelAccount): AgentModel {
  const kind = account.kind
  if (isCustomProviderKind(kind)) return customModel(account)
  if (kind === 'anthropic-key') {
    if (!account.apiKey) throw new ModelAuthError('Reconnect your Claude API key in Settings.')
    const client = new Anthropic({ apiKey: account.apiKey })
    const model = accountModelFor(account)
    return {
      provider: account.kind,
      label: `Claude API (${model})`,
      userId: account.userId,
      async run(req) {
        try {
          return await runAnthropicTurn(client, model, req)
        } catch (error) {
          if (
            error instanceof Anthropic.APIError &&
            (error.status === 400 || error.status === 404) &&
            /anthropic-workspace-id|workspace/i.test(error.message)
          ) {
            throw new ModelConfigurationError(
              'Create an Anthropic API key scoped to one workspace, then use Rotate key in Settings → Claude API key and retry.',
            )
          }
          if (error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403)) {
            throw new ModelAuthError('Anthropic rejected your API key. Reconnect it in Settings.')
          }
          throw error
        }
      },
    }
  }
  const chatCompletionsConfig = CHAT_COMPLETIONS_CONFIGS[kind]
  if (chatCompletionsConfig) {
    if (!account.apiKey) throw new ModelAuthError(`Reconnect your ${BYO_LABELS[kind]} key in Settings.`)
    const model = accountModelFor(account)
    const vision = accountVisionFor(account)
    const config = chatCompletionsConfig(account.apiKey, model, vision)
    return {
      provider: account.kind,
      label: `${BYO_LABELS[kind]} (${model})`,
      userId: account.userId,
      vision,
      run: (req) =>
        runChatCompletionsTurn(config, {
          system: joinSystem(req),
          tools: req.tools,
          messages: req.messages,
          maxTokens: req.maxTokens,
          signal: req.signal,
        }),
    }
  }
  return {
    provider: account.kind,
    label: `${BYO_LABELS[kind]} (${accountModelFor(account)}, ${effortFor(account)} effort)`,
    userId: account.userId,
    async run(req) {
      /* refreshed per turn, not per run: a long design run outlives an
         hour-long access token */
      const live = await withFreshToken(account)
      return runOpenAiTurn(live, {
        system: joinSystem(req),
        tools: req.tools,
        messages: req.messages,
        maxTokens: req.maxTokens,
        signal: req.signal,
      })
    },
  }
}

/**
 * Pick the model for one run, billed to exactly one person: `payerId` is the
 * human whose work the run is about to claim. Returns null when nothing can
 * run it — they have no account of their own and the server tier is off.
 *
 * A connected account wins outright: someone who has just linked their own
 * subscription expects the very next task to run on it, and the free tier is a
 * trial to get them here, not a balance to spend down first. It also means
 * connecting stops costing us anything from that moment on.
 *
 * `pick` is what the card asked for (the composer's choice): one of the
 * person's connections — the Claude Plan on their desktop or one of their
 * model accounts — and the model and effort on it. Work without a pick (a
 * comment, an automation), or with one naming a connection that is gone or
 * switched off, runs on their default (agentDefaults.ts).
 */
export async function pickModel(payerId?: string, pick?: RunnerPick): Promise<AgentModel | null> {
  if (!payerId) return serverTiers[serverProvider()]()
  const worker = geminiCloudWorkerFor(payerId)
  if (worker) {
    return {
      provider: 'gemini-cloud',
      label: 'Gemini CLI (cloud pilot)',
      userId: payerId,
      runHarness: (req) => geminiCloudRuns.start(payerId, worker, req),
      run: () =>
        Promise.reject(
          new Error('Gemini cloud pilot supports canvas tasks only. Repository imports require a server provider.'),
        ),
    }
  }
  const connections = await readConnections(payerId).catch((err): Connections => {
    console.error('[doop-agent] could not read the connected model accounts', err)
    return { plan: { enabled: false, model: 'default' }, accounts: [], default: undefined }
  })
  const picked =
    pick && (pick.provider === 'claude-local' ? connections.plan.enabled : usableAccount(connections, pick.provider))
  const provider = picked ? pick.provider : connections.default
  /* the pick's model and effort apply only to the connection it named */
  const own = picked ? pick : undefined
  if (provider === 'claude-local') {
    /* the Plan never hands its work to another connection while the desktop is away */
    if (!localAgentRuns.online(payerId)) return null
    const plan = connections.plan
    const run = {
      model: own && isClaudeModel(own.model) ? own.model : plan.model,
      effort: own && isClaudeEffort(own.effort) ? own.effort : plan.effort,
    }
    return {
      provider: 'claude-local',
      label: `Claude CLI (${run.model}${run.effort ? `, ${run.effort} effort` : ''})`,
      userId: payerId,
      runHarness: (req) => localAgentRuns.start(payerId, run, req),
      run: () =>
        Promise.reject(
          new Error('Repository imports require a server provider. Select your connected account in Settings.'),
        ),
    }
  }
  const account = usableAccount(connections, provider)
  if (account) return byoModel(accountWithPick(account, own))
  return serverTiers[serverProvider()]()
}

/* ---------------------------------------------------------------- */
/* image descriptions: a small tier, never the design model          */
/* ---------------------------------------------------------------- */

/**
 * The model that describes an uploaded image on a user's own account
 * (shared/imageDescriptions.ts): the provider's small vision tier from
 * DESCRIBER_MODELS, or the account's own model at low reasoning effort where
 * the provider's roster is per subscription. Null when the account's model
 * cannot see images — the caller falls through to the server tier.
 */
export function accountDescriber(account: ModelAccount): AgentModel | null {
  const small: ModelAccount = {
    ...account,
    model: DESCRIBER_MODELS[account.kind] ?? account.model,
    effort: 'low',
  }
  if (!accountVisionFor(small)) return null
  return byoModel(small)
}

/** The server tier's describer: Haiku on the Anthropic key, the one
 *  deployment on Azure. Null when the free tier is off. */
export function serverDescriber(provider: ServerProvider = serverProvider()): AgentModel | null {
  return provider === 'anthropic' ? anthropicTier(DESCRIBER_ANTHROPIC_MODEL) : azureTier()
}
