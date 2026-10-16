import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { FRAME_PREVIEW_URI } from '../server/chatgptApp.ts'

interface ToolInputSchema {
  properties?: Record<string, unknown>
  required?: string[]
}

describe('MCP website tool contract', () => {
  it('separates read-only website viewing from editable webpage imports', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-tool-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { tools } = await client.listTools()
      const view = tools.find((tool) => tool.name === 'view_website')
      const importWebpage = tools.find((tool) => tool.name === 'import_webpage')

      expect(view).toBeDefined()
      expect(importWebpage).toBeDefined()
      expect(view!.annotations?.readOnlyHint).toBe(true)
      expect(importWebpage!.annotations?.readOnlyHint).toBe(false)

      const viewSchema = view!.inputSchema as ToolInputSchema
      expect(viewSchema.properties).not.toHaveProperty('save_reference')
      expect(viewSchema.properties).not.toHaveProperty('canvas_id')
      expect(new Set(viewSchema.required)).toEqual(new Set(['url', 'agent_name']))

      const importSchema = importWebpage!.inputSchema as ToolInputSchema
      expect(importSchema.properties).toEqual(
        expect.objectContaining({
          url: expect.any(Object),
          canvas_id: expect.any(Object),
          agent_name: expect.any(Object),
        }),
      )
      expect(new Set(importSchema.required)).toEqual(new Set(['url', 'canvas_id', 'agent_name']))

      expect(client.getInstructions()).toContain('call import_webpage FIRST')
      expect(client.getInstructions()).toContain('view_website is only for read-only inspection')
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe('MCP generate_image tool contract', () => {
  it('scopes a generation to a canvas and lets the agent choose aspect and quality', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-tool-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { tools } = await client.listTools()
      const generate = tools.find((tool) => tool.name === 'generate_image')
      expect(generate).toBeDefined()
      const schema = generate!.inputSchema as ToolInputSchema
      expect(schema.properties).toEqual(
        expect.objectContaining({
          prompt: expect.any(Object),
          aspect: expect.any(Object),
          quality: expect.any(Object),
          canvas_id: expect.any(Object),
          agent_name: expect.any(Object),
        }),
      )
      expect(new Set(schema.required)).toEqual(new Set(['prompt', 'canvas_id', 'agent_name']))
      expect(client.getInstructions()).toContain('generate_image')

      /* an unknown canvas must be refused before anything is spent */
      const result = await client.callTool({
        name: 'generate_image',
        arguments: { prompt: 'a red circle', canvas_id: 'nope', agent_name: 'Test' },
      })
      expect(result.isError).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }
  })
})

it('requires the original page list and rejects stale agent replacements', async () => {
  const { store } = await import('../server/store.ts')
  const canvas = {
    id: 'mcp-page-conflict',
    ownerId: 'test-owner-id',
    name: 'Pages',
    pages: [
      { id: 'first', name: 'Main' },
      { id: 'collaborator', name: 'New' },
    ],
    frames: [],
    createdAt: 0,
    updatedAt: 0,
  }
  store.canvases.set(canvas.id, canvas)
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'pages-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  try {
    const tool = (await client.listTools()).tools.find((tool) => tool.name === 'set_canvas_pages')!
    expect(tool.inputSchema.required).toContain('expectedPages')
    const result = await client.callTool({
      name: 'set_canvas_pages',
      arguments: {
        canvas_id: canvas.id,
        pages: [{ id: 'first', name: 'Renamed' }],
        expectedPages: [{ id: 'first', name: 'Main' }],
        agent_name: 'Agent',
      },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Pages changed')
    expect(canvas.pages).toHaveLength(2)
  } finally {
    store.canvases.delete(canvas.id)
    await client.close()
    await server.close()
  }
})

/* What ChatGPT's app review checks on every tool (developers.openai.com/apps-sdk):
   the three safety hints set explicitly, a title, and — for the tools that
   render a preview card — the component wiring (server/chatgptApp.ts). */
describe('MCP ChatGPT app contract', () => {
  async function connected() {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-chatgpt-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return {
      client,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  it('declares readOnlyHint, destructiveHint and openWorldHint explicitly on every tool, with a title', async () => {
    const { client, close } = await connected()
    try {
      const { tools } = await client.listTools()
      expect(tools.length).toBeGreaterThan(30)
      for (const tool of tools) {
        const a = tool.annotations ?? {}
        expect(typeof a.readOnlyHint, `${tool.name} readOnlyHint`).toBe('boolean')
        expect(typeof a.destructiveHint, `${tool.name} destructiveHint`).toBe('boolean')
        expect(typeof a.openWorldHint, `${tool.name} openWorldHint`).toBe('boolean')
        expect(tool.title, `${tool.name} title`).toBeTruthy()
        if (a.readOnlyHint) expect(a.destructiveHint, `${tool.name} read-only but destructive`).toBe(false)
      }
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
      expect(byName.delete_frame!.annotations!.destructiveHint).toBe(true)
      expect(byName.set_frame_html!.annotations!.destructiveHint).toBe(true)
      expect(byName.get_frame_screenshot!.annotations!.readOnlyHint).toBe(true)
      expect(byName.search_images!.annotations!.openWorldHint).toBe(true)
      expect(byName.list_backgrounds!.annotations!.openWorldHint).toBe(false)
    } finally {
      await close()
    }
  })

  it('links the frame tools to the preview component and serves it as an MCP Apps resource', async () => {
    const { client, close } = await connected()
    try {
      const { tools } = await client.listTools()
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
      const previewTools = [
        'get_canvas',
        'set_frame_html',
        'edit_frame_html',
        'update_frame',
        'get_frame_screenshot',
        'import_webpage',
      ]
      for (const name of previewTools) {
        const meta = byName[name]!._meta as Record<string, unknown>
        expect(meta['openai/outputTemplate'], name).toBe(FRAME_PREVIEW_URI)
        expect((meta.ui as { resourceUri: string }).resourceUri, name).toBe(FRAME_PREVIEW_URI)
        expect(String(meta['openai/toolInvocation/invoking']).length, name).toBeLessThanOrEqual(64)
        expect(String(meta['openai/toolInvocation/invoked']).length, name).toBeLessThanOrEqual(64)
      }
      /* streaming chunks must NOT each render a card — the review screenshot after the stream does */
      expect(byName.append_frame_html!._meta?.['openai/outputTemplate']).toBeUndefined()
      /* nor the (usually still empty) frame creation — a blank artboard card that never updates */
      expect(byName.create_frame!._meta?.['openai/outputTemplate']).toBeUndefined()

      const { resources } = await client.listResources()
      const preview = resources.find((r) => r.uri === FRAME_PREVIEW_URI)
      expect(preview?.mimeType).toBe('text/html;profile=mcp-app')
      const { contents } = await client.readResource({ uri: FRAME_PREVIEW_URI })
      const html = contents[0]!
      if (!('text' in html)) throw new Error('expected a text resource')
      expect(html.mimeType).toBe('text/html;profile=mcp-app')
      expect(html.text).toContain('window.openai')
      expect(html.text).toContain('ui/notifications/tool-result')
      /* a JSON-RPC error reply must reject the request, never pass as a result */
      expect(html.text).toContain('if (m.error) done.reject(m.error)')
      /* images are metered renders: the grid is bounded and a failed load can be retried */
      expect(html.text).toContain('var MAX_SHOWN = 6')
      /* an empty frame shows a placeholder, never a blank render */
      expect(html.text).toContain('Design in progress')
      /* the retired v1 URI stays served for chats that still hold it */
      expect(resources.map((r) => r.uri)).toContain('ui://doop/frame-preview-1.html')
      expect(html.text).toContain('class="retry"')
      const meta = html._meta as Record<string, unknown>
      expect(meta['openai/widgetCSP']).toMatchObject({ resource_domains: [expect.stringMatching(/^http/)] })
      expect(meta.ui).toMatchObject({ csp: { resourceDomains: [expect.stringMatching(/^http/)] } })
    } finally {
      await close()
    }
  })

  it('exposes the connected account as the ChatGPT profile tool', async () => {
    const { client, close } = await connected()
    try {
      const { tools } = await client.listTools()
      const profile = tools.find((t) => t.name === 'get_profile')!
      expect(profile._meta?.['openai/profile']).toBe(true)
      expect(profile.annotations?.readOnlyHint).toBe(true)
      expect(profile.outputSchema).toBeDefined()
      const result = await client.callTool({ name: 'get_profile', arguments: {} })
      expect(result.structuredContent).toEqual({ id: 'test-owner-id', name: 'Test Owner' })
    } finally {
      await close()
    }
  })
})
