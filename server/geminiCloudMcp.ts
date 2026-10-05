import type { Request, Response } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { geminiCloudRuns, geminiCloudWorkerFor } from './geminiCloudRuns.ts'
import { store } from './store.ts'
import { canAccessCanvas } from './access.ts'
import { isBanned } from './auth.ts'

/** Run-scoped capability; Google credentials never reach Doop's web server. */
export async function handleGeminiCloudMcp(req: Request, res: Response) {
  const id = req.params.id ?? ''
  const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
  const run = geminiCloudRuns.authorized(id, token)
  const canExecute = async () => {
    if (!run || !geminiCloudWorkerFor(run.userId)) return false
    const canvas = store.getCanvas(run.request.canvasId)
    return !!canvas && canAccessCanvas(run.userId, canvas) && !(await isBanned(run.userId))
  }
  if (!run || !(await canExecute())) {
    res.status(403).json({ error: 'Gemini cloud run unavailable' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  const server = new Server({ name: 'doop', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: run.request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const result = await geminiCloudRuns.execute(id, token, params.name, params.arguments ?? {}, canExecute)
    const content: ContentBlock[] = []
    if (typeof result.content === 'string') content.push({ type: 'text', text: result.content })
    else
      for (const block of result.content ?? []) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text })
        else if (block.type === 'image' && block.source.type === 'base64') {
          content.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type })
        }
      }
    return { content, isError: !!result.is_error }
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}
