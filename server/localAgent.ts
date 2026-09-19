import { CLAUDE_MODEL_IDS } from '../shared/localAgent.ts'
import { Router, type Request, type Response } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { localAgentRuns } from './localAgentRuns.ts'
import { getLocalAgentPreference, saveLocalAgentPreference } from './localAgentPreferences.ts'
import { store } from './store.ts'
import { canAccessCanvas } from './access.ts'
import { isBanned } from './auth.ts'
import { onFeedback } from './resident.ts'

export const localAgentRouter = Router()
const preferenceSchema = z.object({
  enabled: z.boolean(),
  model: z.enum([...CLAUDE_MODEL_IDS, 'default', 'sonnet', 'opus']),
})
const deviceSchema = z.object({ deviceId: z.string().uuid() })

localAgentRouter.get('/', (req, res, next) => {
  getLocalAgentPreference(req.user!.id)
    .then((preference) => res.json({ ...preference, online: localAgentRuns.online(req.user!.id) }))
    .catch(next)
})

localAgentRouter.put('/', (req, res, next) => {
  const parsed = preferenceSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid local agent preference' })
    return
  }
  const userId = req.user!.id
  void (async () => {
    if (!parsed.data.enabled) await localAgentRuns.cancel(userId)
    await saveLocalAgentPreference(userId, parsed.data)
    res.json(await getLocalAgentPreference(userId))
    wake(userId)
  })().catch(next)
})

function wake(userId: string) {
  for (const canvas of store.canvases.values()) if (canAccessCanvas(userId, canvas)) onFeedback(canvas.id)
}

// POST: polling claims a run and is prohibited in read-only impersonation sessions.
localAgentRouter.post('/poll', (req, res, next) => {
  const parsed = deviceSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid device' })
    return
  }
  void (async () => {
    const userId = req.user!.id
    const preference = await getLocalAgentPreference(userId)
    if (!preference.enabled) {
      res.json({ job: null, enabled: false })
      return
    }
    const wasOnline = localAgentRuns.online(userId)
    const job = localAgentRuns.poll(userId, parsed.data.deviceId)
    res.json({ job, enabled: true })
    if (!wasOnline) wake(userId)
  })().catch(next)
})

localAgentRouter.post('/finish/:id', (req, res, next) => {
  const parsed = deviceSchema.extend({ success: z.boolean(), text: z.string().max(100_000) }).safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid result' })
    return
  }
  localAgentRuns
    .finish(req.params.id!, req.user!.id, parsed.data.deviceId, parsed.data)
    .then((ok) => res.status(ok ? 200 : 409).json({ ok }))
    .catch(next)
})

localAgentRouter.post('/stop', (req, res, next) => {
  localAgentRuns
    .cancel(req.user!.id)
    .then(() => res.json({ ok: true }))
    .catch(next)
})

/** An unguessable, short-lived run token grants only this canvas's resident tools.
 * Recheck membership and bans on every request, independently of browser cookies. */
export async function handleLocalAgentMcp(req: Request, res: Response) {
  const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
  const id = req.params.id ?? ''
  const run = localAgentRuns.authorized(id, token)
  const canvas = run && store.getCanvas(run.request.canvasId)
  if (!run || !canvas || !canAccessCanvas(run.userId, canvas) || (await isBanned(run.userId))) {
    res.status(403).json({ error: 'Local run unavailable' })
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
    const result = await localAgentRuns.execute(id, token, params.name, params.arguments ?? {})
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
