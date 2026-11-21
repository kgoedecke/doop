import { afterAll, beforeAll, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentTask, Presence } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

/* Outside agents are told apart by account and name, not by the name alone:
   two people's "Claude" on a shared canvas are two agents. Not by MCP session,
   which clients restart far more often than an agent starts work.
   shared/agentIdentity.ts */

let server: Server
let owner: Client
let visitor: Client
let canvasId: string
let ownerKey: string
let visitorKey: string
const agents: McpClient[] = []

async function connect(secret: string): Promise<McpClient> {
  const agent = new McpClient({ name: 'identity-client', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  agents.push(agent)
  return agent
}

/** What the room shows someone joining now: agent presences and open tasks. */
async function roomState(): Promise<{ agents: Presence[]; open: AgentTask[] }> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  const init = await new Promise<{ presences: Presence[]; tasks: AgentTask[] }>((resolve, reject) => {
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 't', kind: 'user' })),
    )
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; presences: Presence[]; tasks: AgentTask[] }
      if (msg.type === 'init') resolve(msg)
    })
    ws.on('error', reject)
  })
  ws.close()
  return {
    agents: init.presences.filter((p) => p.kind === 'agent'),
    open: init.tasks.filter((t) => !t.endedAt && !t.queuedBy),
  }
}

beforeAll(async () => {
  /* room for the feedback a person leaves (it counts against the resident allowance) */
  server = await startServer({ RESIDENT_TASK_LIMIT: '100' })
  owner = await new Client(server).signUp('identity-owner@test.dev', 'Ana')
  visitor = await new Client(server).signUp('identity-visitor@test.dev', 'Ben')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Shared' })).json()).id
  expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })).status).toBe(200)
  ownerKey = (await (await owner.post('/api/agent-keys', { name: 'ana-agent' })).json()).secret
  visitorKey = (await (await visitor.post('/api/agent-keys', { name: 'ben-agent' })).json()).secret
}, 70_000)

afterAll(async () => {
  for (const agent of agents) await agent.close()
  server?.stop()
})

const status = (agent: McpClient, text: string, name = 'Claude') =>
  agent.callTool({ name: 'set_status', arguments: { canvas_id: canvasId, status: text, agent_name: name } })

it('keeps two accounts’ agents named "Claude" apart', async () => {
  const ana = await connect(ownerKey)
  const ben = await connect(visitorKey)
  expect((await status(ana, 'Drawing the hero')).isError).toBeFalsy()
  expect((await status(ben, 'Building the footer')).isError).toBeFalsy()
  /* a new status ends the agent's own previous task, never the other's */
  expect((await status(ana, 'Reviewing the hero')).isError).toBeFalsy()

  const { agents: faces, open } = await roomState()
  const claudes = faces.filter((p) => p.name === 'Claude')
  expect(claudes.map((p) => p.owner).sort()).toEqual(['Ana', 'Ben'])
  expect(new Set(claudes.map((p) => p.clientId)).size).toBe(2)
  const claudeTasks = open.filter((t) => t.agentName === 'Claude')
  expect(claudeTasks.map((t) => t.status).sort()).toEqual(['Building the footer', 'Reviewing the hero'])
  expect(new Set(claudeTasks.map((t) => t.agentKey)).size).toBe(2)
})

it('knows one account’s connections going by one name as one agent', async () => {
  const first = await connect(ownerKey)
  const second = await connect(ownerKey)
  await status(first, 'Checking contrast', 'Scout')
  await status(second, 'Checking spacing', 'Scout')
  const { agents: faces, open } = await roomState()
  expect(faces.filter((p) => p.name === 'Scout')).toHaveLength(1)
  expect(open.filter((t) => t.agentName === 'Scout').map((t) => t.status)).toEqual(['Checking spacing'])
})

it('tells an agent the feedback it claims is another Claude’s work', async () => {
  const { open } = await roomState()
  const bens = open.find((t) => t.status === 'Building the footer')!
  expect((await owner.post(`/api/tasks/${bens.id}/feedback`, { text: 'Darker, please' })).status).toBe(200)
  /* Ben's Claude gets first pick; Ana's would wait out OWNER_FIRST_MS */
  const ben = await connect(visitorKey)
  const result = await ben.callTool({ name: 'get_feedback', arguments: { canvas_id: canvasId, agent_name: 'Claude' } })
  const body = JSON.parse((result.content as { text: string }[])[0]!.text) as { feedback: { about?: string }[] }
  expect(body.feedback.map((f) => f.about)).toEqual(['your work: “Building the footer”'])
})
