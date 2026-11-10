import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { z } from 'zod'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let foreign: Client
let ownerMcp: McpClient
let foreignMcp: McpClient
let workspaceId: string
let foreignWorkspaceId: string
let canvasId: string

const identitySchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  workspace_id: z.string().nullable(),
})
const previewSchema = z.object({
  canvas: z.object({ id: z.string(), name: z.string(), url: z.string() }),
  workspace_id: z.string().nullable(),
  frames: z.array(z.unknown()),
})

async function connect(actor: Client): Promise<McpClient> {
  const response = await actor.post('/api/agent-keys', { name: 'Canvas contract' })
  expect(response.status).toBe(200)
  const { secret } = await response.json()
  const client = new McpClient({ name: 'canvas-identity-test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  return client
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('identity-owner@test.dev', 'Owner')
  foreign = await new Client(server).signUp('identity-foreign@test.dev', 'Foreign')
  workspaceId = (await (await owner.post('/api/workspaces', { name: 'Identity workspace' })).json()).id
  foreignWorkspaceId = (await (await foreign.post('/api/workspaces', { name: 'Foreign workspace' })).json()).id
  ownerMcp = await connect(owner)
  foreignMcp = await connect(foreign)
  const created = await ownerMcp.callTool({
    name: 'create_canvas',
    arguments: { name: 'Known canvas', workspace_id: workspaceId },
  })
  canvasId = identitySchema.parse(created.structuredContent).id
}, 70_000)

afterAll(async () => {
  try {
    await Promise.all([ownerMcp?.close(), foreignMcp?.close()])
  } finally {
    server?.stop()
  }
})

it('declares the actual create/read structured identity and workspace schemas before a call', async () => {
  const { tools } = await ownerMcp.listTools()
  const create = tools.find((tool) => tool.name === 'create_canvas')!
  const read = tools.find((tool) => tool.name === 'get_canvas')!
  expect(new Set(create.outputSchema!.required)).toEqual(new Set(['id', 'name', 'url', 'workspace_id']))
  expect(new Set(read.outputSchema!.required)).toEqual(new Set(['canvas', 'workspace_id', 'frames']))
  expect(create.outputSchema!.properties).toHaveProperty('workspace_id')
  expect(read.outputSchema!.properties).toHaveProperty('workspace_id')
})

it('returns identity/workspace from the actual stored canvas through normal authenticated MCP', async () => {
  const created = await ownerMcp.callTool({
    name: 'create_canvas',
    arguments: { name: 'Structured creation', workspace_id: workspaceId },
  })
  expect(created.isError).not.toBe(true)
  const identity = identitySchema.parse(created.structuredContent)
  const actual = await (await owner.get(`/api/canvases/${identity.id}`)).json()
  expect(identity).toEqual({
    id: actual.id,
    name: actual.name,
    url: `/c/${actual.id}`,
    workspace_id: actual.workspaceId,
  })
  const read = await ownerMcp.callTool({ name: 'get_canvas', arguments: { canvas_id: identity.id } })
  expect(read.isError).not.toBe(true)
  expect(previewSchema.parse(read.structuredContent).workspace_id).toBe(workspaceId)
  expect(previewSchema.parse(read.structuredContent).canvas).toEqual({
    id: actual.id,
    name: actual.name,
    url: `${server.base}/c/${actual.id}`,
  })
  expect(previewSchema.parse(read.structuredContent).frames).toEqual([])
})

it('explicitly represents an ordinary personal canvas with a null workspace', async () => {
  const created = await ownerMcp.callTool({ name: 'create_canvas', arguments: { name: 'Personal contract' } })
  expect(identitySchema.parse(created.structuredContent).workspace_id).toBeNull()
  const read = await ownerMcp.callTool({
    name: 'get_canvas',
    arguments: { canvas_id: identitySchema.parse(created.structuredContent).id },
  })
  expect(previewSchema.parse(read.structuredContent).workspace_id).toBeNull()
})

it('does not fabricate structured identity for foreign canvas/workspace refusals or mutate on refusal', async () => {
  const before = await (await owner.get('/api/canvases')).json()
  const foreignRead = await foreignMcp.callTool({ name: 'get_canvas', arguments: { canvas_id: canvasId } })
  expect(foreignRead.isError).toBe(true)
  expect(foreignRead.structuredContent).toBeUndefined()
  const foreignCreate = await ownerMcp.callTool({
    name: 'create_canvas',
    arguments: { name: 'Refused', workspace_id: foreignWorkspaceId },
  })
  expect(foreignCreate.isError).toBe(true)
  expect(foreignCreate.structuredContent).toBeUndefined()
  expect(await (await owner.get('/api/canvases')).json()).toEqual(before)
})
