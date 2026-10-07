import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { activeAgentTasks, agentActivityState } from '../shared/agentActivity.ts'
import type { AgentTask } from '../shared/types.ts'

const PORT = 5018
let server: Server
let owner: Client
let stranger: Client
let canvasId: string
beforeAll(async () => {
  server = await startServer(PORT, {
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
    DOOP_APNS_TEAM_ID: 'test',
    DOOP_APNS_KEY_ID: 'test',
    DOOP_APNS_PRIVATE_KEY: 'not-a-real-key',
  })
  owner = await new Client(server).signUp('activity-owner@test.local', 'Owner')
  stranger = await new Client(server).signUp('activity-other@test.local', 'Other')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Private design' })).json()).id
}, 70_000)
afterAll(() => server?.stop())

function register(client: Client, id: string, token = 'ab'.repeat(32)) {
  return client.req(`/api/live-activities/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ canvasId, token, environment: 'sandbox' }),
  })
}

describe('Live Activity registration', () => {
  it('requires a signed-in user and durable membership', async () => {
    expect((await fetch(`${server.base}/api/live-activities/config`)).status).toBe(401)
    expect((await register(stranger, 'uninvited')).status).toBe(403)
    await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })
    expect((await register(stranger, 'link-only')).status).toBe(403)
  })
  it('registers, rotates a token, and prevents account takeover', async () => {
    expect((await register(owner, 'own-activity')).status).toBe(200)
    expect((await register(owner, 'own-activity', 'cd'.repeat(32))).status).toBe(200)
    await owner.post(`/api/canvases/${canvasId}/members`, { email: 'activity-other@test.local' })
    expect((await register(stranger, 'own-activity', 'ef'.repeat(32))).status).toBe(409)
    expect((await stranger.delete('/api/live-activities/own-activity')).status).toBe(200)
    // A stranger's DELETE must not have removed the owner's subscription.
    expect((await register(stranger, 'own-activity', 'ef'.repeat(32))).status).toBe(409)
    expect((await owner.delete('/api/live-activities/own-activity')).status).toBe(200)
  })
  it('rejects malformed tokens and reports capability without revealing keys', async () => {
    expect((await register(owner, 'bad-token', 'not a token')).status).toBe(400)
    expect(await (await owner.get('/api/live-activities/config')).json()).toEqual({ enabled: true })
  })
})

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return { id: 't', agentName: 'Doop', color: '#2743ee', status: 'Designing', startedAt: 1000, ...overrides }
}
describe('agent badge state', () => {
  it('does not invent progress and excludes completed/failed work from the active count', () => {
    expect(agentActivityState('Canvas', [])).toBeNull()
    const state = agentActivityState('Canvas', [
      task(),
      task({ id: 'failed', failedAt: 2000 }),
      task({ id: 'done', endedAt: 2000 }),
    ])
    expect(state).toMatchObject({ phase: 'working', activeCount: 1, startedAt: 1 })
    expect(state).not.toHaveProperty('stage')
  })
  it('distinguishes waiting, completed, and failed tasks', () => {
    expect(agentActivityState('Canvas', [task({ agentName: '' })])?.phase).toBe('queued')
    expect(agentActivityState('Canvas', [task({ endedAt: 2000 })])?.phase).toBe('finished')
    expect(
      agentActivityState('Canvas', [task({ failedAt: 2000, failureReason: 'Provider unavailable' })]),
    ).toMatchObject({ phase: 'failed', status: 'Provider unavailable' })
  })
  it('shows actual pipeline stages and bounds user content for APNs', () => {
    const state = agentActivityState('📐'.repeat(500), [
      task({ status: '🪄'.repeat(1000), pipeline: ['doop', 'brand'], stage: 1 }),
    ])
    expect(state).toMatchObject({ stage: 2, stageCount: 2 })
    expect(Buffer.byteLength(JSON.stringify({ aps: { 'content-state': state } }))).toBeLessThan(4096)
  })
})

describe('working agents dashboard', () => {
  it('keeps current work and queued cards but removes finished and failed tasks', () => {
    const result = activeAgentTasks([
      task({ id: 'running', owner: 'private-owner' }),
      task({ id: 'queued', agentName: '' }),
      task({ id: 'done', endedAt: 2000 }),
      task({ id: 'failed', failedAt: 2000 }),
    ])
    expect(result.map((item) => item.id)).toEqual(['running', 'queued'])
    expect(result[0]).not.toHaveProperty('owner')
    expect(result[0]).toMatchObject({ agentName: 'Doop', status: 'Designing' })
  })
  it('only exposes activity for canvases in the signed-in users library', async () => {
    const privateId = (await (await owner.post('/api/canvases', { name: 'Only mine' })).json()).id
    const mine = await (await owner.get('/api/canvases')).json()
    expect(mine.find((canvas: { id: string }) => canvas.id === privateId)).toHaveProperty('activeTasks', [])
    const theirs = await (await stranger.get('/api/canvases')).json()
    expect(theirs.some((canvas: { id: string }) => canvas.id === privateId)).toBe(false)
  })
})
