import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=',
  'base64',
)
let fixture: Awaited<ReturnType<typeof startPrivateServer>>
let owner: Client
let mcp: McpClient
beforeAll(async () => {
  fixture = await startPrivateServer()
  owner = await new Client(fixture.server).signUp('private-token@test.dev', 'Token owner')
  const key = await (await owner.post('/api/agent-keys', { name: 'Token guard' })).json()
  mcp = new McpClient({ name: 'private-token-check', version: '1' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${fixture.server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key.secret}` } },
    }),
  )
}, 60_000)
afterAll(async () => {
  try {
    await mcp?.close()
  } finally {
    await fixture?.close()
  }
})

async function context(used = false) {
  // One account can read/edit both parents: source access still cannot reparent a file.
  const source = await (await owner.post('/api/canvases', { name: 'Token source' })).json()
  const target = await (await owner.post('/api/canvases', { name: 'Token target' })).json()
  const upload = await owner.req(`/api/canvases/${source.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG),
  })
  expect(upload.status).toBe(200)
  const foreign = (await upload.json()).url as string
  if (used) {
    const frame = await owner.post(`/api/canvases/${target.id}/frames`, {
      name: 'Using token',
      html: '<div style="background:var(--poison)">Unchanged</div>',
    })
    expect(frame.status).toBe(200)
  }
  return { id: target.id as string, foreign }
}
async function state(id: string) {
  const canvas = await (await owner.get(`/api/canvases/${id}`)).json()
  return {
    tokens: canvas.tokens ?? [],
    themes: canvas.tokenThemes ?? [],
    html: canvas.frames.map((frame: { html: string }) => frame.html),
    updatedAt: canvas.updatedAt,
  }
}
async function tool(name: string, id: string, tokens: unknown[]) {
  const result = await mcp.callTool({ name, arguments: { canvas_id: id, tokens, agent_name: 'Token check' } })
  expect(result.isError).not.toBe(true)
  const content = result.content as { type: string; text?: string }[]
  return JSON.parse(content.find((block) => block.type === 'text')!.text!) as {
    results: { name: string; result: string; message?: string }[]
  }
}
async function unchanged(id: string, before: Awaited<ReturnType<typeof state>>) {
  expect(await state(id)).toEqual(before)
  await fixture.restart() // flush and rehydrate: a refused item must not have a durable after-effect
  expect(await state(id)).toEqual(before)
  const rows = (
    await fixture.db.query('SELECT name,value,themes FROM design_tokens WHERE canvas_id=$1 ORDER BY name', [id])
  ).rows
  expect(rows.map((row) => row.name)).toEqual(before.tokens.map((token: { name: string }) => token.name).sort())
}

it.each([
  ['HTTP', 'foreign', false],
  ['HTTP', 'foreign', true],
  ['HTTP', 'missing', false],
  ['HTTP', 'missing', true],
  ['MCP', 'foreign', false],
  ['MCP', 'foreign', true],
  ['MCP', 'missing', false],
  ['MCP', 'missing', true],
] as const)(
  '%s refuses an unused or used %s token before any state change (used: %s)',
  async (channel, kind, used) => {
    const ctx = await context(used)
    const before = await state(ctx.id)
    const url = kind === 'foreign' ? ctx.foreign : `${fixture.server.base}/a/missing_token_file.png`
    const input = {
      name: '--poison',
      type: 'color',
      value: `url(${url})`,
      themes: { shouldnotexist: '#fff' },
    }
    // Normal token batches report item errors in band, including all-refused batches.
    let body
    if (channel === 'HTTP') {
      const response = await owner.post(`/api/canvases/${ctx.id}/tokens`, input)
      expect(response.status).toBe(200)
      body = await response.json()
    } else body = await tool('create_tokens', ctx.id, [input])
    expect(body.results).toMatchObject([{ name: '--poison', result: 'error' }])
    expect(body.results[0].message).toMatch(/private file/)
    await unchanged(ctx.id, before)
  },
  20_000,
)

it.each([
  ['base', 'foreign'],
  ['theme', 'foreign'],
  ['base', 'missing'],
  ['theme', 'missing'],
] as const)(
  'HTTP rejects a %s/%s edit before rename, aliases, theme declarations or restyling',
  async (kind, reference) => {
    const ctx = await context(true)
    const created = await owner.post(`/api/canvases/${ctx.id}/tokens`, {
      tokens: [
        { name: '--poison', type: 'color', value: '#123' },
        { name: '--alias', type: 'color', value: 'var(--poison)' },
      ],
    })
    expect((await created.json()).results.every((item: { result: string }) => item.result === 'created')).toBe(true)
    const before = await state(ctx.id)
    const url = reference === 'foreign' ? ctx.foreign : `${fixture.server.base}/a/missing_edit_file.png`
    const response = await owner.req(`/api/canvases/${ctx.id}/tokens/--poison`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newName: '--renamed',
        description: 'Must not land',
        order: 99,
        ...(kind === 'base'
          ? { value: `url(${url})`, themes: { shouldnotexist: '#fff' } }
          : { themes: { shouldnotexist: `url(${url})` } }),
      }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/private file/)
    await unchanged(ctx.id, before)
  },
  20_000,
)

it('MCP preserves valid-item batch semantics, same-parent CSS and literal strings while rejecting foreign theme values', async () => {
  const ctx = await context()
  const localUpload = await owner.req(`/api/canvases/${ctx.id}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(PNG),
  })
  const local = (await localUpload.json()).url as string
  const result = await tool('create_tokens', ctx.id, [
    { name: '--allowed', type: 'color', value: `url(${local})`, themes: { localtheme: '#fff' } },
    { name: '--foreign-theme', type: 'color', value: '#fff', themes: { shouldnotexist: `url(${ctx.foreign})` } },
    { name: '--literal', type: 'color', value: '"/a/plain_text.png"' },
  ])
  expect(result.results.map((item) => item.result)).toEqual(['created', 'error', 'created'])
  const current = await state(ctx.id)
  expect(current.tokens.map((token: { name: string }) => token.name)).toEqual(['--allowed', '--literal'])
  expect(current.themes).toEqual(['localtheme'])
  expect(
    (
      await fixture.db.query('SELECT value FROM design_tokens WHERE canvas_id=$1 AND name=$2', [
        ctx.id,
        '--foreign-theme',
      ])
    ).rows,
  ).toEqual([])
  const frame = await owner.post(`/api/canvases/${ctx.id}/frames`, {
    html: '<div style="background:var(--allowed)">Owned</div>',
  })
  expect(frame.status).toBe(200)
  expect((await frame.json()).html).toContain(local)
  await fixture.restart()
  expect((await state(ctx.id)).tokens).toEqual(current.tokens)
}, 20_000)

it('MCP refuses a foreign value edit before its rename or theme can affect the document', async () => {
  const ctx = await context(true)
  expect(
    (await tool('create_tokens', ctx.id, [{ name: '--poison', type: 'color', value: '#123' }])).results[0]!.result,
  ).toBe('created')
  const before = await state(ctx.id)
  const result = await tool('set_tokens', ctx.id, [
    { name: '--poison', new_name: '--renamed', value: `url(${ctx.foreign})`, themes: { shouldnotexist: '#fff' } },
  ])
  expect(result.results).toMatchObject([{ name: '--poison', result: 'error' }])
  await unchanged(ctx.id, before)
}, 20_000)
