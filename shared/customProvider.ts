/**
 * A custom provider: any endpoint that speaks the OpenAI Chat Completions or
 * the Anthropic Messages API (a self-hosted vLLM, LiteLLM, a regional cloud,
 * a gateway), connected by its base URL, an optional key and the models the
 * person lists. One is a model account like any other (its kind is
 * `custom:<id>`), so it switches on and off, can be the default and shows in
 * the composer's picker under the name the person gave it.
 *
 * Nothing about a custom endpoint is known in advance, so what the agent
 * needs to know rides on each model: whether it sees images (screenshots are
 * stripped for one that does not, rather than failing the first visual
 * review) and how many tokens it may write per turn.
 *
 * This module is the one validator both the server and the Settings form
 * use; the server re-checks everything it is sent.
 */

export const CUSTOM_PROVIDER_PREFIX = 'custom:'

export type CustomProviderKind = `custom:${string}`

const CUSTOM_KIND = /^custom:[a-z0-9]{8,32}$/

export function isCustomProviderKind(value: unknown): value is CustomProviderKind {
  return typeof value === 'string' && CUSTOM_KIND.test(value)
}

export const CUSTOM_API_TYPES = ['openai-chat', 'anthropic'] as const
export type CustomApiType = (typeof CUSTOM_API_TYPES)[number]

/** Which field a Chat Completions endpoint reads the output budget from:
 *  OpenAI's current one, or the older name many compatible servers still
 *  expect. */
export const CUSTOM_TOKEN_PARAMS = ['max_tokens', 'max_completion_tokens'] as const
export type CustomTokenParam = (typeof CUSTOM_TOKEN_PARAMS)[number]

export interface CustomModel {
  /** the id the endpoint is sent */
  id: string
  /** what the picker shows; the id when unset */
  name?: string
  /** false strips every image into a text note before sending */
  vision: boolean
  /** the most the model may write in one turn; the agent's budget when unset */
  maxOutputTokens?: number
}

/** What a custom provider is, as stored and as Settings shows it. The key
 *  and the extra headers are kept apart (sealed) and never sent back. */
export interface CustomProviderConfig {
  name: string
  apiType: CustomApiType
  baseUrl: string
  models: CustomModel[]
  /** Chat Completions only; `max_tokens` when unset */
  tokenParam?: CustomTokenParam
  /** Chat Completions only: send earlier turns' `reasoning_content` back,
   *  which DeepSeek- and Kimi-style servers refuse to run without */
  echoReasoning?: boolean
}

export const MAX_CUSTOM_PROVIDERS = 10
export const MAX_CUSTOM_MODELS = 50
export const MAX_CUSTOM_HEADERS = 10
const MAX_NAME = 60
const MAX_URL = 500
/* the composer's pick carries a model id of at most this (shared/agentRunner.ts) */
export const MAX_CUSTOM_MODEL_ID = 120
const MAX_HEADER_VALUE = 2000
const MAX_KEY = 2000
/* the agent asks for 16k per turn; a cap past this is a typo, not a model */
const MAX_OUTPUT_TOKENS = 1_000_000

/* request headers a person may not set: they would re-route or re-frame the
   request rather than describe it, or overwrite the key field's own header */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'cookie',
])

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/
/* printable ASCII and tabs only: no CR or LF to split a header with */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/
const MODEL_ID = /^[^\s]{1,120}$/

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** The base URL as it will be stored: http(s), no credentials, query or
 *  fragment, no trailing slash. Whether its host may be reached is the
 *  server's call (server/customProviderFetch.ts). */
export function normalizeBaseUrl(raw: string): Parsed<string> {
  const text = raw.trim()
  if (!text) return fail('Enter the base URL of the API')
  if (text.length > MAX_URL) return fail('That base URL is too long')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return fail('Enter a full URL, like https://api.example.com/v1')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('The base URL must start with https://')
  if (url.username || url.password) return fail('Put the key in the API key field, not in the URL')
  if (url.search || url.hash) return fail('The base URL cannot have a query string or a fragment')
  return { ok: true, value: url.href.replace(/\/+$/, '') }
}

function parseModel(value: unknown, index: number): Parsed<CustomModel> {
  if (!value || typeof value !== 'object') return fail(`Model ${index + 1} is not valid`)
  const { id, name, vision, maxOutputTokens } = value as Record<string, unknown>
  const modelId = typeof id === 'string' ? id.trim() : ''
  if (!MODEL_ID.test(modelId)) return fail(`Model ${index + 1} needs an id without spaces (at most 120 characters)`)
  const label = typeof name === 'string' ? name.trim() : ''
  if (label.length > MAX_NAME) return fail(`The name of ${modelId} is too long`)
  let cap: number | undefined
  if (maxOutputTokens !== undefined && maxOutputTokens !== null && maxOutputTokens !== '') {
    const n = Number(maxOutputTokens)
    if (!Number.isInteger(n) || n < 256 || n > MAX_OUTPUT_TOKENS) {
      return fail(`Max output tokens for ${modelId} must be a whole number from 256 to ${MAX_OUTPUT_TOKENS}`)
    }
    cap = n
  }
  return {
    ok: true,
    value: {
      id: modelId,
      ...(label && label !== modelId ? { name: label } : {}),
      vision: vision === true,
      ...(cap ? { maxOutputTokens: cap } : {}),
    },
  }
}

/** A provider's description as the Settings form sends it. */
export function parseCustomProviderConfig(value: unknown): Parsed<CustomProviderConfig> {
  if (!value || typeof value !== 'object') return fail('Fill in the provider')
  const body = value as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return fail('Give the provider a name')
  if (name.length > MAX_NAME) return fail('That name is too long')
  const apiType = CUSTOM_API_TYPES.find((type) => type === body.apiType)
  if (!apiType) return fail('Pick the API type')
  const baseUrl = normalizeBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '')
  if (!baseUrl.ok) return baseUrl
  if (!Array.isArray(body.models) || body.models.length === 0) return fail('Add at least one model')
  if (body.models.length > MAX_CUSTOM_MODELS) return fail(`A provider can list at most ${MAX_CUSTOM_MODELS} models`)
  const models: CustomModel[] = []
  for (const [index, entry] of body.models.entries()) {
    const model = parseModel(entry, index)
    if (!model.ok) return model
    if (models.some((m) => m.id === model.value.id)) return fail(`${model.value.id} is listed twice`)
    models.push(model.value)
  }
  const tokenParam = CUSTOM_TOKEN_PARAMS.find((param) => param === body.tokenParam)
  return {
    ok: true,
    value: {
      name,
      apiType,
      baseUrl: baseUrl.value,
      models,
      ...(apiType === 'openai-chat' && tokenParam && tokenParam !== 'max_tokens' ? { tokenParam } : {}),
      ...(apiType === 'openai-chat' && body.echoReasoning === true ? { echoReasoning: true } : {}),
    },
  }
}

/** Extra request headers, as `{ name: value }`. */
export function parseCustomHeaders(value: unknown): Parsed<Record<string, string>> {
  if (value === undefined || value === null) return { ok: true, value: {} }
  if (typeof value !== 'object' || Array.isArray(value)) return fail('Headers must be name and value pairs')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_CUSTOM_HEADERS) return fail(`At most ${MAX_CUSTOM_HEADERS} extra headers`)
  const headers: Record<string, string> = {}
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    if (!HEADER_NAME.test(name)) return fail(`"${name}" is not a valid header name`)
    if (RESERVED_HEADERS.has(name.toLowerCase())) return fail(`The ${name} header cannot be set here`)
    if (Object.keys(headers).some((seen) => seen.toLowerCase() === name.toLowerCase())) {
      return fail(`The ${name} header is listed twice`)
    }
    const headerValue = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!headerValue || headerValue.length > MAX_HEADER_VALUE || !HEADER_VALUE.test(headerValue)) {
      return fail(`The ${name} header needs a plain-text value`)
    }
    headers[name] = headerValue
  }
  return { ok: true, value: headers }
}

/** An optional API key: blank means the endpoint takes none. */
export function parseCustomKey(value: unknown): Parsed<string> {
  if (value === undefined || value === null) return { ok: true, value: '' }
  if (typeof value !== 'string') return fail('The API key must be text')
  const key = value.trim()
  if (key.length > MAX_KEY || /\s/.test(key)) return fail('That does not look like an API key')
  return { ok: true, value: key }
}

/** One "Name: value" per line, as the form's Advanced field takes them. */
export function headersFromText(text: string): Parsed<Record<string, string>> {
  const pairs: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    if (colon <= 0) return fail(`Write each header as Name: value ("${line.trim().slice(0, 40)}")`)
    const name = line.slice(0, colon).trim()
    if (Object.hasOwn(pairs, name)) return fail(`The ${name} header is listed twice`)
    pairs[name] = line.slice(colon + 1).trim()
  }
  return parseCustomHeaders(pairs)
}
