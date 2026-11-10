import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  isZ4Schema,
  normalizeObjectSchema,
  type AnySchema,
  type ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'

type DefinitionSchema = AnySchema | ZodRawShapeCompat | undefined

function containsTuple(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTuple)
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => key === 'prefixItems' || containsTuple(child))
}

function publishSchema(schema: DefinitionSchema, io: 'input' | 'output'): Tool['inputSchema'] {
  if (schema === undefined) {
    return { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} }
  }
  const object = normalizeObjectSchema(schema)
  if (!object || !isZ4Schema(object)) throw new Error('MCP definitions require Zod4 object schemas')
  const converted = toJsonSchemaCompat(object, { target: 'draft-2020-12', pipeStrategy: io, strictUnions: true })
  // The pinned converter omits fixed-tuple cardinality. Refuse unsupported definitions rather
  // than advertise a contract that admits values the actual SDK rejects.
  if (containsTuple(converted)) throw new Error('MCP tuple schema conversion is unsupported')
  if (converted.type !== 'object') throw new Error('MCP definitions require object schemas')
  return { ...converted, type: 'object' }
}

/** Emit the workflow's dialect from the same public handles the SDK validates and invokes. */
export class WorkflowMcpServer extends McpServer {
  private readonly listedTools = new Map<string, RegisteredTool>()

  override registerTool: McpServer['registerTool'] = (name, config, callback) => {
    publishSchema(config.inputSchema, 'input')
    if (config.outputSchema) publishSchema(config.outputSchema, 'output')
    const tool = super.registerTool(name, config, callback)
    const update = tool.update
    let removed = false
    tool.update = (changes) => {
      if (removed) {
        if (changes.name === null) return
        throw new Error('MCP tool registration was removed')
      }
      // SDK1.30 closes over the original name, so rename then remove leaves a callable alias.
      if (changes.name !== undefined && changes.name !== null && changes.name !== name) {
        throw new Error('MCP tool registration names are fixed')
      }
      if (changes.paramsSchema !== undefined) publishSchema(changes.paramsSchema, 'input')
      if (changes.outputSchema !== undefined) publishSchema(changes.outputSchema, 'output')
      update(changes)
      if (changes.name === null) {
        removed = true
        this.listedTools.delete(name)
      }
    }
    this.listedTools.set(name, tool)
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.listedTools]
        .filter(([, entry]) => entry.enabled)
        .map(([toolName, entry]) => this.definition(toolName, entry)),
    }))
    return tool
  }

  private definition(name: string, tool: RegisteredTool): Tool {
    return {
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: publishSchema(tool.inputSchema, 'input'),
      ...(tool.outputSchema ? { outputSchema: publishSchema(tool.outputSchema, 'output') } : {}),
      annotations: tool.annotations,
      execution: tool.execution,
      _meta: tool._meta,
    }
  }
}
