import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import * as allowance from '../server/allowance.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, ElementComment, Frame } from '../shared/types.ts'

const OWNER_ID = 'owner-1'

const CANVAS: Canvas = {
  id: 'c1',
  name: 'Comments',
  ownerId: OWNER_ID,
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}

const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS.id,
  name: 'Hero',
  html: '<h1>Hi</h1>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}

function comment(overrides: Partial<ElementComment> & { id: string }): ElementComment {
  return {
    canvasId: CANVAS.id,
    frameId: FRAME.id,
    selector: '.hero h1',
    snippet: '<h1>Hi</h1>',
    from: 'alice',
    text: 'note',
    at: 1,
    ...overrides,
  }
}

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect(ownerId: string | undefined = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'doop-comment-write-test', version: '1.0.0' })
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

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ parsed: unknown; raw: string; isError?: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* error strings and multi-block results are not JSON — keep the raw text */
  }
  return { parsed, raw, isError: result.isError }
}

function stubCanvas(canvas: Canvas) {
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === canvas.id ? canvas : undefined))
}

function gate(overrides: Record<string, unknown> = {}): Awaited<ReturnType<typeof allowance.consumeResidentTask>> {
  return {
    ok: true,
    used: 1,
    limit: 5,
    connected: false,
    byoModel: false,
    onOwnAccount: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  stubCanvas(CANVAS)
  /* writes always announce presence — keep it off the presence map */
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
})

describe('element-comment write MCP tools', () => {
  it('registers reply_to_comment and resolve_comment as mutating tools', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const reply = tools.find((t) => t.name === 'reply_to_comment')
      const resolve = tools.find((t) => t.name === 'resolve_comment')
      expect(reply).toBeDefined()
      expect(resolve).toBeDefined()
      expect(reply!.annotations?.readOnlyHint).not.toBe(true)
      expect(resolve!.annotations?.readOnlyHint).not.toBe(true)

      const replySchema = reply!.inputSchema as { required?: string[] }
      expect(new Set(replySchema.required)).toEqual(new Set(['canvas_id', 'comment_id', 'text', 'agent_name']))
      const resolveSchema = resolve!.inputSchema as { required?: string[] }
      expect(new Set(resolveSchema.required)).toEqual(new Set(['canvas_id', 'comment_id', 'agent_name']))
    } finally {
      await close()
    }
  })

  it('replies in a thread, attributes it to the agent, and announces presence', async () => {
    const root = comment({ id: 'm1' })
    const reply = comment({ id: 'm2', parentId: 'm1', from: 'Claude', text: 'Done' })
    vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'openThread').mockReturnValue({ root, frame: FRAME })
    const replySpy = vi.spyOn(actions, 'replyToComment').mockReturnValue(reply)
    const heartbeat = vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: '  Done  ',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed).toEqual(reply)
      /* the 5th arg is the actor kind: an agent reply must not log as a human */
      expect(replySpy).toHaveBeenCalledWith('m1', '  Done  ', 'Claude', undefined, 'agent')
      expect(heartbeat).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })

  it('rejects empty text and resolved threads', async () => {
    vi.spyOn(actions, 'findComment').mockReturnValue(comment({ id: 'm1' }))
    const openThread = vi.spyOn(actions, 'openThread').mockReturnValue(undefined)
    const replySpy = vi.spyOn(actions, 'replyToComment')
    const { client, close } = await connect()
    try {
      const blank = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: '   ',
        agent_name: 'Claude',
      })
      expect(blank.isError).toBe(true)
      expect(blank.raw).toContain('thread resolved or empty text')

      const closed = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: 'hi',
        agent_name: 'Claude',
      })
      expect(closed.isError).toBe(true)
      expect(closed.raw).toContain('thread resolved or empty text')
      expect(openThread).toHaveBeenCalled()
      expect(replySpy).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('does not spend the resident meter on a plain reply', async () => {
    const root = comment({ id: 'm1' })
    vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'openThread').mockReturnValue({ root, frame: FRAME })
    vi.spyOn(actions, 'replyToComment').mockReturnValue(comment({ id: 'm2', parentId: 'm1' }))
    const consume = vi.spyOn(allowance, 'consumeResidentTask')
    const { client, close } = await connect()
    try {
      const { isError } = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: 'nice work',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(consume).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('meters an @mention of a resident role and refunds when the thread closes mid-write', async () => {
    const root = comment({ id: 'm1' })
    vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'openThread').mockReturnValue({ root, frame: FRAME })
    const consume = vi.spyOn(allowance, 'consumeResidentTask').mockResolvedValue(gate())
    const refund = vi.spyOn(allowance, 'refundResidentTask').mockResolvedValue(undefined)
    const replySpy = vi.spyOn(actions, 'replyToComment').mockReturnValue(comment({ id: 'm2', parentId: 'm1' }))
    const { client, close } = await connect()
    try {
      const ok = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: '@Doop please tighten the hero',
        agent_name: 'Claude',
      })
      expect(ok.isError).toBeFalsy()
      expect(consume).toHaveBeenCalledTimes(1)
      expect(consume).toHaveBeenCalledWith(OWNER_ID)
      expect(refund).not.toHaveBeenCalled()

      consume.mockClear()
      refund.mockClear()
      replySpy.mockReturnValue(undefined)
      const failed = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: '@Doop again',
        agent_name: 'Claude',
      })
      expect(failed.isError).toBe(true)
      expect(refund).toHaveBeenCalledTimes(1)
      expect(refund).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), OWNER_ID)
    } finally {
      await close()
    }
  })

  it('refuses a metered reply once the resident allowance is spent', async () => {
    const root = comment({ id: 'm1' })
    vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'openThread').mockReturnValue({ root, frame: FRAME })
    const replySpy = vi.spyOn(actions, 'replyToComment')
    vi.spyOn(allowance, 'consumeResidentTask').mockResolvedValue(gate({ ok: false, used: 5, limit: 5 }))
    const { client, close } = await connect()
    try {
      const { raw, isError } = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: '@Doop help',
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect(raw).toContain('resident task limit reached')
      expect(replySpy).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('rejects unknown/foreign comments and inaccessible canvases on reply', async () => {
    const find = vi.spyOn(actions, 'findComment').mockReturnValue(undefined)
    const replySpy = vi.spyOn(actions, 'replyToComment')
    const { client, close } = await connect()
    try {
      const unknown = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'nope',
        text: 'hi',
        agent_name: 'Claude',
      })
      expect(unknown.isError).toBe(true)
      expect(unknown.raw).toContain('no comment with id nope')

      find.mockReturnValue(comment({ id: 'm9', canvasId: 'c2' }))
      const foreign = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm9',
        text: 'hi',
        agent_name: 'Claude',
      })
      expect(foreign.isError).toBe(true)
      expect(foreign.raw).toContain('no comment with id m9')

      stubCanvas({ ...CANVAS, ownerId: 'someone-else' })
      const denied = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: 'hi',
        agent_name: 'Claude',
      })
      expect(denied.isError).toBe(true)
      expect(denied.raw).toContain('no canvas')
      expect(replySpy).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('resolves a thread and reports the already-resolved state', async () => {
    const root = comment({ id: 'm1' })
    const find = vi.spyOn(actions, 'findComment').mockReturnValue(root)
    const resolvedAt = Date.UTC(2026, 0, 1)
    const resolveSpy = vi
      .spyOn(actions, 'resolveComment')
      .mockReturnValue({ ...root, resolvedBy: 'Claude', resolvedAt })
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed).toMatchObject({ ok: true, id: 'm1', alreadyResolved: false, resolvedBy: 'Claude' })
      expect(resolveSpy).toHaveBeenCalledWith('m1', 'Claude')

      find.mockReturnValue({ ...root, resolvedAt, resolvedBy: 'alice' })
      const again = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        agent_name: 'Claude',
      })
      expect(again.parsed).toMatchObject({ ok: true, alreadyResolved: true })
    } finally {
      await close()
    }
  })

  it('allows link-edit access and rejects unknown comments on resolve', async () => {
    stubCanvas({ ...CANVAS, ownerId: 'someone-else', memberIds: [], linkAccess: 'edit' })
    const root = comment({ id: 'm1' })
    const find = vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'resolveComment').mockReturnValue({ ...root, resolvedBy: 'Claude', resolvedAt: 1 })
    const { client, close } = await connect()
    try {
      const allowed = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        agent_name: 'Claude',
      })
      expect(allowed.isError).toBeFalsy()

      find.mockReturnValue(undefined)
      const unknown = await call(client, 'resolve_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'nope',
        agent_name: 'Claude',
      })
      expect(unknown.isError).toBe(true)
      expect(unknown.raw).toContain('no comment with id nope')
    } finally {
      await close()
    }
  })

  it('delivers pending human feedback alongside the reply', async () => {
    const root = comment({ id: 'm1' })
    vi.spyOn(actions, 'findComment').mockReturnValue(root)
    vi.spyOn(actions, 'openThread').mockReturnValue({ root, frame: FRAME })
    vi.spyOn(actions, 'replyToComment').mockReturnValue(comment({ id: 'm2', parentId: 'm1' }))
    vi.spyOn(actions, 'takeFeedbackFor').mockReturnValue([
      {
        id: 'fb1',
        taskId: 't1',
        canvasId: CANVAS.id,
        agentName: 'Claude',
        from: 'alice',
        text: 'make the accent warmer',
        at: 1,
      },
    ])
    vi.spyOn(actions, 'getTasks').mockReturnValue([])
    const { client, close } = await connect()
    try {
      const { raw } = await call(client, 'reply_to_comment', {
        canvas_id: CANVAS.id,
        comment_id: 'm1',
        text: 'done',
        agent_name: 'Claude',
      })
      expect(raw).toContain('HUMAN FEEDBACK')
      expect(raw).toContain('make the accent warmer')
    } finally {
      await close()
    }
  })
})
