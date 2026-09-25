import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ insert: vi.fn() }))
vi.mock('../server/db/index.ts', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([]), { limit: async () => [] }) }) }),
    insert: mocks.insert,
  },
}))
vi.mock('../server/modelAccounts.ts', () => ({ getStatus: async () => ({ connected: false }) }))
vi.mock('../server/localAgentPreferences.ts', () => ({ getLocalAgentPreference: async () => ({ enabled: false }) }))
import { consumeResidentTask, getAllowance } from '../server/allowance.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
it('permits pilot tasks without spending free credits and keeps other users metered', async () => {
  vi.stubEnv(
    'DOOP_GEMINI_CLOUD_WORKERS',
    JSON.stringify({ alice: { url: 'https://worker.example', token: 'x'.repeat(32) } }),
  )
  expect(await consumeResidentTask('alice')).toMatchObject({
    ok: true,
    byoModel: true,
    byoKind: 'gemini-cloud',
    onOwnAccount: true,
    used: 0,
  })
  expect(mocks.insert).not.toHaveBeenCalled()
  expect(await getAllowance('bob')).toMatchObject({ byoModel: false, onOwnAccount: false })
})
