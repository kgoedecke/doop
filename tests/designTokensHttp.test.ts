import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import type { DesignToken } from '../shared/designTokens.ts'

/**
 * Design tokens against the REAL server (see ./harness.ts): the REST routes
 * and their roles, the exports, the styleguide, the MCP tools, and that a
 * frame saved from the browser gets its block from the server.
 */

let server: Server
let owner: Client
let visitor: Client
let canvasId: string
let ownerKey: string

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('tokens-owner@test.dev', 'Owner')
  visitor = await new Client(server).signUp('tokens-visitor@test.dev', 'Visitor')
  canvasId = (await (await owner.post('/api/canvases', { name: 'Tokens' })).json()).id
  ownerKey = (await (await owner.post('/api/agent-keys', { name: 'owner-agent' })).json()).secret
}, 70_000)

afterAll(() => server?.stop())

async function mcpCall(secret: string, name: string, args: Record<string, unknown>) {
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
  const body = (await res.json()) as { result: { isError?: boolean; content: { type: string; text?: string }[] } }
  return { isError: !!body.result.isError, text: body.result.content.map((block) => block.text ?? '').join('\n') }
}

describe('design tokens over REST', () => {
  it('creates tokens and lists them in order', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/tokens`, {
      tokens: [
        { name: '--color-ink', type: 'color', value: '#111', description: 'text' },
        { name: '--color-primary', type: 'color', value: 'var(--color-ink)' },
        { name: '--spacing-4', type: 'spacing', value: '16px' },
        { name: 'bad name!', type: 'color', value: '#000' },
      ],
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.map((r: { result: string }) => r.result)).toEqual(['created', 'created', 'created', 'error'])
    const list = (await (await owner.get(`/api/canvases/${canvasId}/tokens`)).json()) as DesignToken[]
    expect(list.map((t) => t.name)).toEqual(['--color-ink', '--color-primary', '--spacing-4'])
    expect(list[0]).toMatchObject({ type: 'color', value: '#111', description: 'text', updatedBy: 'Owner' })
    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.tokens.map((t: DesignToken) => t.name)).toEqual(list.map((t) => t.name))
  })

  it('exports CSS, Tailwind and markdown', async () => {
    const css = await (await owner.get(`/api/canvases/${canvasId}/tokens?format=css`)).text()
    expect(css).toBe(':root{--color-ink:#111;--color-primary:var(--color-ink);--spacing-4:16px}')
    const tailwind = await (await owner.get(`/api/canvases/${canvasId}/tokens?format=tailwind`)).text()
    expect(tailwind).toContain('@theme {')
    expect(tailwind).toContain('  --spacing-4: 16px;')
    const md = await (await owner.get(`/api/canvases/${canvasId}/tokens?format=md`)).text()
    expect(md).toContain('### Colour')
    const guide = await (await owner.get(`/api/canvases/${canvasId}/styleguide.md`)).text()
    expect(guide).toContain('# Tokens — styleguide')
    expect(guide).toContain('## Design tokens')
    expect(guide).toContain('| `--color-ink` | `#111` | text |')
  })

  it('writes the block into a frame the browser saves, and restyles it on a change', async () => {
    const frame = await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Hero',
        html: '<html><head></head><body style="padding:var(--spacing-4)"></body></html>',
      })
    ).json()
    const saved = async () => {
      const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
      return canvas.frames.find((f: { id: string }) => f.id === frame.id).html as string
    }
    expect(await saved()).toContain('<style data-doop-tokens>:root{--spacing-4:16px}</style>')
    const res = await owner.put(`/api/canvases/${canvasId}/tokens/--spacing-4`, { value: '32px' })
    expect(res.status).toBe(200)
    expect((await res.json()).result).toEqual({ name: '--spacing-4', result: 'updated' })
    expect(await saved()).toContain(':root{--spacing-4:32px}')
  })

  it('carries a value per theme, declared on first use and dropped with the theme', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/tokens`, {
      tokens: [{ name: '--color-bg', type: 'color', value: '#fff', themes: { dark: '#111' } }],
    })
    expect((await res.json()).results).toEqual([{ name: '--color-bg', result: 'created' }])
    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.tokenThemes).toEqual(['dark'])
    const frame = await (
      await owner.post(`/api/canvases/${canvasId}/frames`, {
        name: 'Dark',
        html: '<html data-doop-theme="dark"><head></head><body style="background:var(--color-bg)"></body></html>',
      })
    ).json()
    const html = () =>
      owner
        .get(`/api/canvases/${canvasId}`)
        .then((r) => r.json())
        .then((c) => c.frames.find((f: { id: string }) => f.id === frame.id).html as string)
    expect(await html()).toContain(
      ':root{--color-bg:#fff}\n:root[data-doop-theme="dark"],[data-doop-theme="dark"]{--color-bg:#111}',
    )
    const edit = await owner.put(`/api/canvases/${canvasId}/tokens/--color-bg`, {
      themes: { dark: '#000', dim: '#333' },
    })
    expect(edit.status).toBe(200)
    expect((await edit.json()).tokens.find((t: DesignToken) => t.name === '--color-bg').themes).toEqual({
      dark: '#000',
      dim: '#333',
    })
    const renamed = await owner.put(`/api/canvases/${canvasId}/token-themes`, {
      themes: ['night', 'dim'],
      renames: [{ from: 'dark', to: 'night' }],
    })
    expect(await renamed.json()).toMatchObject({ themes: ['night', 'dim'] })
    expect(await html()).toContain('[data-doop-theme="night"]{--color-bg:#000}')
    const themes = await owner.put(`/api/canvases/${canvasId}/token-themes`, {
      themes: ['dark'],
      renames: [{ from: 'night', to: 'dark' }],
    })
    expect(await themes.json()).toMatchObject({ themes: ['dark'] })
    expect(await html()).toContain('[data-doop-theme="dark"]{--color-bg:#000}')
    expect(await html()).not.toContain('dim')
    expect((await owner.put(`/api/canvases/${canvasId}/token-themes`, { themes: ['Dark Theme'] })).status).toBe(400)
    await owner.delete(`/api/canvases/${canvasId}/tokens/--color-bg`)
  })

  it('reports bad edits and refuses a delete that would strand an alias', async () => {
    const bad = await owner.put(`/api/canvases/${canvasId}/tokens/--spacing-4`, { value: '1px; }' })
    expect(bad.status).toBe(400)
    const strand = await owner.delete(`/api/canvases/${canvasId}/tokens/--color-ink`)
    expect(strand.status).toBe(400)
    expect((await strand.json()).error).toContain('--color-primary')
    const missing = await owner.put(`/api/canvases/${canvasId}/tokens/--nope`, { value: '1px' })
    expect(missing.status).toBe(400)
  })

  it('keeps writes to editors', async () => {
    expect((await visitor.get(`/api/canvases/${canvasId}/tokens`)).status).toBe(403)
    await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })
    expect((await visitor.get(`/api/canvases/${canvasId}/tokens`)).status).toBe(200)
    expect(
      (await visitor.post(`/api/canvases/${canvasId}/tokens`, { name: '--x', type: 'color', value: '#000' })).status,
    ).toBe(403)
    expect((await visitor.delete(`/api/canvases/${canvasId}/tokens/--spacing-4`)).status).toBe(403)
  })

  it('copies tokens with a duplicated canvas', async () => {
    const copy = await (await owner.post(`/api/canvases/${canvasId}/duplicate`)).json()
    const list = (await (await owner.get(`/api/canvases/${copy.id}/tokens`)).json()) as DesignToken[]
    expect(list.map((t) => t.name)).toEqual(['--color-ink', '--color-primary', '--spacing-4'])
  })
})

describe('design tokens over MCP', () => {
  it('lists and exports them, and tells get_canvas', async () => {
    const json = await mcpCall(ownerKey, 'get_tokens', { canvas_id: canvasId, types: ['color'] })
    expect(json.isError).toBe(false)
    expect(JSON.parse(json.text).tokens.map((t: DesignToken) => t.name)).toEqual(['--color-ink', '--color-primary'])
    const glob = await mcpCall(ownerKey, 'get_tokens', { canvas_id: canvasId, name_pattern: '*-4', format: 'css' })
    /* the canvas has a dark theme by now, so the export carries its block too */
    expect(glob.text).toBe(
      ':root{--spacing-4:32px}\n:root[data-doop-theme="dark"],[data-doop-theme="dark"]{--spacing-4:32px}',
    )
    const canvas = await mcpCall(ownerKey, 'get_canvas', { canvas_id: canvasId, agent_name: 'Tester' })
    expect(canvas.text).toContain('"--color-primary"')
    expect(canvas.text).toContain('var(--name)')
  })

  it('creates, renames and deletes with in-band results', async () => {
    const created = await mcpCall(ownerKey, 'create_tokens', {
      canvas_id: canvasId,
      agent_name: 'Tester',
      tokens: [
        { name: '--radius-md', type: 'radius', value: '8px' },
        { name: '--radius-md', type: 'radius', value: '9px' },
      ],
    })
    expect(JSON.parse(created.text).results).toEqual([
      { name: '--radius-md', result: 'created' },
      { name: '--radius-md', result: 'error', message: expect.stringContaining('already exists') },
    ])
    const renamed = await mcpCall(ownerKey, 'set_tokens', {
      canvas_id: canvasId,
      agent_name: 'Tester',
      tokens: [
        { name: '--radius-md', new_name: '--radius-card' },
        { name: '--radius-card', delete: true },
      ],
    })
    expect(JSON.parse(renamed.text).results).toEqual([
      { name: '--radius-card', result: 'updated' },
      { name: '--radius-card', result: 'deleted' },
    ])
    const list = (await (await owner.get(`/api/canvases/${canvasId}/tokens`)).json()) as DesignToken[]
    expect(list.some((t) => t.name.startsWith('--radius'))).toBe(false)
  })

  it('survives a restart', async () => {
    const dataDir = server.dataDir
    await server.stop({ keepData: true })
    server = await startServer(undefined, dataDir)
    const list = (await (await owner.get(`/api/canvases/${canvasId}/tokens`)).json()) as DesignToken[]
    expect(list.map((t) => [t.name, t.value])).toEqual([
      ['--color-ink', '#111'],
      ['--color-primary', 'var(--color-ink)'],
      ['--spacing-4', '32px'],
    ])
    const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(canvas.tokenThemes).toEqual(['dark'])
  }, 70_000)
})
