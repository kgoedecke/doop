import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AdminAgentFeedbackPage } from '../src/lib/api'
import { Client, startServer, type Server } from './harness.ts'

/* /mcp is stateless: initialize and every tool call are separate requests,
   each served by a fresh MCP server. The client's name has to survive that. */

let server: Server
let admin: Client
let member: Client
let agent: McpClient

beforeAll(async () => {
  server = await startServer({ ADMIN_EMAILS: 'feedback-admin@test.dev' })
  admin = await new Client(server).signUp('feedback-admin@test.dev', 'Feedback Admin')
  member = await new Client(server).signUp('feedback-member@test.dev', 'Feedback Member')
  const { secret } = await (await member.post('/api/agent-keys', { name: 'Feedback agent' })).json()
  agent = new McpClient({ name: 'http-feedback-client', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
}, 60_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
})

it('records the client named at initialize on a later tool call, and lists it for admins only', async () => {
  const result = await agent.callTool({
    name: 'share_feedback',
    arguments: { category: 'improvement', message: 'get_canvas could include frame thumbnails', agent_name: 'Tester' },
  })
  expect(result.isError).toBeFalsy()

  const page: AdminAgentFeedbackPage = await (await admin.get('/api/admin/agent-feedback')).json()
  expect(page.reports[0]).toMatchObject({
    kind: 'feedback',
    client: 'http-feedback-client',
    agentName: 'Tester',
    user: { email: 'feedback-member@test.dev' },
  })
  expect((await member.get('/api/admin/agent-feedback')).status).toBe(404)
})
