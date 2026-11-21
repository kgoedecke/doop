import { afterAll, beforeAll, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentTask, Presence } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

/* Outside agents are told apart by account and MCP session, not by the name
   they send: /mcp keeps no sessions, but hands each initialize an
   Mcp-Session-Id that clients send back. shared/agentIdentity.ts */

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

/** One tools/call on its own, with no session header: a client that never initialized. */
async function bareCall(secret: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
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
  server = await startServer()
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

it('hands each initialize its own session id', async () => {
  const initialize = () =>
    fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${ownerKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
      }),
    })
  const [first, second] = await Promise.all([initialize(), initialize()])
  expect(first.status).toBe(200)
  const ids = [first.headers.get('mcp-session-id'), second.headers.get('mcp-session-id')]
  expect(ids[0]).toBeTruthy()
  expect(ids[1]).toBeTruthy()
  expect(ids[0]).not.toBe(ids[1])
})

it('keeps two accounts’ and two sessions’ agents named "Claude" apart', async () => {
  const anaFirst = await connect(ownerKey)
  const anaSecond = await connect(ownerKey)
  const ben = await connect(visitorKey)
  const status = (agent: McpClient, text: string) =>
    agent.callTool({ name: 'set_status', arguments: { canvas_id: canvasId, status: text, agent_name: 'Claude' } })

  for (const result of [
    await status(anaFirst, 'Drawing the hero'),
    await status(anaSecond, 'Writing the pricing page'),
    await status(ben, 'Building the footer'),
  ])
    expect(result.isError).toBeFalsy()
  /* a new status ends the agent's own previous task, never another's */
  expect((await status(anaFirst, 'Reviewing the hero')).isError).toBeFalsy()

  const { agents: faces, open } = await roomState()
  expect(faces).toHaveLength(3)
  expect(new Set(faces.map((p) => p.clientId)).size).toBe(3)
  expect(faces.map((p) => p.owner).sort()).toEqual(['Ana', 'Ana', 'Ben'])
  expect(open.map((t) => t.status).sort()).toEqual([
    'Building the footer',
    'Reviewing the hero',
    'Writing the pricing page',
  ])
  expect(new Set(open.map((t) => t.agentKey)).size).toBe(3)
})

it('knows a client that sends no session back by its account', async () => {
  await bareCall(visitorKey, 'set_status', { canvas_id: canvasId, status: 'Checking contrast', agent_name: 'Scout' })
  await bareCall(visitorKey, 'set_status', { canvas_id: canvasId, status: 'Checking spacing', agent_name: 'Scout' })
  const { agents: faces, open } = await roomState()
  expect(faces.filter((p) => p.name === 'Scout')).toHaveLength(1)
  expect(open.filter((t) => t.agentName === 'Scout').map((t) => t.status)).toEqual(['Checking spacing'])
})
