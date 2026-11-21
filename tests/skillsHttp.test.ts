import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { Skill } from '../shared/skills.ts'

/**
 * Skills against the REAL server (see ./harness.ts): each lives in one scope
 * (a workspace, or a person's own), only members read or change a
 * workspace's, and a handle is unique in its scope.
 */

let server: Server
let owner: Client
let mate: Client
let stranger: Client
let workspaceId: string

const BRAND = {
  handle: 'brand-check',
  description: 'Check copy against the brand voice',
  body: 'Read every heading and button label against the brand voice: short, warm, no jargon.',
}

const handles = async (client: Client, query = '') =>
  ((await (await client.get(`/api/skills${query}`)).json()) as Skill[]).map((s) => s.handle)

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('skills-owner@test.dev', 'Owner')
  mate = await new Client(server).signUp('skills-mate@test.dev', 'Mate')
  stranger = await new Client(server).signUp('skills-stranger@test.dev', 'Stranger')
  workspaceId = (await (await owner.post('/api/workspaces', { name: 'Skills Co' })).json()).id
  expect((await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'skills-mate@test.dev' })).status).toBe(
    200,
  )
}, 70_000)

afterAll(() => server?.stop())

describe('personal skills', () => {
  it('creates, edits and deletes one, seen by its owner only', async () => {
    const created = await owner.post('/api/skills', BRAND)
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject(BRAND)
    expect(await handles(owner)).toEqual(['brand-check'])
    expect(await handles(stranger)).toEqual([])

    const edited = await owner.patch('/api/skills/brand-check', { description: 'Brand voice', handle: 'renamed' })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({ handle: 'brand-check', description: 'Brand voice' })

    expect((await stranger.delete('/api/skills/brand-check')).status).toBe(404)
    expect((await owner.delete('/api/skills/brand-check')).status).toBe(200)
    expect(await handles(owner)).toEqual([])
    expect((await owner.patch('/api/skills/brand-check', { description: 'Gone' })).status).toBe(404)
  })

  it('refuses a handle already taken and a skill that does not parse', async () => {
    expect((await owner.post('/api/skills', BRAND)).status).toBe(200)
    const taken = await owner.post('/api/skills', BRAND)
    expect(taken.status).toBe(400)
    expect((await taken.json()).error).toMatch(/\/brand-check is already taken/)
    expect((await owner.post('/api/skills', { ...BRAND, handle: 'x', body: 'short' })).status).toBe(400)
    /* another scope may use the same handle */
    expect((await stranger.post('/api/skills', BRAND)).status).toBe(200)
  })

  it('refuses the skill past the limit', async () => {
    const client = await new Client(server).signUp('skills-many@test.dev', 'Many')
    for (let i = 0; i < 50; i++)
      expect((await client.post('/api/skills', { ...BRAND, handle: `s${i}` })).status).toBe(200)
    const over = await client.post('/api/skills', { ...BRAND, handle: 'one-more' })
    expect(over.status).toBe(400)
    expect((await over.json()).error).toMatch(/50 skills/)
  }, 30_000)
})

describe('workspace skills', () => {
  it('are shared by members and closed to everyone else', async () => {
    const q = `?workspace=${workspaceId}`
    expect((await mate.post(`/api/skills${q}`, { ...BRAND, handle: 'release-notes' })).status).toBe(200)
    expect(await handles(owner, q)).toEqual(['release-notes'])
    expect((await owner.patch(`/api/skills/release-notes${q}`, { body: BRAND.body + ' Owner edit.' })).status).toBe(200)

    expect((await stranger.get(`/api/skills${q}`)).status).toBe(403)
    expect((await stranger.post(`/api/skills${q}`, BRAND)).status).toBe(403)
    expect((await stranger.patch(`/api/skills/release-notes${q}`, { description: 'x' })).status).toBe(403)
    expect((await stranger.delete(`/api/skills/release-notes${q}`)).status).toBe(403)

    /* a workspace's skills are not anyone's personal ones */
    expect(await handles(mate)).toEqual([])
  })
})

describe('the skills a canvas offers', () => {
  it('lists handles and descriptions to whoever may ask an agent for work, never the instructions', async () => {
    const q = `?workspace=${workspaceId}`
    await mate.post(`/api/skills${q}`, { ...BRAND, handle: 'menu-check' })
    const canvasId = (await (await owner.post('/api/canvases', { name: 'Menu', workspaceId })).json()).id
    const list = async (client: Client) => client.get(`/api/canvases/${canvasId}/skills`)

    const offered = (await (await list(mate)).json()) as { skills: Partial<Skill>[]; addIn: unknown }
    expect(offered.skills.find((s) => s.handle === 'menu-check')).toEqual({
      handle: 'menu-check',
      description: BRAND.description,
    })
    /* a member may add to the workspace's skills */
    expect(offered.addIn).toEqual({ workspaceId })

    expect((await list(stranger)).status).toBe(403)
    await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })
    expect((await list(stranger)).status).toBe(403)
    /* a commenter cannot @mention an agent (refuseAgentMention), so no skill would run */
    await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'comment' })
    expect((await list(stranger)).status).toBe(403)
    await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })
    const visitor = await list(stranger)
    expect(visitor.status).toBe(200)
    /* a link editor uses them, but adds nowhere */
    expect((await visitor.json()).addIn).toBeNull()
  })

  it('offers a personal canvas’s owner their own skills to add to', async () => {
    const canvasId = (await (await owner.post('/api/canvases', { name: 'Mine' })).json()).id
    const own = await (await owner.get(`/api/canvases/${canvasId}/skills`)).json()
    expect(own.addIn).toEqual({ personal: true })
    await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })
    expect((await (await stranger.get(`/api/canvases/${canvasId}/skills`)).json()).addIn).toBeNull()
  })
})
