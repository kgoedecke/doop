import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { z as z3 } from 'zod'
import { WorkflowMcpServer } from '../server/mcpSchemas.ts'
import { buildMcpServer } from '../server/mcp.ts'

vi.mock('../server/db/persist.ts', () => ({
  insertCanvas: async () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
}))

// Use the SDK's locked validator dependency, explicitly selecting its 2020-12 implementation.
const sdkRequire = createRequire(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { default: Ajv2020 } = sdkRequire('ajv/dist/2020.js') as {
  default: new (options: { strict: boolean }) => { compile(schema: object): (value: unknown) => boolean }
}
const dialect = 'https://json-schema.org/draft/2020-12/schema'

async function connected(server: WorkflowMcpServer) {
  const client = new Client({ name: 'schema-contract-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

describe('MCP workflow schema emission', () => {
  it('matches actual SDK validation for supported boundaries and preserves default parsing', async () => {
    const server = new WorkflowMcpServer({ name: 'contract', version: '1' })
    const parsed: unknown[] = []
    server.registerTool(
      'bounded',
      {
        inputSchema: {
          choice: z.union([z.literal('ok'), z.number().min(2).max(4)]),
          count: z.number().int().min(1).max(3).default(2),
          tags: z
            .array(z.enum(['a', 'b']))
            .min(1)
            .max(2)
            .optional(),
        },
        outputSchema: { accepted: z.boolean() },
      },
      (value) => {
        parsed.push(value)
        return { content: [], structuredContent: { accepted: true } }
      },
    )
    const client = await connected(server)
    try {
      const { tools } = await client.listTools()
      const tool = tools[0]!
      expect(tool.inputSchema.$schema).toBe(dialect)
      expect(tool.outputSchema?.$schema).toBe(dialect)
      expect(tool.inputSchema.required).toEqual(['choice'])
      expect(tool.inputSchema.properties?.count).toMatchObject({ minimum: 1, maximum: 3, default: 2 })
      expect(tool.outputSchema).toMatchObject({ additionalProperties: false, required: ['accepted'] })
      const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema)
      const cases = [
        { value: { choice: 'ok' }, valid: true },
        { value: { choice: 2, count: 1, tags: ['a', 'b'] }, valid: true },
        { value: { choice: 4, count: 3 }, valid: true },
        { value: {}, valid: false },
        { value: { choice: 'other' }, valid: false },
        { value: { choice: 1 }, valid: false },
        { value: { choice: 5 }, valid: false },
        { value: { choice: 'ok', count: 0 }, valid: false },
        { value: { choice: 'ok', count: 4 }, valid: false },
        { value: { choice: 'ok', count: 1.5 }, valid: false },
        { value: { choice: 'ok', tags: [] }, valid: false },
        { value: { choice: 'ok', tags: ['a', 'b', 'a'] }, valid: false },
        { value: { choice: 'ok', tags: ['c'] }, valid: false },
      ]
      for (const entry of cases) {
        expect(validate(entry.value), JSON.stringify(entry.value)).toBe(entry.valid)
        const result = await client.callTool({ name: 'bounded', arguments: entry.value })
        expect(result.isError !== true, JSON.stringify(entry.value)).toBe(entry.valid)
      }
      expect(parsed).toHaveLength(3)
      expect(parsed[0]).toEqual({ choice: 'ok', count: 2 })
      const output = new Ajv2020({ strict: false }).compile(tool.outputSchema!)
      expect(output({ accepted: true })).toBe(true)
      expect(output({ accepted: 'true' })).toBe(false)
      expect(output({ accepted: true, forged: true })).toBe(false)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('updates real handles while rejecting renames and preventing removed aliases or resurrection', async () => {
    const server = new WorkflowMcpServer({ name: 'lifecycle', version: '1' })
    let calls = 0
    const tool = server.registerTool('original', { inputSchema: { value: z.string() } }, () => {
      calls += 1
      return { content: [] }
    })
    const client = await connected(server)
    try {
      expect(() => tool.update({ name: 'alias', title: 'must not apply' })).toThrow('names are fixed')
      expect(() => tool.update({ name: 'other' })).toThrow('names are fixed')
      expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(['original'])
      expect((await client.callTool({ name: 'alias', arguments: { value: 'x' } })).isError).toBe(true)
      expect(calls).toBe(0)
      tool.update({
        name: 'original',
        title: 'Updated',
        description: 'Current metadata',
        paramsSchema: { value: z.number().min(1) },
        annotations: { readOnlyHint: true },
        _meta: { 'test/current': true },
      })
      const current = (await client.listTools()).tools[0]!
      expect(current).toMatchObject({
        name: 'original',
        title: 'Updated',
        description: 'Current metadata',
        annotations: { readOnlyHint: true },
        _meta: { 'test/current': true },
      })
      expect(current.inputSchema.properties?.value).toMatchObject({ type: 'number', minimum: 1 })
      expect((await client.callTool({ name: 'original', arguments: { value: 'x' } })).isError).toBe(true)
      expect((await client.callTool({ name: 'original', arguments: { value: 1 } })).isError).not.toBe(true)
      tool.disable()
      expect((await client.listTools()).tools).toHaveLength(0)
      expect((await client.callTool({ name: 'original', arguments: { value: 1 } })).isError).toBe(true)
      tool.enable()
      expect((await client.listTools()).tools).toHaveLength(1)
      tool.remove()
      tool.remove()
      expect((await client.listTools()).tools).toHaveLength(0)
      expect((await client.callTool({ name: 'original', arguments: { value: 1 } })).isError).toBe(true)
      expect(() => tool.enable()).toThrow('removed')
      server.registerTool('original', {}, () => {
        calls += 10
        return { content: [] }
      })
      expect(() => tool.update({ enabled: true })).toThrow('removed')
      tool.remove()
      expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(['original'])
      expect((await client.callTool({ name: 'original' })).isError).not.toBe(true)
      expect(calls).toBe(11)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('rejects Zod3 and nested tuples before registration or update mutates the SDK', async () => {
    const server = new WorkflowMcpServer({ name: 'unsupported', version: '1' })
    let calls = 0
    const callback = () => {
      calls += 1
      return { content: [] }
    }
    expect(() => server.registerTool('v3', { inputSchema: { value: z3.string() } }, callback)).toThrow('Zod4')
    const tuple = z.object({ nested: z.tuple([z.string(), z.number()]) })
    expect(() => server.registerTool('tuple', { inputSchema: { value: tuple } }, callback)).toThrow('tuple')
    expect(() => server.registerTool('output_tuple', { outputSchema: { value: tuple } }, callback)).toThrow('tuple')
    const tool = server.registerTool('valid', { inputSchema: { value: z.string() } }, callback)
    expect(() => tool.update({ paramsSchema: { value: tuple }, title: 'must not apply' })).toThrow('tuple')
    expect(() => tool.update({ outputSchema: { value: tuple } })).toThrow('tuple')
    const client = await connected(server)
    try {
      expect((await client.listTools()).tools).toMatchObject([
        { name: 'valid', inputSchema: { properties: { value: { type: 'string' } } } },
      ])
      for (const name of ['v3', 'tuple', 'output_tuple']) {
        expect((await client.callTool({ name })).isError).toBe(true)
      }
      expect(calls).toBe(0)
      expect((await client.callTool({ name: 'valid', arguments: { value: 'kept' } })).isError).not.toBe(true)
      expect(calls).toBe(1)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('publishes every actual Doop schema in 2020-12 and retains preview metadata', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id') as WorkflowMcpServer
    const client = await connected(server)
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(48)
      const validator = new Ajv2020({ strict: false })
      for (const tool of tools) {
        for (const schema of [tool.inputSchema, tool.outputSchema].filter((value) => value !== undefined)) {
          expect(schema.$schema, tool.name).toBe(dialect)
          expect(() => validator.compile(schema), tool.name).not.toThrow()
        }
      }
      expect(tools.find((tool) => tool.name === 'get_canvas')?._meta).toBeDefined()
      expect(tools.find((tool) => tool.name === 'get_profile')?.outputSchema?.properties).toHaveProperty(
        'managed_workspace_id',
      )
    } finally {
      await client.close()
      await server.close()
    }
  })
})
