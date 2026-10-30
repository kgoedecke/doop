import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame, TaskFeedback } from '../shared/types.ts'

/* A tool annotated readOnlyHint: true must not write. Claiming human feedback
 * writes (deliveredAt, claimedBy, a broadcast), so reads only announce it and
 * the tools that change the canvas keep claiming. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))

const OWNER_ID = 'owner-1'

const FRAME: Frame = {
  id: 'f1',
  canvasId: 'c1',
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

const CANVAS: Canvas = { id: 'c1', name: 'Feedback', ownerId: OWNER_ID, createdAt: 0, updatedAt: 0, frames: [FRAME] }

const FEEDBACK: TaskFeedback = {
  id: 'fb1',
  taskId: 't1',
  canvasId: CANVAS.id,
  agentName: 'Claude',
  from: 'alice',
  text: 'make the accent warmer',
  at: 1,
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-read-only-feedback-test', version: '1.0.0' })
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

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[] }
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) => (id === FRAME.id ? FRAME : undefined))
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  vi.spyOn(actions, 'getTasks').mockReturnValue([])
})

describe('human feedback on read-only MCP tools', () => {
  it.each([
    ['get_canvas', { canvas_id: CANVAS.id, agent_name: 'Claude' }],
    ['get_frame', { frame_id: FRAME.id, agent_name: 'Claude' }],
  ])('%s announces open feedback without claiming it', async (tool, args) => {
    vi.spyOn(actions, 'openFeedbackFor').mockReturnValue([FEEDBACK])
    const take = vi.spyOn(actions, 'takeFeedbackFor')
    const { client, close } = await connect()
    try {
      const raw = await callText(client, tool, args)
      expect(take).not.toHaveBeenCalled()
      expect(raw).toContain('HUMAN FEEDBACK — 1 open request')
      expect(raw).toContain('get_feedback')
      expect(raw).not.toContain(FEEDBACK.text)
    } finally {
      await close()
    }
  })

  it('still claims and delivers feedback on a tool that changes the canvas', async () => {
    vi.spyOn(actions, 'updateFrame').mockReturnValue(FRAME)
    const take = vi.spyOn(actions, 'takeFeedbackFor').mockReturnValue([FEEDBACK])
    const { client, close } = await connect()
    try {
      const raw = await callText(client, 'edit_frame_html', {
        frame_id: FRAME.id,
        old_str: 'Hi',
        new_str: 'Hello',
        agent_name: 'Claude',
      })
      expect(take).toHaveBeenCalledWith(CANVAS.id, 'Claude')
      expect(raw).toContain(FEEDBACK.text)
    } finally {
      await close()
    }
  })
})

describe('openFeedbackFor', () => {
  it('lists what takeFeedbackFor would claim and leaves it unclaimed', () => {
    const entry: TaskFeedback = { ...FEEDBACK, id: 'fb-real', canvasId: 'c-open' }
    const empty = new Map()
    actions.hydrateLogs({
      tasks: empty,
      feedback: new Map([['c-open', [entry]]]),
      comments: empty,
      activity: empty,
      decisions: empty,
      proposals: empty,
    })
    expect(actions.openFeedbackFor('c-open', 'Claude').map((f) => f.id)).toEqual(['fb-real'])
    expect(entry.deliveredAt).toBeUndefined()
    expect(actions.takeFeedbackFor('c-open', 'Claude').map((f) => f.id)).toEqual(['fb-real'])
    expect(entry.claimedBy).toBe('Claude')
    expect(actions.openFeedbackFor('c-open', 'Claude')).toEqual([])
  })
})
