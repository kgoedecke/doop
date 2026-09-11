import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'

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
