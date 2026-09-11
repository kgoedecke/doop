import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { ModelAccount } from './modelAccounts.ts'

/**
 * Runs one Doop Agent turn on OpenAI, speaking the Anthropic message shape
 * the agent loop is already written in. Everything OpenAI-specific — the
 * Responses API item format, tool-call ids, streaming — is contained here, so
 * server/resident.ts stays a single provider-neutral loop.
 *
 * Three transports, one body:
 *  - a connected ChatGPT subscription, through the same Codex backend the
 *    Codex CLI uses (SSE only, no max_output_tokens);
 *  - a plain OpenAI API key against api.openai.com (ordinary JSON);
 *  - an Azure OpenAI deployment (same Responses API, authenticated with
 *    Azure's api-key header) — SERVER config only, the free tier when
 *    DOOP_AGENT_PROVIDER=azure. Deliberately not a connectable per-user
 *    account: a user-supplied endpoint would be a server-side fetch target,
 *    i.e. an SSRF into whatever network Doop runs on.
 *
 * The one real impedance mismatch is images. Anthropic returns screenshots
 * inside tool results; the Responses API only accepts text in a
 * function_call_output, so each image is re-attached as a following user
 * message. The model sees the same pixels in the same order.
 */

export const CHATGPT_URL = process.env.CHATGPT_RESPONSES_URL || 'https://chatgpt.com/backend-api/codex/responses'
export const OPENAI_URL = process.env.OPENAI_RESPONSES_URL || 'https://api.openai.com/v1/responses'
/**
 * The GPT-5.6 tiers, which a ChatGPT sign-in and an API key can both reach.
 * Users pick one in Settings — they are paying for it, and the tiers trade
 * real money against real quality — so this list is the menu, not a detail.
 * Ordered best-first; the default is the middle one.
 */
export const AGENT_MODELS = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', blurb: 'Flagship — the most detail and polish, and the priciest' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', blurb: 'The everyday workhorse. A good default for design work' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', blurb: 'Fastest and cheapest — fine for small, mechanical edits' },
] as const

export const DEFAULT_OPENAI_MODEL = process.env.DOOP_AGENT_OPENAI_MODEL || 'gpt-5.6-terra'
const REASONING_EFFORT = process.env.DOOP_AGENT_OPENAI_EFFORT || 'medium'
/* Azure deployments are named by their owner and can host non-reasoning
   models, which reject a `reasoning` block outright — so unlike the OpenAI
   paths there is no default effort: unset means the parameter stays home. */
const AZURE_REASONING_EFFORT = process.env.AZURE_OPENAI_REASONING_EFFORT || ''
/* Azure's v1 surface needs no api-version; older resources can pin one. */
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || ''

export function isKnownModel(id: string): boolean {
  return AGENT_MODELS.some((model) => model.id === id)
}

/** What this account runs on: the user's choice, else the server default. */
export function modelFor(account: Pick<ModelAccount, 'model'>): string {
  return account.model || DEFAULT_OPENAI_MODEL
}
/* The Codex backend only answers clients it recognises, so this is the value
   it expects rather than a free-form product name. Override if OpenAI ever
   admits other originators. */
export const ORIGINATOR = process.env.CHATGPT_ORIGINATOR || 'codex_cli_rs'

export type TurnBlock = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'

export interface TurnRequest {
  system: string
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  maxTokens: number
}

export interface TurnResult {
  content: TurnBlock[]
  stop_reason: StopReason
}

/** The connection is no longer usable (revoked, expired past refresh, or the
 *  key was rotated) — the user has to reconnect. */
export class ModelAuthError extends Error {}

/* ---------------------------------------------------------------- */
/* Anthropic messages -> Responses input items                      */
/* ---------------------------------------------------------------- */

type Part = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }

const IMAGE_NOTE = 'The image(s) above are the result of the tool call you just made.'

function imagePart(source: { type: string; media_type?: string; data?: string; url?: string }): Part | null {
  if (source.type === 'url' && source.url) return { type: 'input_image', image_url: source.url, detail: 'auto' }
  if (source.type === 'base64' && source.data) {
    return {
      type: 'input_image',
      image_url: `data:${source.media_type || 'image/png'};base64,${source.data}`,
      detail: 'auto',
    }
  }
  return null
}

/** Split a tool result into the text the function_call_output carries and the
 *  images that have to ride along in a separate user message. */
function flattenToolResult(block: Anthropic.ToolResultBlockParam): { text: string; images: Part[] } {
  const images: Part[] = []
  const texts: string[] = []
  if (typeof block.content === 'string') {
    texts.push(block.content)
  } else if (Array.isArray(block.content)) {
    for (const part of block.content) {
      if (part.type === 'text') texts.push(part.text)
      else if (part.type === 'image') {
        const image = imagePart(part.source as never)
        if (image) {
          images.push(image)
          texts.push('[image returned — see the attached image below]')
        }
      }
    }
  }
  const body = texts.join('\n').trim() || 'ok'
  return { text: block.is_error ? `Error: ${body}` : body, images }
}

function toInput(messages: Anthropic.MessageParam[]): unknown[] {
  const items: unknown[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') {
      items.push({
        type: 'message',
        role: message.role,
        content: [
          message.role === 'assistant'
            ? { type: 'output_text', text: message.content }
            : { type: 'input_text', text: message.content },
        ],
      })
      continue
    }
    const userParts: Part[] = []
    const trailingImages: Part[] = []
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (message.role === 'assistant') {
            items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text }] })
          } else {
            userParts.push({ type: 'input_text', text: block.text })
          }
          break
        case 'tool_use':
          items.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })
          break
        case 'tool_result': {
          const { text, images } = flattenToolResult(block)
          items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: text })
          trailingImages.push(...images)
          break
        }
        case 'image': {
          const image = imagePart(block.source as never)
          if (image) userParts.push(image)
          break
        }
        default:
          break
      }
    }
    if (userParts.length > 0) items.push({ type: 'message', role: 'user', content: userParts })
    if (trailingImages.length > 0) {
      items.push({
        type: 'message',
        role: 'user',
        content: [...trailingImages, { type: 'input_text', text: IMAGE_NOTE }],
      })
    }
  }
  return items
}

function toTools(tools: Anthropic.Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.input_schema,
    strict: false,
  }))
}

/* ---------------------------------------------------------------- */
/* Responses output -> Anthropic blocks                             */
/* ---------------------------------------------------------------- */

interface ResponseBody {
  status?: string
  incomplete_details?: { reason?: string }
  error?: { message?: string } | null
  output?: {
    type: string
    call_id?: string
    id?: string
    name?: string
    arguments?: string
    content?: { type: string; text?: string; refusal?: string }[]
    /** image_generation_call items: the finished image, base64 */
    result?: string | null
    status?: string
  }[]
}

function fromResponse(body: ResponseBody): TurnResult {
  const content: TurnBlock[] = []
  let refused = false
  let toolCalls = 0
  for (const item of body.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && part.text) content.push({ type: 'text', text: part.text })
        else if (part.type === 'refusal') refused = true
      }
    } else if (item.type === 'function_call') {
      toolCalls++
      let input: unknown
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {}
      } catch {
        /* a malformed argument blob becomes an empty call; the tool's own
           validation then returns a usable error to the model */
        input = {}
      }
      content.push({
        type: 'tool_use',
        id: item.call_id || item.id || `call_${randomUUID()}`,
        name: item.name || 'unknown',
        input: input as Record<string, unknown>,
      })
    }
  }
  const truncated = body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens'
  const stop: StopReason = refused ? 'refusal' : toolCalls > 0 ? 'tool_use' : truncated ? 'max_tokens' : 'end_turn'
  /* a response with nothing in it would end the loop silently; make it a
     visible failure instead */
  if (content.length === 0 && !refused) throw new Error('OpenAI returned an empty response')
  return { content, stop_reason: stop }
}

/* ---------------------------------------------------------------- */
/* transports                                                       */
/* ---------------------------------------------------------------- */

/**
 * Pull the final response out of a Responses SSE stream.
 *
 * The output items are accumulated from `response.output_item.done` rather
 * than read off the terminal event: ChatGPT's Codex backend sends a
 * `response.completed` that carries only bookkeeping (id, usage, end_turn)
 * and no output array, so trusting that event alone yields an empty turn.
 * api.openai.com does include the array, and it wins when present.
 */
export async function readEventStream(res: Response): Promise<ResponseBody> {
  if (!res.body) throw new Error('OpenAI returned no response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const streamed: NonNullable<ResponseBody['output']> = []
  let final: ResponseBody | undefined
  let failure: string | undefined
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut = buffer.indexOf('\n')
    for (; cut >= 0; cut = buffer.indexOf('\n')) {
      const line = buffer.slice(0, cut).trim()
      buffer = buffer.slice(cut + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let event: {
        type?: string
        response?: ResponseBody
        item?: NonNullable<ResponseBody['output']>[number]
        error?: { message?: string }
        message?: string
      }
      try {
        event = JSON.parse(payload)
      } catch {
        continue
      }
      if (event.type === 'response.output_item.done' && event.item) streamed.push(event.item)
      else if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response
      else if (event.type === 'response.failed') failure = event.response?.error?.message || 'the response failed'
      else if (event.type === 'error') failure = event.error?.message || event.message || 'stream error'
    }
  }
  if (failure) throw new Error(failure)
  if (!final) throw new Error('OpenAI stream ended without a completed response')
  return final.output?.length ? final : { ...final, output: streamed }
}

export async function responseError(res: Response, label: string): Promise<Error> {
  const text = await res.text().catch(() => '')
  const detail = text.slice(0, 400)
  if (res.status === 401 || res.status === 403) {
    return new ModelAuthError(`${label} rejected the credentials (${res.status}) — reconnect the account`)
  }
  if (res.status === 429) {
    return new Error(`${label} rate-limited this account (429). ${detail}`)
  }
  return new Error(`${label} request failed (${res.status}). ${detail}`)
}

/** One turn against a connected ChatGPT subscription. */
async function runChatgpt(account: ModelAccount, req: TurnRequest): Promise<TurnResult> {
  const res = await fetch(CHATGPT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
      originator: ORIGINATOR,
      session_id: randomUUID(),
      ...(account.accountId ? { 'chatgpt-account-id': account.accountId } : {}),
    },
    body: JSON.stringify({
      model: modelFor(account),
      instructions: req.system,
      input: toInput(req.messages),
      tools: toTools(req.tools),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: REASONING_EFFORT, summary: 'auto' },
      store: false,
      stream: true,
    }),
  })
  if (!res.ok) throw await responseError(res, 'ChatGPT')
  return fromResponse(await readEventStream(res))
}

/** One turn against a plain OpenAI API key. */
async function runApiKey(account: ModelAccount, req: TurnRequest): Promise<TurnResult> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelFor(account),
      instructions: req.system,
      input: toInput(req.messages),
      tools: toTools(req.tools),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: REASONING_EFFORT },
      max_output_tokens: req.maxTokens,
      store: false,
    }),
  })
  if (!res.ok) throw await responseError(res, 'OpenAI')
  return fromResponse((await res.json()) as ResponseBody)
}

/** Everything one Azure OpenAI call needs, straight from the AZURE_OPENAI_*
 *  env vars — server config, never user input. */
export interface AzureConfig {
  /** the resource base (https://….openai.azure.com) or a full …/responses URL */
  endpoint: string
  deployment: string
  apiKey: string
}

/** The Responses URL for an Azure resource. A bare endpoint gets the v1
 *  path appended; an endpoint that already names …/responses (an APIM
 *  front door, say) is used as given. */
export function azureResponsesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '')
  const url = /\/responses$/.test(new URL(base).pathname) ? base : `${base}/openai/v1/responses`
  return AZURE_API_VERSION ? `${url}?api-version=${encodeURIComponent(AZURE_API_VERSION)}` : url
}

/** One turn against an Azure OpenAI deployment. */
export async function runAzureTurn(config: AzureConfig, req: TurnRequest): Promise<TurnResult> {
  const res = await fetch(azureResponsesUrl(config.endpoint), {
    method: 'POST',
    headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.deployment,
      instructions: req.system,
      input: toInput(req.messages),
      tools: toTools(req.tools),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      ...(AZURE_REASONING_EFFORT ? { reasoning: { effort: AZURE_REASONING_EFFORT } } : {}),
      max_output_tokens: req.maxTokens,
      store: false,
    }),
  })
  if (!res.ok) throw await responseError(res, 'Azure OpenAI')
  return fromResponse((await res.json()) as ResponseBody)
}

const transports: Record<ModelAccount['kind'], (account: ModelAccount, req: TurnRequest) => Promise<TurnResult>> = {
  chatgpt: runChatgpt,
  'openai-key': runApiKey,
}

export function runOpenAiTurn(account: ModelAccount, req: TurnRequest): Promise<TurnResult> {
  return transports[account.kind](account, req)
}

/* exported for tests */
export const _internal = { toInput, toTools, fromResponse, flattenToolResult, readEventStream }
