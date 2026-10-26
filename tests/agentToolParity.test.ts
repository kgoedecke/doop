import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { RESIDENT_TOOL_NAMES } from '../server/resident.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

/* The resident agents should be able to do whatever an agent connected over
   MCP can do on a canvas. Every MCP tool is either in the resident set under
   the same name, or listed here with the reason it is not: adding an MCP
   tool without deciding forces this test to fail. */

/** The resident agent does the same thing with differently shaped tools. */
const EQUIVALENT: Record<string, string[]> = {
  get_frame: ['get_frame_html', 'inspect_frame'],
  get_frame_screenshot: ['screenshot_frame'],
  append_frame_html: ['begin_frame_rewrite', 'append_frame_rewrite', 'commit_frame_rewrite'],
}

/** Already in every resident run's prompt, or meaningless for an agent that lives on one canvas. */
const BY_CONTEXT = [
  'get_guide', // the system prompt carries the guide's sections
  'get_guidelines', // canvas guidelines ride as a system block
  'list_guidelines',
  'get_feedback', // feedback, cards and comments arrive in the kickoff
  'get_comments',
  'list_canvases', // a resident run is scoped to its canvas
  'create_canvas',
  'get_profile',
]

/** Real gaps: MCP agents can do these and resident agents cannot yet. */
const MISSING = [
  'get_canvas',
  'update_frame',
  'delete_frame',
  'list_frame_versions',
  'restore_frame_version',
  'set_canvas_pages',
  'reply_to_comment',
  'resolve_comment',
  'export_frame',
  'upload_asset',
  'list_linear_issues', // integration tools, registered by their connections
  'get_linear_issue',
]

async function mcpToolNames(): Promise<string[]> {
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'parity-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const { tools } = await client.listTools()
  await client.close()
  await server.close()
  return tools.map((tool) => tool.name)
}

it('gives resident agents every MCP tool, or records why not', async () => {
  const resident = new Set(RESIDENT_TOOL_NAMES)
  const unaccounted = (await mcpToolNames()).filter(
    (name) => !resident.has(name) && !EQUIVALENT[name] && !BY_CONTEXT.includes(name) && !MISSING.includes(name),
  )
  expect(unaccounted).toEqual([])
})

it('keeps the exception lists honest', async () => {
  const mcp = new Set(await mcpToolNames())
  const resident = new Set(RESIDENT_TOOL_NAMES)
  for (const name of [...Object.keys(EQUIVALENT), ...BY_CONTEXT, ...MISSING]) {
    expect(mcp.has(name), `${name} is no longer an MCP tool`).toBe(true)
    expect(resident.has(name), `${name} is now a resident tool; drop it from the exceptions`).toBe(false)
  }
  for (const names of Object.values(EQUIVALENT)) for (const name of names) expect(resident.has(name)).toBe(true)
})

it('gives resident agents the prototype tools', () => {
  expect(RESIDENT_TOOL_NAMES).toEqual(expect.arrayContaining(['get_prototype', 'set_prototype_start']))
})
