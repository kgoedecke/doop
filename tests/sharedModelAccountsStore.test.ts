import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The shared provider store (server/sharedModelAccounts.ts) against a
 * stand-in database: a row another build wrote is re-checked on the way out
 * and skipped when it does not hold, and removing a provider takes every
 * person's settings on it along.
 */

const mocks = vi.hoisted(() => ({
  rows: vi.fn((): unknown[] => []),
  deleted: [] as unknown[],
}))

vi.mock('../server/db/index.ts', () => {
  const where = () => Object.assign(Promise.resolve(mocks.rows()), { orderBy: async () => mocks.rows() })
  const tx = {
    delete: (table: unknown) => {
      mocks.deleted.push(table)
      return { where: () => Object.assign(Promise.resolve(), { returning: async () => [{ kind: 'k' }] }) }
    },
  }
  return {
    db: {
      select: () => ({ from: () => ({ where }) }),
      transaction: async (run: (t: typeof tx) => Promise<unknown>) => run(tx),
    },
  }
})

import { deleteSharedProvider, listSharedProviders } from '../server/sharedModelAccounts.ts'
import { imagePrefs, sharedModelAccountPrefs, sharedModelAccounts } from '../server/db/schema.ts'

const KIND = 'custom:0123456789abcdef01'
const row = {
  kind: KIND,
  custom: {
    name: 'Acme Gateway',
    apiType: 'openai-chat',
    baseUrl: 'https://llm.acme.example/v1',
    models: [{ id: 'qwen3-coder', vision: true }],
  },
  apiKey: 'sk-shared-never-logged',
  customHeaders: JSON.stringify({ 'X-Tenant': 'design' }),
  enabled: true,
  createdBy: 'admin',
  updatedBy: 'admin',
  createdAt: 1,
  updatedAt: 1,
}

afterEach(() => {
  vi.restoreAllMocks()
  mocks.rows.mockReturnValue([])
  mocks.deleted = []
})

describe('listSharedProviders', () => {
  it('reads a stored provider back with its key and headers', async () => {
    mocks.rows.mockReturnValue([row])
    expect(await listSharedProviders()).toEqual([
      {
        kind: KIND,
        custom: row.custom,
        apiKey: 'sk-shared-never-logged',
        headers: { 'X-Tenant': 'design' },
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
  })

  it('skips a row that no longer holds, with a warning that carries no secret', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.rows.mockReturnValue([
      { ...row, kind: 'custom:aaaaaaaaaaaaaaaaaa', custom: { ...row.custom, models: [] } },
      { ...row, kind: 'custom:bbbbbbbbbbbbbbbbbb', customHeaders: '{not json' },
      { ...row, kind: 'custom:cccccccccccccccccc', customHeaders: JSON.stringify({ Host: 'elsewhere' }) },
      { ...row, kind: 'openai-key' },
      /* sealed under an encryption key this server does not have */
      { ...row, kind: 'custom:dddddddddddddddddd', apiKey: 'enc:v1:gone:c2stc2hhcmVkLW5ldmVyLWxvZ2dlZA' },
      row,
    ])
    expect((await listSharedProviders()).map((provider) => provider.kind)).toEqual([KIND])
    expect(warn).toHaveBeenCalledTimes(5)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('sk-shared-never-logged')
    expect(logged).not.toContain('design')
    expect(logged).not.toContain('c2stc2hhcmVkLW5ldmVyLWxvZ2dlZA')
  })
})

describe('deleteSharedProvider', () => {
  it('removes every person’s settings on it with it, their image-model picks on it included', async () => {
    expect(await deleteSharedProvider(KIND)).toBe(true)
    expect(mocks.deleted).toEqual([sharedModelAccounts, sharedModelAccountPrefs, imagePrefs])
  })
})
