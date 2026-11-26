import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* Both surfaces write the canvas; these tests only compare what each answers, so
   persistence is stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { execTool, newRunState } = await import('../server/resident.ts')
const { canvasPages } = await import('../shared/pages.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const OWNER = 'test-owner-id'
const html = '<!doctype html><html><body>hi</body></html>'
const actor = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })

let canvasId: string
let frameId: string
let client: Client
let close: () => Promise<void>

type Answer = { error: boolean; body: unknown }

/** The JSON an answer carries, or its text when it is not JSON (a refusal). */
function body(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function overMcp(name: string, args: Record<string, unknown>): Promise<Answer> {
  const result = await client.callTool({ name, arguments: { canvas_id: canvasId, agent_name: 'Claude', ...args } })
  const [first] = result.content as { type: string; text: string }[]
  /* every MCP refusal starts "Error: " (server/mcp.ts `err`), whatever the tool */
  return { error: result.isError === true, body: body(first!.text.replace(/^Error: /, '')) }
}

async function inRun(name: string, input: Record<string, unknown>): Promise<Answer> {
  const result = await execTool({ type: 'tool_use', id: 't1', name, input }, canvasId, actor(), newRunState())
  return { error: result.is_error === true, body: body(String(result.content)) }
}

/** Each surface's answer to the same call, made on the canvas as the other left it. */
async function both(name: string, input: Record<string, unknown>) {
  return { mcp: await overMcp(name, input), run: await inRun(name, input) }
}

const pages = () => canvasPages(store.getCanvas(canvasId)!).map(({ id, name }) => ({ id, name }))

beforeEach(async () => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('Shared', OWNER).id
  frameId = actions.createFrame(canvasId, { name: 'Home', width: 390, height: 844, html, x: 0, y: 0 }, actor())!.id
  const server = buildMcpServer('Test Owner', OWNER)
  client = new Client({ name: 'shared-handlers-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  close = async () => {
    await client.close()
    await server.close()
  }
})

afterEach(async () => {
  store.canvases.delete(canvasId)
  await close()
})

describe('an MCP agent and the Doop Agent get the same answer from a shared tool', () => {
  it('update_canvas', async () => {
    const { mcp, run } = await both('update_canvas', { name: 'Renamed' })
    expect(mcp).toEqual({ error: false, body: { ok: true, id: canvasId, name: 'Renamed' } })
    expect(run).toEqual(mcp)
  })

  it('create_canvas_page', async () => {
    const mcp = await overMcp('create_canvas_page', { name: 'Mobile' })
    const run = await inRun('create_canvas_page', { name: 'Tablet' })
    const [first, second] = pages().slice(1)
    expect(mcp).toEqual({ error: false, body: { ok: true, page: first, pages: pages().slice(0, 2) } })
    expect(run).toEqual({ error: false, body: { ok: true, page: second, pages: pages() } })
  })

  it('set_canvas_pages', async () => {
    const renamed = pages().map((page) => ({ ...page, name: 'Screens' }))
    const { mcp, run } = await both('set_canvas_pages', { expectedPages: renamed, pages: renamed })
    expect(mcp.error).toBe(true)
    expect(run).toEqual(mcp)
    const saved = await overMcp('set_canvas_pages', { expectedPages: pages(), pages: renamed })
    expect(saved).toEqual({ error: false, body: { ok: true, pages: renamed } })
    /* the run saves the same list over the one the MCP call left: the same answer */
    expect(await inRun('set_canvas_pages', { expectedPages: pages(), pages: renamed })).toEqual(saved)
  })

  it('get_prototype and set_prototype_start', async () => {
    const read = await both('get_prototype', {})
    expect(read.run).toEqual(read.mcp)
    const set = await both('set_prototype_start', { frame_id: frameId })
    expect(set.mcp.body).toMatchObject({ ok: true, prototype_url: expect.stringContaining(`/c/${canvasId}/proto`) })
    expect(set.run).toEqual(set.mcp)
    const refused = await both('set_prototype_start', { frame_id: 'nope' })
    expect(refused.mcp.error).toBe(true)
    expect(refused.run).toEqual(refused.mcp)
  })
})
