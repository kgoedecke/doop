import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Canvas } from '../shared/types'
import type { StorybookSourceView } from '../shared/storybookSource'
import { Client, startServer, type Server } from './harness.ts'

/*
 * The Storybook import on a real server and database: what the CLI does (an agent key, plain
 * JSON-RPC to /mcp with captures, no MCP client library), the source kept in storybook_sources
 * across a restart of the reads, and the import section's routes.
 */

let server: Server
let owner: Client
let outsider: Client

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('storybook@test.dev', 'Story Owner')
  outsider = await new Client(server).signUp('storybook-outsider@test.dev', 'Outsider')
}, 60_000)

afterAll(() => server?.stop())

const capture = {
  title: 'UI/Badge',
  name: 'Badge',
  storyId: 'ui-badge--default',
  codePath: 'src/ui/badge.tsx',
  props: [{ name: 'tone', arg: 'tone', kind: 'enum', options: ['neutral', 'success'], default: 'neutral' }],
  texts: [{ name: 'label', arg: 'label', value: 'New' }],
  base: {
    html: '<span class="badge bg-neutral">New</span>',
    rules: [
      '.badge { padding: 2px 8px; border-radius: var(--radius); }',
      '.bg-neutral { background: var(--muted); }',
      '.bg-success { background: var(--success); }',
    ],
    vars: { '--radius': '6px', '--muted': '#f4f4f5', '--success': '#16a34a' },
    fontFaces: [],
    text: {},
    width: 40,
    height: 20,
    warnings: [],
  },
  variants: [
    {
      prop: 'tone',
      value: 'success',
      capture: {
        html: '<span class="badge bg-success">New</span>',
        rules: [
          '.badge { padding: 2px 8px; border-radius: var(--radius); }',
          '.bg-success { background: var(--success); }',
        ],
        vars: {},
        fontFaces: [],
        text: {},
        width: 40,
        height: 20,
        warnings: [],
      },
    },
  ],
  warnings: [],
}

/** One JSON-RPC call to /mcp, as a script with an agent key makes it. */
async function rpc(key: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: { agent_name: 'doop-storybook', ...args } },
    }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
  return { text: body.result.content[0]!.text, isError: !!body.result.isError }
}

it('imports what a script sends over /mcp with an agent key, and keeps the source for sync', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Kit' })).json()
  const { secret } = (await (await owner.post('/api/agent-keys', { name: 'CI' })).json()) as { secret: string }

  const imported = await rpc(secret, 'import_storybook', {
    canvas_id: canvas.id,
    url: 'http://localhost:6006/',
    captures: [capture],
  })
  expect(imported.isError).toBe(false)
  const job = JSON.parse(imported.text)
  expect(job.state).toBe('done')
  expect(job.result.components[0]).toMatchObject({ title: 'UI/Badge', outcome: 'created' })
  expect(job.result.tokens.created).toEqual(expect.arrayContaining(['--muted', '--success']))

  const listed = await rpc(secret, 'list_components', { canvas_id: canvas.id })
  expect(listed.text).toContain('Badge(tone: neutral|success = neutral, label: text)')

  /* the source, from the database, as the import section reads it */
  const { sources } = (await (await owner.get(`/api/canvases/${canvas.id}/storybook/sources`)).json()) as {
    sources: StorybookSourceView[]
  }
  expect(sources).toHaveLength(1)
  expect(sources[0]).toMatchObject({ url: 'http://localhost:6006/', components: [{ title: 'UI/Badge' }] })
  expect(sources[0]!.components[0]!.componentId).toBeTruthy()
  expect(sources[0]!.lastResult?.components[0]?.outcome).toBe('created')

  /* the same captures again: nothing to send */
  const again = JSON.parse(
    (await rpc(secret, 'import_storybook', { canvas_id: canvas.id, url: 'http://localhost:6006', captures: [capture] }))
      .text,
  )
  expect(again.result.components[0].outcome).toBe('unchanged')
})

it('guards the import section’s routes', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Guarded' })).json()
  expect((await outsider.get(`/api/canvases/${canvas.id}/storybook/sources`)).status).toBe(403)
  const empty = await owner.post(`/api/canvases/${canvas.id}/storybook/import`, {
    url: 'https://sb.example.com',
    components: [],
  })
  expect(empty.status).toBe(400)
  /* a private address is never fetched by the server */
  const local = await owner.post(`/api/canvases/${canvas.id}/storybook/discover`, { url: 'http://127.0.0.1:6006/' })
  expect(local.status).toBe(400)
  expect(((await local.json()) as { error: string }).error).toContain('CLI')
  expect((await owner.get(`/api/canvases/${canvas.id}/storybook/jobs/nope`)).status).toBe(404)
})
