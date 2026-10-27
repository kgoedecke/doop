import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelCatalogFor } from '../server/modelCatalog.ts'
import { AGENT_MODELS } from '../server/openaiAgent.ts'
import type { ModelAccount } from '../server/modelAccounts.ts'

/**
 * A ChatGPT subscription's model menu comes from the Codex backend's own
 * catalog, asked with the account's token as the Codex CLI would ask, so the
 * tiers a plan unlocks (and gains, issue #209) are offered without a code
 * change. A ChatGPT account cannot be connected over HTTP in a test (OAuth),
 * so this drives the catalog module directly with a stubbed fetch.
 */

const CURATED = AGENT_MODELS.map((m) => ({ ...m, vision: true }))

const account: ModelAccount = {
  userId: 'u1',
  kind: 'chatgpt',
  accountId: 'acct_1',
  accessToken: 'tok-live',
  refreshToken: 'ref',
  expiresAt: Date.now() + 3_600_000,
  connectedAt: 1,
}

const CATALOG = {
  models: [
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', input_modalities: ['text', 'image'] },
    {
      slug: 'gpt-6.1-sol',
      display_name: 'GPT-6.1 Sol',
      description: 'Newest flagship',
      visibility: 'list',
      input_modalities: ['text', 'image'],
    },
    { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', input_modalities: ['text', 'image'] },
    /* hidden from the CLI's picker: out */
    { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'hidden', input_modalities: ['text', 'image'] },
    /* no screenshots: out */
    { slug: 'gpt-6-ink', display_name: 'GPT-6 Ink', visibility: 'list', input_modalities: ['text'] },
    /* not a reasoning family, or not a chat model: out */
    { slug: 'gpt-4.1', display_name: 'GPT-4.1', visibility: 'list', input_modalities: ['text', 'image'] },
    { slug: 'gpt-6-realtime', display_name: 'Realtime', visibility: 'list', input_modalities: ['text', 'image'] },
  ],
}

describe('ChatGPT model catalog', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks the Codex backend as the CLI would and offers what the plan unlocks, curated first', async () => {
    let seen: { url?: string; headers?: Record<string, string> } = {}
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      seen = { url: String(url), headers: init.headers as Record<string, string> }
      return new Response(JSON.stringify(CATALOG), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const catalog = await modelCatalogFor(account, CURATED)
    expect(catalog.live).toBe(true)
    expect(catalog.models.map((m) => m.id)).toEqual([
      /* curated tiers the backend confirmed, in curated order; Sol and Luna are not on this plan */
      'gpt-6-astra',
      'gpt-5.6-terra',
      /* then the rest in the backend's order */
      'gpt-6.1-sol',
    ])
    expect(catalog.models[0]).toMatchObject({ name: 'GPT-6 Astra', recommended: true })
    expect(catalog.models[2]).toMatchObject({ name: 'GPT-6.1 Sol', blurb: 'Newest flagship', vision: true })
    expect(seen.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.163.0')
    expect(seen.headers).toMatchObject({
      Authorization: 'Bearer tok-live',
      originator: 'codex_cli_rs',
      'chatgpt-account-id': 'acct_1',
    })
    expect(seen.headers?.['User-Agent']).toBeTruthy()
    expect(JSON.stringify(catalog)).not.toContain('tok-live')
  })

  it('keeps the curated four when the catalog lists nothing the agent can run', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        models: [
          /* a plan with no eligible tier, and a response shape that lost its modalities */
          { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'hidden', input_modalities: ['text', 'image'] },
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
        ],
      }),
    )
    const empty = await modelCatalogFor(account, CURATED)
    expect(empty).toMatchObject({ live: false, error: expect.stringMatching(/listed no models the agent can run/i) })
    expect(empty.models).toEqual(CURATED)
  })

  it('falls back to the curated four when the backend changes or refuses', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"detail":"unsupported client"}', { status: 400 }))
    const down = await modelCatalogFor(account, CURATED)
    expect(down).toMatchObject({ live: false, error: expect.stringMatching(/could not load models from ChatGPT/i) })
    expect(down.models).toEqual(CURATED)

    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
    const refused = await modelCatalogFor(account, CURATED)
    expect(refused).toMatchObject({ live: false, error: expect.stringMatching(/rejected the connected key/i) })

    const tokenless = await modelCatalogFor({ ...account, accessToken: undefined }, CURATED)
    expect(tokenless.live).toBe(false)
    expect(tokenless.models).toEqual(CURATED)
  })
})
