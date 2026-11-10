import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let human: Client
let bot: Client
let foreign: Client
let botId: string
let workspaceId: string
let foreignWorkspace: string
let canvasId: string
let configuration: Record<string, string>

beforeAll(async () => {
  server = await startServer()
  human = await new Client(server).signUp('company-human@test.dev', 'Human')
  bot = await new Client(server).signUp('company-bot@test.dev', 'Bot')
  foreign = await new Client(server).signUp('company-foreign@test.dev', 'Foreign')
  botId = (await (await bot.get('/api/me')).json()).id
  workspaceId = (await (await human.post('/api/workspaces', { name: 'Private company' })).json()).id
  foreignWorkspace = (await (await foreign.post('/api/workspaces', { name: 'Foreign company' })).json()).id
  expect((await human.post(`/api/workspaces/${workspaceId}/members`, { email: 'company-bot@test.dev' })).status).toBe(
    200,
  )
  const welcome = await (await bot.get('/api/canvases')).json()
  for (const canvas of welcome) {
    if (canvas.ownerId === botId && !canvas.workspaceId)
      expect((await bot.delete(`/api/canvases/${canvas.id}`)).status).toBe(200)
  }
  configuration = { MANAGED_COMPANY_WORKSPACES: JSON.stringify([{ workspaceId, botUserId: botId }]) }
  server.stop({ keepData: true })
  server = await startServer(configuration, server.dataDir)
}, 70_000)

afterAll(() => server?.stop())

it('allows own private work and copying while competing foreign invites and personal creates fail', async () => {
  const created = await bot.post('/api/canvases', { name: 'Private work', workspaceId })
  expect(created.status).toBe(200)
  canvasId = (await created.json()).id
  expect((await human.get(`/api/canvases/${canvasId}`)).status).toBe(200)
  expect((await foreign.get(`/api/canvases/${canvasId}`)).status).toBe(403)
  const copy = await bot.post(`/api/canvases/${canvasId}/duplicate`)
  expect(copy.status).toBe(200)
  expect((await copy.json()).workspaceId).toBe(workspaceId)
  const contenders = await Promise.all([
    foreign.post(`/api/workspaces/${foreignWorkspace}/members`, { email: 'company-bot@test.dev' }),
    foreign.post(`/api/workspaces/${foreignWorkspace}/members`, { email: 'company-bot@test.dev' }),
    bot.post('/api/canvases', { name: 'Forbidden one' }),
    bot.post('/api/canvases', { name: 'Forbidden two' }),
  ])
  expect(contenders.map((response) => response.status)).toEqual([403, 403, 403, 403])
  const listing = await (await bot.get('/api/canvases')).json()
  expect(listing.length).toBe(2)
  expect(listing.every((canvas: { workspaceId: string }) => canvas.workspaceId === workspaceId)).toBe(true)
})

it('denies audience widening, promotion, workspace deletion and private design-sync keys', async () => {
  expect((await bot.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })).status).toBe(403)
  expect((await bot.put(`/api/canvases/${canvasId}/workspace`, { workspaceId: null })).status).toBe(403)
  expect((await bot.post(`/api/canvases/${canvasId}/members`, { email: 'company-foreign@test.dev' })).status).toBe(403)
  expect((await bot.post('/api/workspaces', { name: 'Forbidden workspace' })).status).toBe(403)
  expect((await human.patch(`/api/workspaces/${workspaceId}/members/${botId}`, { role: 'admin' })).status).toBe(403)
  expect((await human.delete(`/api/workspaces/${workspaceId}`)).status).toBe(403)
  expect((await human.get(`/api/canvases/${canvasId}/sync-keys`)).status).toBe(403)
  expect((await human.post(`/api/canvases/${canvasId}/sync-keys`, { name: 'Forbidden key' })).status).toBe(403)
})

it('revokes owner read/list/copy/room access and preserves removal across restart', async () => {
  expect((await bot.joinWs(canvasId)).kind).toBe('init')
  expect((await human.delete(`/api/workspaces/${workspaceId}/members/${botId}`)).status).toBe(200)
  const denied = async () => {
    expect((await bot.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect(await (await bot.get('/api/canvases')).json()).toEqual([])
    expect((await bot.post(`/api/canvases/${canvasId}/duplicate`)).status).toBe(403)
    expect(await bot.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4403 })
    expect((await human.get(`/api/canvases/${canvasId}`)).status).toBe(200)
  }
  await denied()
  server.stop({ keepData: true })
  server = await startServer(configuration, server.dataDir)
  await denied()
}, 70_000)
