import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'
import type { AgentRole } from '../shared/agents.ts'
import type { BuiltInAgent, CustomAgent } from '../shared/customAgents.ts'

/**
 * Custom agents against the REAL server (see ./harness.ts): each lives in one
 * scope (a workspace, or a person's own), a canvas's team is the built-in six
 * plus its scope's agents, an @mention of one routes a comment to it only on
 * those canvases, and open rooms hear about changes.
 */

let server: Server
let owner: Client
let mate: Client
let stranger: Client
let workspaceId: string

const SEO = {
  name: 'SEO Reviewer',
  handle: 'seo',
  color: '#db2777',
  blurb: 'Titles, headings and meta copy',
  brief: 'You are the SEO reviewer. Check that the page has one clear h1 and headings in order.',
  reviewer: true,
}

beforeAll(async () => {
  server = await startServer({ RESIDENT_TASK_LIMIT: '100' })
  owner = await new Client(server).signUp('agents-owner@test.dev', 'Owner')
  mate = await new Client(server).signUp('agents-mate@test.dev', 'Mate')
  stranger = await new Client(server).signUp('agents-stranger@test.dev', 'Stranger')
  workspaceId = (await (await owner.post('/api/workspaces', { name: 'Agents Co' })).json()).id
  expect((await owner.post(`/api/workspaces/${workspaceId}/members`, { email: 'agents-mate@test.dev' })).status).toBe(
    200,
  )
}, 70_000)

afterAll(() => server?.stop())

async function canvasIn(client: Client, workspace?: string): Promise<{ id: string; pageId: string }> {
  const canvas = await (
    await client.post('/api/canvases', { name: 'Team', ...(workspace ? { workspaceId: workspace } : {}) })
  ).json()
  return { id: canvas.id, pageId: canvas.pages[0].id }
}

/** the custom agents on a canvas's team, by handle */
const customIds = (team: AgentRole[]) => team.filter((a) => a.custom).map((a) => a.id)
const teamIds = (team: AgentRole[]) => team.map((a) => a.id)

async function mention(client: Client, canvas: { id: string; pageId: string }, text: string) {
  const res = await client.post(`/api/canvases/${canvas.id}/comments`, { pageId: canvas.pageId, x: 0, y: 0, text })
  expect(res.status).toBe(200)
  return res.json()
}

describe('personal custom agents', () => {
  it('creates one and lists it to its owner only', async () => {
    const res = await owner.post('/api/agents', SEO)
    expect(res.status).toBe(200)
    const agent: CustomAgent = await res.json()
    expect(agent).toMatchObject({ id: 'seo', name: 'SEO Reviewer', color: '#DB2777', reviewer: true, custom: true })
    expect((await (await owner.get('/api/agents')).json()).map((a: CustomAgent) => a.id)).toEqual(['seo'])
    expect(await (await stranger.get('/api/agents')).json()).toEqual([])
  })

  it('refuses a handle or name already taken, and the built-in team’s', async () => {
    const taken = await owner.post('/api/agents', { ...SEO, name: 'Other' })
    expect(taken.status).toBe(400)
    expect((await taken.json()).error).toMatch(/@seo is already taken/)
    const sameName = await owner.post('/api/agents', { ...SEO, handle: 'seo2', name: 'seo reviewer' })
    expect((await sameName.json()).error).toMatch(/already on the team/)
    const builtIn = await owner.post('/api/agents', { ...SEO, handle: 'copy', name: 'Copy Two' })
    expect((await builtIn.json()).error).toMatch(/built-in agent/)
    const builtInName = await owner.post('/api/agents', { ...SEO, handle: 'polisher', name: 'Visual Polish' })
    expect((await builtInName.json()).error).toMatch(/already on the team/)
  })

  it('lets the same handle exist in another scope', async () => {
    expect((await stranger.post('/api/agents', SEO)).status).toBe(200)
    expect((await stranger.delete('/api/agents/seo')).status).toBe(200)
  })

  it('is on the team of the owner’s personal canvases, not on other canvases', async () => {
    const mine = await canvasIn(owner)
    const canvas = await (await owner.get(`/api/canvases/${mine.id}`)).json()
    expect(customIds(canvas.team)).toEqual(['seo'])
    /* a canvas's viewers get the team, not its instructions */
    expect(canvas.team.every((a: AgentRole) => a.brief === '')).toBe(true)
    expect(teamIds(await (await owner.get(`/api/canvases/${mine.id}/agents`)).json())).toEqual([
      'doop',
      'ux',
      'copy',
      'brand',
      'a11y',
      'polish',
      'seo',
    ])

    const comment = await mention(owner, mine, '@seo check the headings')
    expect(comment).toMatchObject({ forAgent: true, targetAgent: 'SEO Reviewer' })

    const theirs = await canvasIn(stranger)
    const plain = await mention(stranger, theirs, '@seo check the headings')
    expect(plain.forAgent).toBeUndefined()
  })

  it('edits everything but the name and handle', async () => {
    const res = await owner.patch('/api/agents/seo', { blurb: 'Search copy', reviewer: false, name: 'Renamed' })
    expect(res.status).toBe(200)
    const edited: CustomAgent = await res.json()
    expect(edited).toMatchObject({ id: 'seo', name: 'SEO Reviewer', blurb: 'Search copy' })
    expect(edited.reviewer).toBeUndefined()
    expect((await owner.patch('/api/agents/seo', { brief: 'short' })).status).toBe(400)
    expect((await stranger.patch('/api/agents/seo', { blurb: 'Mine now' })).status).toBe(404)
  })
})

describe('workspace custom agents', () => {
  it('is shared by the members and refused to outsiders', async () => {
    const res = await mate.post(`/api/agents?workspace=${workspaceId}`, {
      ...SEO,
      handle: 'voice',
      name: 'Brand Voice',
    })
    expect(res.status).toBe(200)
    expect(
      (await (await owner.get(`/api/agents?workspace=${workspaceId}`)).json()).map((a: CustomAgent) => a.id),
    ).toEqual(['voice'])
    expect((await stranger.get(`/api/agents?workspace=${workspaceId}`)).status).toBe(403)
    expect((await stranger.post(`/api/agents?workspace=${workspaceId}`, SEO)).status).toBe(403)
  })

  it('is the team of the workspace’s canvases, in place of anyone’s personal agents', async () => {
    const shared = await canvasIn(owner, workspaceId)
    const canvas = await (await owner.get(`/api/canvases/${shared.id}`)).json()
    expect(customIds(canvas.team)).toEqual(['voice'])
    expect(await mention(mate, shared, 'hey @voice, tone check')).toMatchObject({ targetAgent: 'Brand Voice' })
    expect((await mention(owner, shared, '@seo headings')).forAgent).toBeUndefined()
  })

  it('tells an open room when the team changes', async () => {
    const shared = await canvasIn(owner, workspaceId)
    const heard = new Promise<AgentRole[]>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
      const timer = setTimeout(() => reject(new Error('no team message')), 8000)
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'join', canvasId: shared.id, clientId: 'agents', name: 'Owner', kind: 'user' })),
      )
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d))
        if (msg.type === 'init')
          void mate.post(`/api/agents?workspace=${workspaceId}`, { ...SEO, handle: 'legal', name: 'Legal' })
        if (msg.type === 'team') {
          clearTimeout(timer)
          ws.close()
          resolve(msg.team)
        }
      })
    })
    expect(customIds(await heard)).toEqual(['voice', 'legal'])
  })

  it('gives an open room its new team when the canvas moves to its owner’s personal space', async () => {
    const shared = await canvasIn(owner, workspaceId)
    const heard = new Promise<AgentRole[]>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
      const timer = setTimeout(() => reject(new Error('no team message')), 8000)
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'join', canvasId: shared.id, clientId: 'move', name: 'Owner', kind: 'user' })),
      )
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d))
        if (msg.type === 'init') void owner.put(`/api/canvases/${shared.id}/workspace`, { workspaceId: null })
        if (msg.type === 'team') {
          clearTimeout(timer)
          ws.close()
          resolve(msg.team)
        }
      })
    })
    /* the owner's own agents, not the workspace's */
    expect(customIds(await heard)).toEqual(['seo'])
  })

  it('removes an agent, and it stops answering mentions', async () => {
    expect((await mate.delete(`/api/agents/legal?workspace=${workspaceId}`)).status).toBe(200)
    const shared = await canvasIn(owner, workspaceId)
    expect((await mention(owner, shared, '@legal look')).forAgent).toBeUndefined()
    expect((await mate.delete(`/api/agents/legal?workspace=${workspaceId}`)).status).toBe(404)
  })
})

describe('built-in agents', () => {
  const builtIn = async (client: Client, id: string, workspace = workspaceId) =>
    ((await (await client.get(`/api/agents/builtin?workspace=${workspace}`)).json()) as BuiltInAgent[]).find(
      (a) => a.id === id,
    )!

  it('switches one off for the team: it leaves the canvas’s team and stops answering mentions', async () => {
    const res = await mate.patch(`/api/agents/builtin/copy?workspace=${workspaceId}`, { disabled: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'copy', enabled: false, edited: false })

    const shared = await canvasIn(owner, workspaceId)
    const canvas = await (await owner.get(`/api/canvases/${shared.id}`)).json()
    expect(teamIds(canvas.team)).not.toContain('copy')
    expect((await mention(owner, shared, '@copy tighten this')).forAgent).toBeUndefined()

    /* only this team: the owner's personal canvases still have the Copywriter */
    const mine = await canvasIn(owner)
    expect((await mention(owner, mine, '@copy tighten this')).targetAgent).toBe('Copywriter')
  })

  it('keeps Doop on, since work addressed to no one goes to it', async () => {
    const res = await owner.patch(`/api/agents/builtin/doop?workspace=${workspaceId}`, { disabled: true })
    expect(res.status).toBe(400)
    expect((await owner.patch(`/api/agents/builtin/nobody?workspace=${workspaceId}`, { disabled: true })).status).toBe(
      400,
    )
  })

  it('edits one for the team, and the canvas’s team shows the change without the instructions', async () => {
    const brief = 'You are the UX lead for a bank. Every flow must show fees before the confirm step.'
    const res = await owner.patch(`/api/agents/builtin/ux?workspace=${workspaceId}`, {
      blurb: 'Flows, fees and confirmations',
      brief,
      color: '#475569',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'ux', name: 'UX Lead', brief, edited: true, enabled: true })

    const shared = await canvasIn(owner, workspaceId)
    const ux = (await (await owner.get(`/api/canvases/${shared.id}`)).json()).team.find((a: AgentRole) => a.id === 'ux')
    expect(ux).toMatchObject({ blurb: 'Flows, fees and confirmations', color: '#475569', brief: '' })
    expect(ux.briefByTeam).toBeUndefined()
  })

  it('resets the edits and leaves the on/off switch alone', async () => {
    expect((await owner.delete(`/api/agents/builtin/ux?workspace=${workspaceId}`)).status).toBe(200)
    expect(await builtIn(owner, 'ux')).toMatchObject({ edited: false, blurb: 'Flow, hierarchy, states, affordances' })

    await owner.patch(`/api/agents/builtin/copy?workspace=${workspaceId}`, { blurb: 'Words' })
    expect((await owner.delete(`/api/agents/builtin/copy?workspace=${workspaceId}`)).status).toBe(200)
    expect(await builtIn(owner, 'copy')).toMatchObject({ enabled: false, edited: false })
  })

  it('stores an edit back to the shipped value as no edit', async () => {
    await owner.patch(`/api/agents/builtin/a11y?workspace=${workspaceId}`, { reviewer: false })
    expect(await builtIn(owner, 'a11y')).toMatchObject({ edited: true, reviewer: false })
    await owner.patch(`/api/agents/builtin/a11y?workspace=${workspaceId}`, { reviewer: true })
    expect(await builtIn(owner, 'a11y')).toMatchObject({ edited: false, reviewer: true })
  })

  it('is refused to outsiders', async () => {
    expect((await stranger.get(`/api/agents/builtin?workspace=${workspaceId}`)).status).toBe(403)
    expect((await stranger.patch(`/api/agents/builtin/ux?workspace=${workspaceId}`, { disabled: true })).status).toBe(
      403,
    )
  })
})
