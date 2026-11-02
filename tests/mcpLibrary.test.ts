import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'

interface ToolInputSchema {
  properties?: Record<string, unknown>
  required?: string[]
}

it('offers agents the design-system tools and tells them to build from components', async () => {
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  const client = new Client({ name: 'doop-library-contract-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  try {
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const required = (name: string) => new Set((byName.get(name)!.inputSchema as ToolInputSchema).required)

    expect(byName.get('get_design_system')?.annotations?.readOnlyHint).toBe(true)
    /* canvas_id or workspace_id names the library; the handler insists on exactly one */
    expect(required('get_design_system')).toEqual(new Set())
    expect(byName.get('save_component')?.annotations?.readOnlyHint).toBe(false)
    expect(required('save_component')).toEqual(new Set(['slug', 'agent_name']))
    expect((byName.get('save_component')!.inputSchema as ToolInputSchema).properties).toEqual(
      expect.objectContaining({ canvas_id: expect.any(Object), workspace_id: expect.any(Object) }),
    )
    expect(byName.get('list_workspaces')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.has('create_workspace')).toBe(true)
    expect((byName.get('save_component')!.inputSchema as ToolInputSchema).properties).toEqual(
      expect.objectContaining({ html: expect.any(Object), css: expect.any(Object), js: expect.any(Object) }),
    )
    expect(byName.get('delete_component')?.annotations?.destructiveHint).toBe(true)
    expect(byName.has('set_design_system')).toBe(true)
    expect(byName.has('create_component_group')).toBe(true)

    expect(client.getInstructions()).toContain('get_design_system BEFORE designing')
    expect(client.getInstructions()).toContain('data-doop-component')
  } finally {
    await client.close()
    await server.close()
  }
})
