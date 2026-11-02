import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { LibrarySnapshot } from '../shared/designSystem.ts'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let agent: McpClient
let strangerAgent: McpClient

async function connect(client: Client, name: string): Promise<McpClient> {
  const { secret } = await (await client.post('/api/agent-keys', { name })).json()
  const mcp = new McpClient({ name, version: '1.0.0' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  return mcp
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('ws-library@test.dev', 'Team Lead')
  const stranger = await new Client(server).signUp('ws-library-stranger@test.dev', 'Stranger')
  agent = await connect(owner, 'Library agent')
  strangerAgent = await connect(stranger, 'Stranger agent')
}, 60_000)

afterAll(async () => {
  await agent?.close()
  await strangerAgent?.close()
  server?.stop()
})

async function call(client: McpClient, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as { type: string; text?: string }[]
  const body = content.find((item) => item.type === 'text')!.text!
  return { isError: Boolean(result.isError), body }
}

async function ok(name: string, args: Record<string, unknown>) {
  const { isError, body } = await call(agent, name, args)
  expect(isError, body).toBe(false)
  return JSON.parse(body)
}

it('sets up a workspace team library over MCP before the workspace holds a canvas', async () => {
  expect(await ok('list_workspaces', {})).toEqual([])
  const ws = await ok('create_workspace', { name: 'LEVE' })
  expect(ws).toEqual(expect.objectContaining({ name: 'LEVE', role: 'owner' }))
  expect(await ok('list_workspaces', {})).toEqual([
    expect.objectContaining({ id: ws.id, name: 'LEVE', canvasCount: 0 }),
  ])

  const styles = await ok('set_design_system', {
    workspace_id: ws.id,
    global_css: ':root { --color-primary: rgb(199, 32, 38); }',
    notes: 'Botões em caixa alta.',
    agent_name: 'Claude',
  })
  expect(styles).toEqual(expect.objectContaining({ ok: true, tokens: 1 }))

  const saved = await ok('save_component', {
    workspace_id: ws.id,
    slug: 'botao-primario',
    name: 'Botão primário',
    group: 'buttons',
    kind: 'Button',
    html: '<button class="uk-button uk-button-primary">CONFIRMAR</button>',
    css: '[data-doop-component="botao-primario"] { background: var(--color-primary); }',
    agent_name: 'Claude',
  })
  expect(saved).toEqual(expect.objectContaining({ ok: true, created: true, slug: 'botao-primario' }))

  const read = await ok('get_design_system', { workspace_id: ws.id, include_css: true })
  expect(read.notes).toBe('Botões em caixa alta.')
  expect(read.components).toEqual([expect.objectContaining({ slug: 'botao-primario', group: 'buttons' })])

  /* the same library the app's workspace Components pane reads */
  const snapshot: LibrarySnapshot = await (await owner.get(`/api/library?workspace=${ws.id}`)).json()
  expect(snapshot.components.map((c) => c.slug)).toEqual(['botao-primario'])
  expect(snapshot.styles.globalCss).toContain('--color-primary')
})

it('keeps a workspace library to its members and asks for exactly one target', async () => {
  const ws = await ok('create_workspace', { name: 'Private team' })

  for (const [name, args] of [
    ['get_design_system', { workspace_id: ws.id }],
    [
      'save_component',
      { workspace_id: ws.id, slug: 'x', name: 'X', group: 'buttons', html: '<b>x</b>', agent_name: 'S' },
    ],
    ['set_design_system', { workspace_id: ws.id, notes: 'mine now', agent_name: 'S' }],
  ] as const) {
    const answer = await call(strangerAgent, name, args)
    expect(answer.isError).toBe(true)
    expect(answer.body).toContain('no workspace with id')
  }
  expect(await call(strangerAgent, 'list_workspaces', {})).toEqual({ isError: false, body: '[]' })

  const neither = await call(agent, 'get_design_system', {})
  expect(neither.isError).toBe(true)
  expect(neither.body).toContain('pass canvas_id or workspace_id')
  const both = await call(agent, 'get_design_system', { workspace_id: ws.id, canvas_id: 'whatever' })
  expect(both.isError).toBe(true)
  expect(both.body).toContain('not both')
})

async function frameHtml(canvasId: string, frameId: string): Promise<string> {
  const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
  return (canvas.frames as { id: string; html: string }[]).find((f) => f.id === frameId)!.html
}

async function eventually(check: () => Promise<boolean>, ms = 15_000) {
  const until = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out waiting for the frame')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

it('restyles a frame that was playing back or streaming once it ends, renames included, and files what it replaced', async () => {
  const canvas = await (await owner.post('/api/canvases', { name: 'Busy frames' })).json()
  await ok('save_component', {
    canvas_id: canvas.id,
    slug: 'chip',
    name: 'Chip',
    group: 'data-display',
    html: '<span>chip</span>',
    css: '[data-doop-component="chip"] { color: red; }',
    agent_name: 'Claude',
  })
  const page = '<!doctype html><html><head></head><body><span data-doop-component="chip">Novo</span></body></html>'
  const { frame } = await ok('create_frame', { canvas_id: canvas.id, name: 'Chips', html: page, agent_name: 'Claude' })

  /* edited while the new frame plays back: it catches up when playback ends */
  await ok('save_component', {
    canvas_id: canvas.id,
    slug: 'chip',
    css: '[data-doop-component="chip"] { color: blue; }',
    agent_name: 'Librarian',
  })
  await eventually(async () => (await frameHtml(canvas.id, frame.id)).includes('color: blue'))
  await eventually(async () => {
    const versions = await (await owner.get(`/api/frames/${frame.id}/versions`)).json()
    return Array.isArray(versions) && versions.length > 0
  })

  /* renamed while an agent streams the frame: the stream ends on the new slug */
  await ok('append_frame_html', {
    frame_id: frame.id,
    html_chunk: '<!doctype html><html><head></head><body><span data-doop-component="chip">Ao vivo</span>',
    start: true,
    agent_name: 'Claude',
  })
  await ok('save_component', { canvas_id: canvas.id, slug: 'chip', new_slug: 'tag', agent_name: 'Librarian' })
  expect(await frameHtml(canvas.id, frame.id)).toContain('data-doop-component="chip"')
  await ok('append_frame_html', { frame_id: frame.id, html_chunk: '</body></html>', done: true, agent_name: 'Claude' })
  const finished = await frameHtml(canvas.id, frame.id)
  expect(finished).toContain('data-doop-component="tag"')
  expect(finished).not.toContain('data-doop-component="chip"')
  expect(finished).toContain('[data-doop-component="tag"] { color: blue; }')
})
