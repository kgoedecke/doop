import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import type { SharedProvider, SharedProviderPrefs } from '../server/sharedModelAccounts.ts'

/**
 * Shared providers as one person has them: an admin's definition merged with
 * that person's own model, effort and on/off (server/modelAccounts.ts), and
 * the store underneath (server/sharedModelAccounts.ts) against a stand-in
 * database. The HTTP side is in sharedModelProvidersHttp.test.ts.
 */

const mocks = vi.hoisted(() => ({
  /* the person's own model_accounts rows */
  rows: vi.fn((): unknown[] => []),
  providers: [] as SharedProvider[],
  prefs: new Map<string, SharedProviderPrefs>(),
  saveSharedPref: vi.fn(async () => {}),
  isSharedKind: vi.fn(async (_kind: string) => false),
  deleteModelAccount: vi.fn(async () => {}),
  preference: vi.fn(async () => ({ enabled: false, model: 'default' })),
  stored: vi.fn((): { provider: string }[] => []),
}))

vi.mock('../server/db/index.ts', () => {
  /* every read here is select → from → where (→ orderBy) */
  const where = () => Object.assign(Promise.resolve(mocks.rows()), { orderBy: async () => mocks.rows() })
  return {
    db: {
      select: () => ({ from: () => ({ where }) }),
      delete: () => ({ where: mocks.deleteModelAccount }),
    },
  }
})
vi.mock('../server/agentDefaults.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/agentDefaults.ts')>()
  return { ...actual, getStoredDefault: async () => undefined }
})
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: mocks.preference }))
vi.mock('../server/sharedModelAccounts.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/sharedModelAccounts.ts')>()),
  listSharedProviders: async ({ enabledOnly = false }: { enabledOnly?: boolean } = {}) =>
    mocks.providers.filter((provider) => !enabledOnly || provider.enabled),
  getSharedProvider: async (kind: string) => mocks.providers.find((provider) => provider.kind === kind) ?? null,
  getSharedPrefs: async () => mocks.prefs,
  getSharedPref: async (_userId: string, kind: string) => mocks.prefs.get(kind),
  saveSharedPref: mocks.saveSharedPref,
  isSharedKind: mocks.isSharedKind,
}))

import {
  SharedAccountError,
  disconnect,
  getAccount,
  getAccounts,
  setAccountEnabled,
  setAccountModel,
  statusOf,
  updateCustomProvider,
} from '../server/modelAccounts.ts'
import { readConnections } from '../server/agentDefaults.ts'
import { listRunners } from '../server/agentRunners.ts'
import { generatorFor, imageModelAvailability } from '../server/imageGen.ts'

const GATEWAY = 'custom:0123456789abcdef01'
const OLD_GATEWAY = 'custom:fedcba98765432100f'

const gateway: SharedProvider = {
  kind: GATEWAY,
  custom: {
    name: 'Acme Gateway',
    apiType: 'openai-chat',
    baseUrl: 'https://llm.acme.example/team/v1',
    models: [
      { id: 'qwen3-coder', vision: true },
      { id: 'glm-5', vision: false },
    ],
  },
  apiKey: 'sk-shared-never-shown',
  headers: { 'X-Tenant': 'design' },
  enabled: true,
  createdAt: 10,
  updatedAt: 10,
}
const offGateway: SharedProvider = { ...gateway, kind: OLD_GATEWAY, enabled: false, createdAt: 5 }

/* the person's own Claude key, connected before the provider was shared */
const claudeRow = {
  userId: 'alice',
  kind: 'anthropic-key',
  enabled: true,
  apiKey: 'sk-ant-own',
  connectedAt: 1,
  updatedAt: 1,
}

afterEach(() => {
  vi.clearAllMocks()
  mocks.rows.mockReturnValue([])
  mocks.isSharedKind.mockResolvedValue(false)
  mocks.providers = []
  mocks.prefs = new Map()
  unstubAllEnvs()
})

describe('getAccounts', () => {
  it('lists the person’s own accounts first, then the shared ones an admin has on', async () => {
    mocks.rows.mockReturnValue([claudeRow])
    mocks.providers = [offGateway, gateway]
    const accounts = await getAccounts('alice')
    expect(accounts.map((account) => account.kind)).toEqual(['anthropic-key', GATEWAY])
    expect(accounts[1]).toMatchObject({
      userId: 'alice',
      kind: GATEWAY,
      shared: true,
      enabled: true,
      apiKey: 'sk-shared-never-shown',
      headers: { 'X-Tenant': 'design' },
      custom: { name: 'Acme Gateway' },
    })
  })

  it('carries the person’s own pick and on/off, and nobody else’s', async () => {
    mocks.providers = [gateway]
    mocks.prefs = new Map([[GATEWAY, { model: 'glm-5', enabled: false }]])
    expect(await getAccounts('alice')).toMatchObject([{ kind: GATEWAY, model: 'glm-5', enabled: false }])
    /* no row: the first model, on */
    mocks.prefs = new Map()
    const [fresh] = await getAccounts('bob')
    expect(fresh).toMatchObject({ kind: GATEWAY, enabled: true })
    expect(fresh?.model).toBeUndefined()
    expect(statusOf(fresh!).model).toBe('qwen3-coder')
  })

  it('hides every shared provider while the operator has custom providers off', async () => {
    stubEnv('DOOP_CUSTOM_PROVIDERS', 'false')
    mocks.providers = [gateway]
    expect(await getAccounts('alice')).toEqual([])
    expect(await getAccount('alice', GATEWAY)).toBeNull()
  })
})

describe('getAccount', () => {
  it('resolves a shared kind like a connected one, and a switched-off or deleted one as nothing', async () => {
    mocks.providers = [gateway, offGateway]
    mocks.prefs = new Map([[GATEWAY, { model: 'glm-5', enabled: true }]])
    expect(await getAccount('alice', GATEWAY)).toMatchObject({ shared: true, model: 'glm-5' })
    expect(await getAccount('alice', OLD_GATEWAY)).toBeNull()
    mocks.providers = []
    expect(await getAccount('alice', GATEWAY)).toBeNull()
  })
})

describe('a person’s changes on a shared provider', () => {
  it('writes the model and on/off to their own settings, checked against the shared models', async () => {
    mocks.providers = [gateway]
    await setAccountModel('alice', GATEWAY, 'glm-5')
    expect(mocks.saveSharedPref).toHaveBeenCalledWith('alice', GATEWAY, { model: 'glm-5' })
    await setAccountEnabled('alice', GATEWAY, false)
    expect(mocks.saveSharedPref).toHaveBeenLastCalledWith('alice', GATEWAY, { enabled: false })
    await expect(setAccountModel('alice', GATEWAY, 'gpt-5')).rejects.toThrow('unknown model')
  })

  it('refuses to edit or remove it', async () => {
    mocks.isSharedKind.mockResolvedValue(true)
    await expect(disconnect('alice', GATEWAY)).rejects.toBeInstanceOf(SharedAccountError)
    await expect(
      updateCustomProvider('alice', GATEWAY, gateway.custom, { apiKey: 'sk-mine-now' }),
    ).rejects.toBeInstanceOf(SharedAccountError)
    expect(mocks.deleteModelAccount).not.toHaveBeenCalled()
  })

  it('still disconnects a personal account', async () => {
    await disconnect('alice', 'anthropic-key')
    expect(mocks.deleteModelAccount).toHaveBeenCalledOnce()
  })
})

describe('what the person is told', () => {
  it('says it is shared, with the endpoint’s origin only and nothing about its headers', async () => {
    mocks.providers = [gateway]
    const [account] = await getAccounts('alice')
    const status = statusOf(account!)
    expect(status).toMatchObject({
      kind: GATEWAY,
      shared: true,
      custom: { name: 'Acme Gateway', baseUrl: 'https://llm.acme.example', headerNames: [], hasKey: true },
    })
    const text = JSON.stringify(status)
    expect(text).not.toContain('sk-shared-never-shown')
    expect(text).not.toContain('design')
    expect(text).not.toContain('/team/v1')
  })

  it('names a shared runner apart from a personal provider with the same name', async () => {
    mocks.rows.mockReturnValue([
      {
        userId: 'alice',
        kind: 'custom:aaaaaaaaaaaaaaaaaa',
        enabled: true,
        custom: gateway.custom,
        connectedAt: 1,
        updatedAt: 1,
      },
    ])
    mocks.providers = [gateway]
    const { runners } = await listRunners('alice')
    expect(runners.map((runner) => [runner.provider, runner.name, runner.shared])).toEqual([
      ['custom:aaaaaaaaaaaaaaaaaa', 'Acme Gateway', undefined],
      [GATEWAY, 'Acme Gateway', true],
    ])
  })
})

describe('the default connection', () => {
  it('is the first shared provider that is on for someone with no connection of their own', async () => {
    mocks.providers = [offGateway, gateway]
    expect((await readConnections('newcomer')).default).toBe(GATEWAY)
  })

  it('passes over a shared provider the person switched off', async () => {
    mocks.providers = [gateway]
    mocks.prefs = new Map([[GATEWAY, { enabled: false }]])
    expect((await readConnections('alice')).default).toBeUndefined()
  })

  it('stays the person’s own account when they have one', async () => {
    mocks.rows.mockReturnValue([claudeRow])
    mocks.providers = [gateway]
    expect((await readConnections('alice')).default).toBe('anthropic-key')
  })
})

describe('image generation', () => {
  it('bills a shared provider like the person’s own connection: the server’s image keys stay out', async () => {
    stubEnv('OPENAI_API_KEY', 'sk-server-paid')
    /* nothing connected at all: the server's key draws */
    const server = await generatorFor('newcomer')
    expect(server.ok && server.label).toBe('server')
    /* only the shared provider, which cannot draw: nothing does */
    mocks.providers = [gateway]
    const shared = await generatorFor('alice')
    expect(shared.ok).toBe(false)
    expect(!shared.ok && shared.reason).toContain('Acme Gateway')
  })

  it('draws on a shared provider that lists image models, for everyone, and not once the operator turns custom providers off', async () => {
    stubEnv('OPENAI_API_KEY', 'sk-server-paid')
    mocks.providers = [{ ...gateway, custom: { ...gateway.custom, imageModels: [{ id: 'flux-schnell' }] } }]
    for (const person of ['alice', 'bob']) {
      const generator = await generatorFor(person)
      expect(generator).toMatchObject({ ok: true, label: 'Acme Gateway', custom: 'shared' })
      expect((await imageModelAvailability(person)).find((model) => model.custom)?.id).toBe(`${GATEWAY}/flux-schnell`)
    }
    stubEnv('DOOP_CUSTOM_PROVIDERS', 'false')
    expect((await imageModelAvailability('alice')).some((model) => model.custom)).toBe(false)
    /* with the feature off nobody has a shared provider: as before it existed */
    expect(await generatorFor('alice')).toMatchObject({ ok: true, label: 'server' })
  })
})
