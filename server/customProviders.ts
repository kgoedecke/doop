import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { customTurn, type CustomTarget } from './agentModel.ts'
import { customProviderFetch, reachableUrl } from './customProviderFetch.ts'
import type { ModelOption } from '../shared/modelMenu.ts'
import { MAX_CUSTOM_MODEL_ID, type CustomModel, type CustomProviderConfig } from '../shared/customProvider.ts'

/**
 * What Settings asks of a custom provider while it is being set up: which
 * models the endpoint lists, and whether one of them can drive the agent.
 * Both go through customProviderFetch like every turn does.
 */

/** A custom provider's models as a picker menu, in the order listed. */
export function customMenu(config: CustomProviderConfig): ModelOption[] {
  return config.models.map((model) => ({ id: model.id, name: model.name ?? model.id, blurb: '', vision: model.vision }))
}

const DISCOVERY_TIMEOUT_MS = 10_000
/* a gateway can list thousands; the form shows a picker, not a dump */
const MAX_DISCOVERED = 500

const ModelList = z.object({ data: z.array(z.object({ id: z.string() })) })

export class CustomProviderError extends Error {}

/**
 * The model ids the endpoint lists: `GET {base}/models` for Chat Completions,
 * `GET {base}/v1/models` for the Messages API. Many compatible servers list
 * nothing, which the form treats as "type them in".
 */
export async function discoverCustomModels(
  target: Pick<CustomTarget, 'apiKey' | 'headers'> & { config: Pick<CustomProviderConfig, 'apiType' | 'baseUrl'> },
): Promise<string[]> {
  const { config, apiKey, headers = {} } = target
  const anthropic = config.apiType === 'anthropic'
  const url = reachableUrl(`${config.baseUrl}${anthropic ? '/v1/models?limit=1000' : '/models'}`)
  const auth: Record<string, string> = apiKey
    ? anthropic
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${apiKey}` }
    : anthropic
      ? { 'anthropic-version': '2023-06-01' }
      : {}
  const res = await customProviderFetch(url, {
    headers: { ...headers, ...auth, Accept: 'application/json' },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!res.ok) {
    await res.body?.cancel()
    if (res.status === 401 || res.status === 403) {
      throw new CustomProviderError(`The endpoint refused the key (${res.status}).`)
    }
    if (res.status === 404) throw new CustomProviderError('The endpoint does not list its models. Add them by id.')
    throw new CustomProviderError(`The endpoint answered ${res.status} when asked for its models.`)
  }
  const parsed = ModelList.safeParse(await res.json().catch(() => null))
  if (!parsed.success) throw new CustomProviderError('The endpoint’s model list was not in the expected shape.')
  const ids = parsed.data.data
    .map((model) => model.id.trim())
    .filter((id) => id && id.length <= MAX_CUSTOM_MODEL_ID && !/\s/.test(id))
  return [...new Set(ids)].slice(0, MAX_DISCOVERED)
}

const TEST_TIMEOUT_MS = 60_000

const PING_TOOL: Anthropic.Tool = {
  name: 'report_ready',
  description: 'Report that you are ready. Call this tool exactly once.',
  input_schema: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] },
}

/**
 * One short turn that has to end in a tool call: the agent does everything
 * through tools, so an endpoint that answers in prose (or garbles the call)
 * would fail every design run. Resolves when the model called the tool,
 * rejects with the reason otherwise.
 */
export async function testCustomProvider(target: CustomTarget, model: CustomModel): Promise<void> {
  const run = customTurn(target, model)
  const result = await run({
    system: [{ text: 'You are checking a connection. Use the report_ready tool to answer.' }],
    tools: [PING_TOOL],
    messages: [{ role: 'user', content: 'Call report_ready with ready set to true.' }],
    maxTokens: Math.min(2048, model.maxOutputTokens ?? 2048),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  })
  /* the call must arrive whole: a server that garbles the arguments (which
     the transport turns into an empty object) would garble every design
     tool's arguments too */
  const called = result.content.some(
    (block) =>
      block.type === 'tool_use' &&
      block.name === PING_TOOL.name &&
      (block.input as { ready?: unknown } | null)?.ready === true,
  )
  if (!called) {
    throw new CustomProviderError(
      `${model.id} answered without calling a tool. Doop’s agent works through tool calls, so pick a model (or a server setting) with tool calling.`,
    )
  }
}

const PROBE_WINDOW_MS = 10 * 60_000
const PROBES_PER_WINDOW = 30
const probeHits = new Map<string, number[]>()

/** Whether this person may send one more model-list or test request: each
 *  one makes this server call a URL they chose, so they are rationed. */
export function takeProbeSlot(userId: string): boolean {
  const now = Date.now()
  /* forget people whose last probe has aged out, so the map follows recent
     use rather than everyone who ever set up a provider */
  for (const [user, hits] of probeHits) {
    if (now - (hits.at(-1) ?? 0) >= PROBE_WINDOW_MS) probeHits.delete(user)
  }
  const hits = (probeHits.get(userId) ?? []).filter((at) => now - at < PROBE_WINDOW_MS)
  if (hits.length >= PROBES_PER_WINDOW) {
    probeHits.set(userId, hits)
    return false
  }
  hits.push(now)
  probeHits.set(userId, hits)
  return true
}
