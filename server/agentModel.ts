import Anthropic from '@anthropic-ai/sdk'
import { getAccount, withFreshToken } from './modelAccounts.ts'
import type { AccountKind, ModelAccount } from './modelAccounts.ts'
import { modelFor, ModelAuthError, runAzureTurn, runOpenAiTurn } from './openaiAgent.ts'
import type { StopReason, TurnBlock } from './openaiAgent.ts'

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
export type Provider = ServerProvider | AccountKind

export interface AgentTurnRequest {
  /** ordered system blocks; `cache` marks an Anthropic cache breakpoint */
  system: { text: string; cache?: boolean }[]
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  maxTokens: number
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
  run(req: AgentTurnRequest): Promise<AgentTurnResult>
}

export { ModelAuthError }

/* ---------------------------------------------------------------- */
/* the server tier: pays for everyone's free tasks                  */
/* ---------------------------------------------------------------- */

const ANTHROPIC_MODEL = process.env.DOOP_AGENT_MODEL || 'claude-opus-5'

let anthropic: Anthropic | null = null

function anthropicTier(): AgentModel | null {
  if (!process.env.ANTHROPIC_API_KEY) {
    warnOnce(
      '[doop-agent] ANTHROPIC_API_KEY not set — the free Doop Agent tier is off. Users who connect a model account of their own still get the agent; everyone else sees queued cards and @mentions go unpicked. See README → "The Doop Agent".',
    )
    return null
  }
  if (!anthropic) anthropic = new Anthropic()
  const client = anthropic
  return {
    provider: 'anthropic',
    label: `Doop (${ANTHROPIC_MODEL})`,
    run: (req) => runAnthropicTurn(client, ANTHROPIC_MODEL, req),
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
    .stream({
      model,
      max_tokens: req.maxTokens,
      system: req.system.map((block) => ({
        type: 'text' as const,
        text: block.text,
        ...(block.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      })),
      tools: req.tools,
      messages: req.messages,
    })
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
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT
  const apiKey = process.env.AZURE_OPENAI_API_KEY
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

function serverProvider(): ServerProvider {
  const chosen = process.env.DOOP_AGENT_PROVIDER || 'anthropic'
  if (chosen in serverTiers) return chosen as ServerProvider
  warnOnce(
    `[doop-agent] DOOP_AGENT_PROVIDER="${chosen}" is not a server provider (anthropic | azure) — using anthropic.`,
  )
  return 'anthropic'
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

const BYO_LABELS: Record<AccountKind, string> = {
  chatgpt: 'ChatGPT',
  'openai-key': 'OpenAI',
}

/* the OpenAI-shaped transports take one system string; cache breakpoints are
   an Anthropic concept and simply flatten away */
function joinSystem(req: AgentTurnRequest): string {
  return req.system.map((block) => block.text).join('\n\n')
}

function byoModel(account: ModelAccount): AgentModel {
  return {
    provider: account.kind,
    label: `${BYO_LABELS[account.kind]} (${modelFor(account)})`,
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
 */
export async function pickModel(payerId?: string): Promise<AgentModel | null> {
  const account = payerId
    ? await getAccount(payerId).catch((err) => {
        console.error('[doop-agent] could not read the connected model account', err)
        return null
      })
    : null
  if (account) return byoModel(account)
  return serverTiers[serverProvider()]()
}
