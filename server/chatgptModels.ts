import { createHash } from 'node:crypto'
import { z } from 'zod'
import { env } from './env.ts'
import type { ModelAccount } from './modelAccounts.ts'
import type { ModelOption } from '../shared/modelMenu.ts'
import { fetchCatalogJson, loadModelCatalog, type ModelCatalog } from './modelCatalog.ts'

export type ChatgptModelCatalog = ModelCatalog

const modelSchema = z.object({
  slug: z.string().min(1).max(200),
  display_name: z.string().min(1).max(200),
  description: z.string().optional(),
  visibility: z.string(),
  input_modalities: z.array(z.string()),
})
const responseSchema = z.object({ models: z.array(z.unknown()).max(1000) })
/** The existing subscription transport always sends screenshot inputs. Only
 * advertise visible models that accept both text and images on that transport.
 * Return only picker metadata: provider instructions and credentials stay here. */
function parseModels(payload: unknown): ModelOption[] {
  const response = responseSchema.parse(payload)
  const models = new Map<string, ModelOption>()
  for (const value of response.models) {
    const parsed = modelSchema.safeParse(value)
    if (!parsed.success) continue
    const model = parsed.data
    if (
      model.visibility !== 'list' ||
      !model.input_modalities.includes('text') ||
      !model.input_modalities.includes('image')
    )
      continue
    if (!models.has(model.slug)) {
      models.set(model.slug, {
        id: model.slug,
        name: model.display_name,
        blurb: model.description ?? '',
        vision: true,
      })
    }
  }
  return [...models.values()]
}

/** Cache separately for each user and credential/account identity, coalescing
 * concurrent requests. Rotating a token or switching accounts forces a refresh.
 * A transient failure can reuse that same account's last catalog, with a visible
 * warning; rejected credentials never reuse a previous list. */
export async function getChatgptModelCatalog(account: ModelAccount): Promise<ChatgptModelCatalog> {
  if (account.kind !== 'chatgpt' || !account.accessToken) {
    throw new Error('Reconnect your ChatGPT account to load its models.')
  }
  const identity = createHash('sha256')
    .update(JSON.stringify([account.accountId, account.accessToken]))
    .digest('hex')
  return loadModelCatalog(`chatgpt:${account.userId}`, identity, 'ChatGPT', async (signal) => {
    const url = new URL(env.CHATGPT_MODELS_URL)
    url.searchParams.set('client_version', env.CHATGPT_MODELS_CLIENT_VERSION)
    return parseModels(
      await fetchCatalogJson(
        url,
        {
          Authorization: `Bearer ${account.accessToken}`,
          'User-Agent': env.CHATGPT_AUTH_USER_AGENT,
          originator: env.CHATGPT_ORIGINATOR,
          ...(account.accountId ? { 'chatgpt-account-id': account.accountId } : {}),
        },
        signal,
      ),
    )
  })
}
