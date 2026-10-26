import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { env } from './env.ts'
import type { ModelAccount } from './modelAccounts.ts'
import { ACCOUNT_KIND_LABELS, type ModelOption } from '../shared/modelMenu.ts'

/**
 * The models a connected account can run right now, asked of the provider
 * with the user's own credential. The curated menu in `shared/` stays the
 * list of recommendations (order, blurb, default); the provider's catalog
 * says which of them this account actually has and which newer ones it has
 * gained since the menu was written, so a release no longer waits on a
 * hand edit here.
 *
 * Nothing is cached: the picker asks when it opens and Settings when it
 * loads, one catalog call each, well under a second on every provider.
 * When the call fails the curated menu is served with `live: false` and a
 * message, never an empty picker.
 *
 * The catalogs do not say what a model can do, so each loader keeps a
 * family filter of its own: the agent needs tools, screenshots and room for
 * a full turn, and a catalog lists plenty of models that offer none of that
 * (embeddings, audio, image generation, realtime). Those filters admit new
 * revisions of a known family; a new family is a review, not a regex edit.
 * OpenRouter stays on its curated roster: its catalog mixes text-only
 * models, and the run-time vision check only knows the roster's flags.
 */

export interface ModelCatalog {
  models: ModelOption[]
  /** true when `models` came from the provider; false means the curated fallback */
  live: boolean
  /** why the provider's list could not be loaded, for the picker's caption */
  error?: string
}

/* the output budget resident.ts asks for per turn; a model capped lower would 400 */
const TURN_OUTPUT_TOKENS = 16_000

/** Ids shaped like something each provider's API will accept as a model. The
 *  catalog decides what is offered; the run decides what works. OpenAI is
 *  held to the reasoning families (GPT-5 and later, the o-series): the runner
 *  always sends `reasoning.effort`, which GPT-4-era models reject outright. */
export const CLAUDE_API_MODEL = /^claude-[a-z0-9][a-z0-9.-]{0,98}$/
export const OPENAI_API_MODEL = /^(?:gpt-(?:[5-9]|\d{2,})|o[1-9])[a-z0-9.-]{0,98}$/
export const GEMINI_API_MODEL = /^gemini-[a-z0-9][a-z0-9.-]{0,98}$/

/* catalog entries that are not a chat model the agent could drive */
const NOT_AN_AGENT_MODEL = /realtime|audio|tts|transcribe|embedding|image|moderation|search|instruct|chat|live|robotics/

class CatalogAccessError extends Error {}

/** One catalog request. Only the provider's status crosses this boundary;
 *  the body is parsed by the caller's schema and the credential never leaves. */
async function fetchCatalog(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers, signal, redirect: 'error' })
  if (!res.ok) {
    await res.body?.cancel()
    if (res.status === 401 || res.status === 403) throw new CatalogAccessError()
    throw new Error(`catalog request failed with ${res.status}`)
  }
  return res.json()
}

/** Messages models with image input and room for a full turn, newest first.
 *  The SDK pages through `/v1/models` itself and honours ANTHROPIC_BASE_URL. */
async function anthropicModels(apiKey: string, signal: AbortSignal): Promise<ModelOption[]> {
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  const models: (ModelOption & { createdAt: string })[] = []
  try {
    for await (const model of client.models.list({ limit: 1000 }, { signal })) {
      if (!CLAUDE_API_MODEL.test(model.id)) continue
      if (model.capabilities && !model.capabilities.image_input.supported) continue
      if (model.max_tokens != null && model.max_tokens < TURN_OUTPUT_TOKENS) continue
      models.push({ id: model.id, name: model.display_name, blurb: '', vision: true, createdAt: model.created_at })
    }
  } catch (error) {
    if (error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403))
      throw new CatalogAccessError()
    throw error
  }
  return models
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .map(({ createdAt: _createdAt, ...model }) => model)
}

const openaiPage = z.object({ data: z.array(z.object({ id: z.string(), created: z.number() }).passthrough()) })

/** The reasoning GPT and o-series families, newest first. `/v1/models` says
 *  nothing about capabilities, so the family filter stands in; every model it
 *  admits speaks the Responses API with tools, images and a reasoning block. */
async function openaiModels(apiKey: string, signal: AbortSignal): Promise<ModelOption[]> {
  const page = openaiPage.parse(
    await fetchCatalog(new URL(env.OPENAI_MODELS_URL), { Authorization: `Bearer ${apiKey}` }, signal),
  )
  return page.data
    .filter((model) => OPENAI_API_MODEL.test(model.id) && !NOT_AN_AGENT_MODEL.test(model.id))
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .map((model) => ({ id: model.id, name: model.id.replace(/^gpt-/, 'GPT-'), blurb: '', vision: true }))
}

const geminiPage = z.object({
  models: z.array(
    z
      .object({
        name: z.string(),
        displayName: z.string().optional(),
        supportedGenerationMethods: z.array(z.string()).default([]),
        outputTokenLimit: z.number().optional(),
      })
      .passthrough(),
  ),
  nextPageToken: z.string().optional(),
})

/** Gemini models that answer `generateContent` with room for a turn. The
 *  catalog lists newest first already; Google gives no release date to sort on. */
async function geminiModels(apiKey: string, signal: AbortSignal): Promise<ModelOption[]> {
  const models: ModelOption[] = []
  const url = new URL(env.GEMINI_MODELS_URL)
  url.searchParams.set('pageSize', '1000')
  for (let pages = 0; pages < 20; pages++) {
    const page = geminiPage.parse(await fetchCatalog(url, { 'x-goog-api-key': apiKey }, signal))
    for (const model of page.models) {
      const id = model.name.replace(/^models\//, '')
      if (!GEMINI_API_MODEL.test(id) || NOT_AN_AGENT_MODEL.test(id)) continue
      if (!model.supportedGenerationMethods.includes('generateContent')) continue
      if (model.outputTokenLimit != null && model.outputTokenLimit < TURN_OUTPUT_TOKENS) continue
      models.push({ id, name: model.displayName || id, blurb: '', vision: true })
    }
    if (!page.nextPageToken) return models
    url.searchParams.set('pageToken', page.nextPageToken)
  }
  throw new Error('Gemini catalog did not end')
}

type Loader = (apiKey: string, signal: AbortSignal) => Promise<ModelOption[]>

const LOADERS: Partial<Record<ModelAccount['kind'], Loader>> = {
  'anthropic-key': anthropicModels,
  'openai-key': openaiModels,
  'gemini-key': geminiModels,
}

/** Curated entries the provider confirms come first, in curated order, with
 *  their blurbs; the rest of the catalog follows. A curated id the provider
 *  does not list is dropped — offering a tier the account cannot run is the
 *  bug this exists to fix. */
function merge(curated: ModelOption[], live: ModelOption[]): ModelOption[] {
  const liveById = new Map(live.map((model) => [model.id, model]))
  const recommended = curated.flatMap((option) => {
    if (!liveById.delete(option.id)) return []
    return [{ ...option, recommended: true }]
  })
  return [...recommended, ...liveById.values()]
}

/** The menu for this account: the provider's list merged over the curated
 *  one, or the curated one alone for a kind with no catalog, or when the
 *  provider cannot be reached. */
export async function modelCatalogFor(account: ModelAccount, curated: ModelOption[]): Promise<ModelCatalog> {
  const load = LOADERS[account.kind]
  if (!load || !account.apiKey) return { models: curated, live: false }
  try {
    return { models: merge(curated, await load(account.apiKey, AbortSignal.timeout(8_000))), live: true }
  } catch (error) {
    const label = ACCOUNT_KIND_LABELS[account.kind]
    return {
      models: curated,
      live: false,
      error:
        error instanceof CatalogAccessError
          ? `${label} rejected the connected key. Reconnect it to see its models.`
          : `Could not load models from ${label}. Showing the built-in list.`,
    }
  }
}
