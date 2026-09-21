import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
const state = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('../server/db/index.ts', () => ({
  get db() {
    return state.db
  },
}))
import {
  getLocalAgentPreference,
  saveLocalAgentPreference,
  requireRemoteAuth,
  clearRemoteAuth,
  beginRemoteReauth,
} from '../server/localAgentPreferences.ts'
const client = new PGlite()
beforeAll(async () => {
  await client.exec(`CREATE TABLE local_agent_preferences (
    user_id text PRIMARY KEY, transport text NOT NULL DEFAULT 'local', enabled boolean NOT NULL DEFAULT false,
    model text NOT NULL DEFAULT 'default', remote_auth_required boolean NOT NULL DEFAULT false,
    remote_auth_generation integer NOT NULL DEFAULT 0, remote_auth_attempt text
  )`)
  state.db = drizzle(client)
})
afterAll(() => client.close())
it('retains the auth gate, isolates users, and fences failures from before reconnect', async () => {
  await saveLocalAgentPreference('alice', { enabled: true, transport: 'remote', model: 'default' })
  await saveLocalAgentPreference('bob', { enabled: true, transport: 'remote', model: 'default' })
  await requireRemoteAuth('alice', 0)
  await saveLocalAgentPreference('alice', {
    enabled: true,
    transport: 'remote',
    model: 'opus',
    remoteAuthRequired: false,
  })
  expect((await getLocalAgentPreference('alice')).remoteAuthRequired).toBe(true)
  expect((await getLocalAgentPreference('bob')).remoteAuthRequired).toBe(false)
  await expect(clearRemoteAuth('alice', 0)).rejects.toThrow('changed')
  await beginRemoteReauth('alice', 'new-login')
  await requireRemoteAuth('alice', 0)
  expect((await getLocalAgentPreference('alice')).remoteAuthAttempt).toBe('new-login')
  await expect(clearRemoteAuth('alice', 0, 'old-login')).rejects.toThrow('changed')
  await clearRemoteAuth('alice', 0, 'new-login')
  await requireRemoteAuth('alice', 0)
  expect(await getLocalAgentPreference('alice')).toMatchObject({ remoteAuthRequired: false, remoteAuthGeneration: 1 })
  await requireRemoteAuth('alice', 1)
  expect((await getLocalAgentPreference('alice')).remoteAuthRequired).toBe(true)
})
