import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { TOOL_SHAPES } from '../server/agentToolShapes.ts'
import { COMPONENT_TOOL_NAMES } from '../server/componentTools.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { RESIDENT_TOOL_NAMES, RESIDENT_TOOLS } from '../server/resident.ts'

vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

/* The resident agents should be able to do whatever an agent connected over
   MCP can do on a canvas. Every MCP tool is either in the resident set under
   the same name, or listed here with the reason it is not: adding an MCP
   tool without deciding forces this test to fail. */

/** The resident agent does the same thing with differently shaped tools. */
const EQUIVALENT: Record<string, string[]> = {
  get_frame: ['get_frame_html', 'inspect_frame'],
  get_frame_screenshot: ['screenshot_frame'],
  get_component_preview: ['screenshot_component'],
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
  /* repo import cards queued for a person's own MCP agent; the resident runs
     its repo cards itself (runRepoCards), reading the repo the same way */
  'take_repo_cards',
  'read_repo_files',
  'finish_repo_card',
]

/** Real gaps: MCP agents can do these and resident agents cannot yet. */
const MISSING = [
  'get_canvas',
  'delete_frame',
  'list_frame_versions',
  'restore_frame_version',
  'set_page_background',
  'export_frame',
  'upload_asset',
  'list_linear_issues', // integration tools, registered by their connections
  'get_linear_issue',
  /* a Storybook import is a job a person or a connected agent starts (and the CLI, with an agent
     key); the resident composes from the components it brought */
  'list_storybook_components',
  'import_storybook',
  'sync_storybook',
]

/* A tool both surfaces have takes the same parameters on both, compared by their top-level
   names: the MCP tool's input schema against the resident's input_schema. */

/** What an MCP agent passes on every call and a resident never needs: it names its canvas and
 *  itself (a resident run is scoped to its canvas and named by its role). */
const MCP_CALL_CONTEXT = ['canvas_id', 'agent_name']

/** Parameters of a shared tool that one surface takes on purpose, and why. */
const PARAM_DIFFERENCES: Record<string, { mcp?: string[]; resident?: string[] }> = {
  /* an MCP agent may hold the font file on its own machine, to upload or send as base64; the
     resident runs on the server with no files of its own, so it uploads from a public URL only */
  upload_font: { mcp: ['local_file', 'data'] },
  /* the resident answers a comment it cannot act on yet and hands the request back to the
     person (a run state of its own); an MCP agent asks the person in its own chat */
  reply_to_comment: { resident: ['awaiting_answer'] },
  /* the resident keeps reference snapshots apart from its deliverables and reuses them across
     pipeline stages; an MCP import is always a source frame to compare against */
  import_webpage: { resident: ['as_reference'] },
}

/** Parameters optional over MCP that a resident run must pass. */
const REQUIRED_BY_RESIDENT: Record<string, string[]> = {
  create_frame: ['width', 'height'], // a run sizes every frame it makes; an MCP call falls back to 640x480
  upload_font: ['source_url'], // its only source, with the file and base64 ones left out (above)
}

async function mcpTools() {
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'parity-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  const { tools } = await client.listTools()
  await client.close()
  await server.close()
  return tools
}

async function mcpToolNames(): Promise<string[]> {
  return (await mcpTools()).map((tool) => tool.name)
}

const paramNames = (schema: { properties?: unknown }) => Object.keys(schema.properties ?? {})

/** Each tool on both surfaces, with the parameters only one of them takes. */
async function paramDrift() {
  const resident = new Map(RESIDENT_TOOLS.map((tool) => [tool.name, paramNames(tool.input_schema)]))
  return (await mcpTools()).flatMap((tool) => {
    const theirs = resident.get(tool.name)
    if (!theirs) return []
    const ours = paramNames(tool.inputSchema).filter((name) => !MCP_CALL_CONTEXT.includes(name))
    return [
      {
        tool: tool.name,
        mcp: ours.filter((name) => !theirs.includes(name)),
        resident: theirs.filter((name) => !ours.includes(name)),
      },
    ]
  })
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

it('gives a tool on both surfaces the same parameters, or records why not', async () => {
  const unaccounted = (await paramDrift()).flatMap(({ tool, mcp, resident }) => [
    ...mcp.filter((name) => !PARAM_DIFFERENCES[tool]?.mcp?.includes(name)).map((name) => `${tool}.${name} (MCP only)`),
    ...resident
      .filter((name) => !PARAM_DIFFERENCES[tool]?.resident?.includes(name))
      .map((name) => `${tool}.${name} (resident only)`),
  ])
  expect(unaccounted).toEqual([])
})

it('keeps the parameter exceptions honest', async () => {
  const drift = new Map((await paramDrift()).map((entry) => [entry.tool, entry]))
  for (const [tool, allowed] of Object.entries(PARAM_DIFFERENCES)) {
    const found = drift.get(tool)
    expect(found, `${tool} is no longer on both surfaces`).toBeDefined()
    for (const name of allowed.mcp ?? []) expect(found?.mcp, `${tool}.${name} is no longer MCP only`).toContain(name)
    for (const name of allowed.resident ?? [])
      expect(found?.resident, `${tool}.${name} is no longer resident only`).toContain(name)
  }
  for (const tool of RESIDENT_TOOLS)
    for (const name of MCP_CALL_CONTEXT)
      expect(paramNames(tool.input_schema), `${tool.name} takes ${name}`).not.toContain(name)
})

/** A schema with its wording left out: types, enums, bounds, nullability and nested fields. */
function structureOf(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(structureOf)
  if (!schema || typeof schema !== 'object') return schema
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== 'description')
      .map(([key, value]) => [
        key,
        key === 'properties'
          ? Object.fromEntries(Object.entries(value as object).map(([name, field]) => [name, structureOf(field)]))
          : structureOf(value),
      ]),
  )
}

type JsonSchema = { properties?: Record<string, unknown>; required?: string[] }

it('defines each shared tool once, for both surfaces', async () => {
  const resident = new Set(RESIDENT_TOOL_NAMES)
  const shared = (await mcpToolNames()).filter((name) => resident.has(name))
  const defined = new Set([...Object.keys(TOOL_SHAPES), ...COMPONENT_TOOL_NAMES])
  expect(shared.filter((name) => !defined.has(name))).toEqual([])
  expect(Object.keys(TOOL_SHAPES).filter((name) => !shared.includes(name))).toEqual([])
})

it('registers each shared shape over MCP as it is, around its call context', async () => {
  const shapes: Record<string, z.ZodRawShape> = TOOL_SHAPES
  for (const tool of await mcpTools()) {
    const shape = shapes[tool.name]
    if (!shape) continue
    const { properties = {} } = tool.inputSchema as JsonSchema
    const registered = Object.fromEntries(
      Object.entries(properties).filter(([name]) => !MCP_CALL_CONTEXT.includes(name)),
    )
    const defined = zodToJsonSchema(z.object(shape), { strictUnions: true, pipeStrategy: 'input' }) as JsonSchema
    expect(registered, tool.name).toEqual(defined.properties ?? {})
  }
})

it('gives a parameter on both surfaces the same type, bounds and requiredness', async () => {
  const resident = new Map(RESIDENT_TOOLS.map((tool) => [tool.name, tool.input_schema as JsonSchema]))
  const drift: string[] = []
  for (const tool of await mcpTools()) {
    const theirs = resident.get(tool.name)
    if (!theirs) continue
    const ours = tool.inputSchema as JsonSchema
    const mustPass = new Set([...(ours.required ?? []), ...(REQUIRED_BY_RESIDENT[tool.name] ?? [])])
    for (const name of paramNames(theirs).filter((param) => paramNames(ours).includes(param))) {
      const [mcp, run] = [ours.properties?.[name], theirs.properties?.[name]].map((field) =>
        JSON.stringify(structureOf(field)),
      )
      if (mcp !== run) drift.push(`${tool.name}.${name}: MCP ${mcp}, resident ${run}`)
      if (mustPass.has(name) !== (theirs.required ?? []).includes(name))
        drift.push(`${tool.name}.${name}: required differs`)
    }
  }
  expect(drift).toEqual([])
})

it('keeps the required-parameter exceptions honest', async () => {
  const mcp = new Map((await mcpTools()).map((tool) => [tool.name, tool.inputSchema as JsonSchema]))
  const resident = new Map(RESIDENT_TOOLS.map((tool) => [tool.name, tool.input_schema as JsonSchema]))
  for (const [tool, names] of Object.entries(REQUIRED_BY_RESIDENT))
    for (const name of names) {
      expect(mcp.get(tool)?.required ?? [], `${tool}.${name} is required over MCP now`).not.toContain(name)
      expect(resident.get(tool)?.required, `${tool}.${name} is no longer required of a run`).toContain(name)
    }
})
