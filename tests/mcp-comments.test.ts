import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
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

const FRAME_A: Frame = {
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

const FRAME_B: Frame = {
  id: 'f2',
  canvasId: CANVAS.id,
  name: 'Pricing',
  html: '<p>$</p>',
  x: 700,
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
    frameId: FRAME_A.id,
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
  const client = new Client({ name: 'doop-comments-test', version: '1.0.0' })
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

async function callComments(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ parsed: unknown; raw: string; isError?: boolean }> {
  const result = (await client.callTool({ name: 'get_comments', arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* error strings are not JSON — leave the raw text for assertions */
  }
  return { parsed, raw, isError: result.isError }
}

function stubStore(canvases: Canvas[], frames: Frame[]) {
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => canvases.find((c) => c.id === id))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) => frames.find((f) => f.id === id))
}

beforeEach(() => {
  vi.restoreAllMocks()
  stubStore([CANVAS], [FRAME_A, FRAME_B])
})

describe('get_comments MCP tool', () => {
  it('is read-only with canvas_id required and frame/include_resolved/agent_name optional', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const tool = tools.find((t) => t.name === 'get_comments')
      expect(tool).toBeDefined()
      expect(tool!.annotations?.readOnlyHint).toBe(true)
      const schema = tool!.inputSchema as unknown as {
        properties?: Record<string, { default?: unknown }>
        required?: string[]
      }
      expect(Object.keys(schema.properties ?? {})).toEqual(
        expect.arrayContaining(['canvas_id', 'frame_id', 'include_resolved', 'agent_name']),
      )
      expect(schema.required).toEqual(['canvas_id'])
      expect(schema.properties?.include_resolved?.default).toBe(true)
    } finally {
      await close()
    }
  })

  it('returns stored comments newest first with full metadata and replies', async () => {
    const reply = comment({ id: 'm2', text: 'Agreed', from: 'bob', at: 2, parentId: 'm1' })
    const root = comment({
      id: 'm1',
      text: 'Too small',
      at: 1,
      forAgent: true,
      targetAgent: 'Doop',
      claimedBy: 'Doop',
      claimedAt: 3,
    })
    const stored = [reply, root]
    const spy = vi.spyOn(actions, 'getComments').mockReturnValue(stored)
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callComments(client, { canvas_id: CANVAS.id })
      expect(isError).toBeFalsy()
      expect(spy).toHaveBeenCalledWith(CANVAS.id)
      expect(parsed).toEqual(stored)
      expect(parsed).toEqual([reply, root])
    } finally {
      await close()
    }
  })

  it('filters by frame_id', async () => {
    const stored = [
      comment({ id: 'm3', frameId: FRAME_B.id, at: 3, text: 'on pricing' }),
      comment({ id: 'm1', frameId: FRAME_A.id, at: 1, text: 'on hero' }),
    ]
    vi.spyOn(actions, 'getComments').mockReturnValue(stored)
    const { client, close } = await connect()
    try {
      const { parsed } = await callComments(client, { canvas_id: CANVAS.id, frame_id: FRAME_B.id })
      expect(parsed).toEqual([stored[0]])
    } finally {
      await close()
    }
  })

  it('includes resolved comments by default and excludes them with include_resolved false', async () => {
    const resolved = comment({ id: 'm2', at: 2, text: 'fixed', resolvedAt: 5, resolvedBy: 'alice' })
    const open = comment({ id: 'm1', at: 1, text: 'open' })
    vi.spyOn(actions, 'getComments').mockReturnValue([resolved, open])
    const { client, close } = await connect()
    try {
      const withDefault = await callComments(client, { canvas_id: CANVAS.id })
      expect(withDefault.parsed).toHaveLength(2)
      const unresolvedOnly = await callComments(client, { canvas_id: CANVAS.id, include_resolved: false })
      expect(unresolvedOnly.parsed).toEqual([open])
    } finally {
      await close()
    }
  })

  it('returns an empty array when there are no comments', async () => {
    vi.spyOn(actions, 'getComments').mockReturnValue([])
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callComments(client, { canvas_id: CANVAS.id })
      expect(isError).toBeFalsy()
      expect(parsed).toEqual([])
    } finally {
      await close()
    }
  })

  it('rejects unknown and unauthorized canvases with the existing noCanvas error', async () => {
    vi.spyOn(actions, 'getComments')
    const { client, close } = await connect()
    try {
      const unknown = await callComments(client, { canvas_id: 'missing' })
      expect(unknown.isError).toBe(true)
      expect(unknown.raw).toContain('no canvas with id missing')

      stubStore([{ ...CANVAS, id: 'private', ownerId: 'someone-else', memberIds: [], linkAccess: 'none' }], [FRAME_A])
      const denied = await callComments(client, { canvas_id: 'private' })
      expect(denied.isError).toBe(true)
      expect(denied.raw).toContain('no canvas with id private')
    } finally {
      await close()
    }
  })

  it('allows owner, invited member, and link-edit access', async () => {
    const stored = [comment({ id: 'm1', text: 'hi' })]
    vi.spyOn(actions, 'getComments').mockReturnValue(stored)
    for (const canvas of [
      { ...CANVAS, ownerId: OWNER_ID },
      { ...CANVAS, ownerId: 'someone-else', memberIds: [OWNER_ID] },
      { ...CANVAS, ownerId: 'someone-else', memberIds: [], linkAccess: 'edit' as const },
    ]) {
      stubStore([canvas], [FRAME_A])
      const { client, close } = await connect(OWNER_ID)
      try {
        const { parsed, isError } = await callComments(client, { canvas_id: CANVAS.id })
        expect(isError).toBeFalsy()
        expect(parsed).toEqual(stored)
      } finally {
        await close()
      }
    }
  })

  it('rejects a frame from another canvas and unknown frames with the existing noFrame error', async () => {
    vi.spyOn(actions, 'getComments')
    const otherCanvas: Canvas = { ...CANVAS, id: 'c2', ownerId: OWNER_ID }
    const foreign: Frame = { ...FRAME_A, id: 'fx', canvasId: 'c2' }
    stubStore([CANVAS, otherCanvas], [FRAME_A, foreign])
    const { client, close } = await connect()
    try {
      const cross = await callComments(client, { canvas_id: CANVAS.id, frame_id: foreign.id })
      expect(cross.isError).toBe(true)
      expect(cross.raw).toContain(`no frame with id ${foreign.id}`)
      const missing = await callComments(client, { canvas_id: CANVAS.id, frame_id: 'nope' })
      expect(missing.isError).toBe(true)
      expect(missing.raw).toContain('no frame with id nope')
    } finally {
      await close()
    }
  })

  it('does not claim or resolve anything while reading', async () => {
    const stored = [comment({ id: 'm1', forAgent: true, targetAgent: 'Doop', text: '@Doop bigger' })]
    vi.spyOn(actions, 'getComments').mockReturnValue(stored)
    const takeFeedback = vi.spyOn(actions, 'takeFeedbackFor')
    const takeComments = vi.spyOn(actions, 'takeAgentCommentsFor')
    const resolve = vi.spyOn(actions, 'resolveComment')
    const before = JSON.parse(JSON.stringify(stored))
    const { client, close } = await connect()
    try {
      await callComments(client, { canvas_id: CANVAS.id, agent_name: 'Claude' })
      expect(takeFeedback).not.toHaveBeenCalled()
      expect(takeComments).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
      expect(stored).toEqual(before)
      expect(stored[0]?.claimedBy).toBeUndefined()
      expect(stored[0]?.resolvedAt).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('heartbeats for agent_name without delivering feedback', async () => {
    vi.spyOn(actions, 'getComments').mockReturnValue([])
    const heartbeat = vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
    const takeFeedback = vi.spyOn(actions, 'takeFeedbackFor')
    const { client, close } = await connect()
    try {
      await callComments(client, { canvas_id: CANVAS.id, agent_name: 'Claude' })
      expect(heartbeat).toHaveBeenCalledTimes(1)
      expect(heartbeat.mock.calls[0]?.[0]).toBe(CANVAS.id)
      expect(takeFeedback).not.toHaveBeenCalled()

      heartbeat.mockClear()
      await callComments(client, { canvas_id: CANVAS.id })
      expect(heartbeat).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})
