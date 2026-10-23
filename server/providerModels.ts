import { createHash } from 'node:crypto'
import { z } from 'zod'
import { env } from './env.ts'
import type { ModelAccount } from './modelAccounts.ts'
import { ACCOUNT_KIND_LABELS, type ModelOption } from '../shared/modelMenu.ts'
import { fetchCatalogJson, loadModelCatalog, type ModelCatalog } from './modelCatalog.ts'

export type DiscoveredKeyKind = 'openai-key' | 'anthropic-key' | 'gemini-key'

export function hasApiModelCatalog(kind: ModelAccount['kind']): kind is DiscoveredKeyKind {
  return kind === 'openai-key' || kind === 'anthropic-key' || kind === 'gemini-key'
}

const id = z.string().min(1).max(200)
const support = z.object({ supported: z.boolean() })
const anthropicModel = z.object({
  id,
  display_name: z.string().max(200),
  max_tokens: z.number().nullable().optional(),
  lifecycle: z.string().optional(),
  capabilities: z.object({ image_input: support }).nullable().optional(),
})
const anthropicPage = z.object({
  data: z.array(z.unknown()).max(1000),
  has_more: z.boolean(),
  last_id: id.nullable().optional(),
})
const geminiModel = z.object({
  name: id,
  displayName: z.string().max(200).optional(),
  description: z.string().optional(),
  supportedGenerationMethods: z.array(z.string()),
  outputTokenLimit: z.number(),
})
const geminiPage = z.object({
  models: z.array(z.unknown()).max(1000),
  nextPageToken: z.string().max(4096).optional(),
})
const openaiModel = z.object({ id, created: z.number(), shutdown_date: z.string().nullable().optional() })
const openaiPage = z.object({ data: z.array(z.unknown()).max(10000) })

/* The catalogs do not all expose tool/vision/transport capabilities. Admit
 * only reviewed general-purpose families, never arbitrary names containing
 * "gpt" or "gemini". New revisions within these families are discovered;
 * new families need a compatibility review. No inference probes or charges.
 * OpenAI: /api/docs/guides/latest-model (Responses, images, tools, reasoning).
 * Gemini: /gemini-api/docs/openai (images + function calling), /docs/models.
 * Anchoring excludes chat-only, Codex-only, research, audio, image and Live variants. */
const OPENAI_AGENT_MODEL =
  /^(?:gpt-(?:5(?:\.\d+)?|6(?:\.\d+)?)(?:-(?:mini|nano|sol|terra|luna|astra))?|o3|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/
const GEMINI_AGENT_MODEL =
  /^gemini-(?:(?:2\.5|3(?:\.\d+)?)-(?:pro|flash(?:-lite)?)|4-argon)(?:-preview(?:-\d{2}-(?:\d{2}|\d{4}))?|-\d{3})?$/

async function openaiModels(apiKey: string, signal: AbortSignal): Promise<ModelOption[]> {
  const page = openaiPage.parse(
    await fetchCatalogJson(new URL(env.OPENAI_MODELS_URL), { Authorization: `Bearer ${apiKey}` }, signal),
  )
  const models = page.data.flatMap((value) => {
    const parsed = openaiModel.safeParse(value)
    if (!parsed.success || !OPENAI_AGENT_MODEL.test(parsed.data.id)) return []
    const model = parsed.data
    if (model.shutdown_date && model.shutdown_date <= new Date().toISOString().slice(0, 10)) return []
    return [model]
  })
  return models
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .map((model) => ({
      id: model.id,
      name: model.id.replace(/^gpt-/, 'GPT-'),
      blurb: '',
      vision: true,
    }))
}

async function anthropicModels(apiKey: string, signal: AbortSignal): Promise<ModelOption[]> {
  const models: ModelOption[] = []
  const cursors = new Set<string>()
  const url = new URL(env.ANTHROPIC_MODELS_URL)
  url.searchParams.set('limit', '1000')
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = anthropicPage.parse(
      await fetchCatalogJson(url, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal),
    )
    for (const value of page.data) {
      const parsed = anthropicModel.safeParse(value)
      if (!parsed.success) continue
      const model = parsed.data
      // Messages models with image input and room for Doop's largest (32k) turn.
      // Unknown capabilities are excluded instead of silently assuming vision.
      if (
        !/^claude-(?:opus|sonnet|haiku|fable)-[45](?:-\d+)*$/.test(model.id) ||
        model.lifecycle === 'retired' ||
        !model.capabilities?.image_input.supported ||
        (model.max_tokens ?? 0) < 32000
      )
        continue
      models.push({ id: model.id, name: model.display_name, blurb: '', vision: true })
    }
    if (!page.has_more) return models
    if (!page.last_id || cursors.has(page.last_id)) throw new Error('Invalid catalog pagination')
    cursors.add(page.last_id)
    url.searchParams.set('after_id', page.last_id)
  }
  throw new Error('Catalog pagination limit reached')
}

async function geminiModels(apiKey: string, signal: AbortSignal): Promise<ModelOption[]> {
  const models: ModelOption[] = []
  const cursors = new Set<string>()
  const url = new URL(env.GEMINI_MODELS_URL)
  url.searchParams.set('pageSize', '1000')
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = geminiPage.parse(await fetchCatalogJson(url, { 'x-goog-api-key': apiKey }, signal))
    for (const value of page.models) {
      const parsed = geminiModel.safeParse(value)
      if (!parsed.success) continue
      const model = parsed.data
      const modelId = model.name.replace(/^models\//, '')
      if (
        !GEMINI_AGENT_MODEL.test(modelId) ||
        !model.supportedGenerationMethods.includes('generateContent') ||
        model.outputTokenLimit < 32000
      )
        continue
      models.push({ id: modelId, name: model.displayName || modelId, blurb: model.description ?? '', vision: true })
    }
    if (!page.nextPageToken) return models.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))
    if (cursors.has(page.nextPageToken)) throw new Error('Invalid catalog pagination')
    cursors.add(page.nextPageToken)
    url.searchParams.set('pageToken', page.nextPageToken)
  }
  throw new Error('Catalog pagination limit reached')
}

const loaders = { 'openai-key': openaiModels, 'anthropic-key': anthropicModels, 'gemini-key': geminiModels }

export async function getApiModelCatalog(account: ModelAccount): Promise<ModelCatalog> {
  if (!hasApiModelCatalog(account.kind) || !account.apiKey) throw new Error('Reconnect your provider to load models.')
  const kind = account.kind
  const apiKey = account.apiKey
  const identity = createHash('sha256').update(apiKey).digest('hex')
  return loadModelCatalog(`${kind}:${account.userId}`, identity, ACCOUNT_KIND_LABELS[kind], async (signal) => {
    const models = await loaders[kind](apiKey, signal)
    return [...new Map(models.map((model) => [model.id, model])).values()]
  })
}
