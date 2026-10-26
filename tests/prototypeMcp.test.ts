import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* persistence is mocked: the tools' effect on the in-memory canvas is the contract */
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
}))

const frame = (id: string, pageId: string, html: string): Frame => ({
  id,
  canvasId: 'mcp-proto',
  pageId,
  name: id.toUpperCase(),
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  html,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Test',
})

let canvas: Canvas
let client: Client
let close: () => Promise<void>

beforeEach(async () => {
  canvas = {
    id: 'mcp-proto',
    ownerId: 'test-owner-id',
    name: 'Proto',
    pages: [
      { id: 'one', name: 'One' },
      { id: 'two', name: 'Two' },
    ],
    frames: [
      frame('home', 'one', '<button data-doop-on="click" data-doop-action="navigate:detail">Open</button>'),
      frame('detail', 'one', '<a data-doop-on="click" data-doop-action="overlay:ghost">Help</a>'),
      frame('other', 'two', '<p>elsewhere</p>'),
    ],
    createdAt: 0,
    updatedAt: 0,
  }
  store.canvases.set(canvas.id, canvas)
  const server = buildMcpServer('Test Owner', 'test-owner-id')
  client = new Client({ name: 'prototype-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  close = async () => {
    await client.close()
    await server.close()
  }
})

afterEach(async () => {
  store.canvases.delete(canvas.id)
  await close()
})

function payload(result: Awaited<ReturnType<Client['callTool']>>) {
  const [first] = result.content as { type: string; text: string }[]
  return JSON.parse(first!.text) as Record<string, unknown>
}

it('lists interactions and flags targets that are not on the canvas', async () => {
  const result = await client.callTool({ name: 'get_prototype', arguments: { canvas_id: canvas.id, agent_name: 'A' } })
  const data = payload(result) as {
    pages: { id: string; startFrameId: string | null }[]
    interactions: { frameId: string; action: string; targetName?: string | null; problem?: string }[]
  }
  expect(data.pages.map((p) => p.startFrameId)).toEqual(['home', 'other'])
  expect(data.interactions).toEqual([
    expect.objectContaining({ frameId: 'home', action: 'navigate:detail', targetName: 'DETAIL' }),
    expect.objectContaining({ frameId: 'detail', action: 'overlay:ghost', targetName: null }),
  ])
  expect(data.interactions[0]!.problem).toBeUndefined()
  expect(data.interactions[1]!.problem).toContain('ghost')
})

it('sets the flow start, validating the frame and its page', async () => {
  const unknown = await client.callTool({
    name: 'set_prototype_start',
    arguments: { canvas_id: canvas.id, frame_id: 'nope', agent_name: 'A' },
  })
  expect(unknown.isError).toBe(true)
  expect(JSON.stringify(unknown)).toContain('no frame nope')

  const wrongPage = await client.callTool({
    name: 'set_prototype_start',
    arguments: { canvas_id: canvas.id, pageId: 'two', frame_id: 'detail', agent_name: 'A' },
  })
  expect(wrongPage.isError).toBe(true)

  const ok = await client.callTool({
    name: 'set_prototype_start',
    arguments: { canvas_id: canvas.id, frame_id: 'detail', agent_name: 'A' },
  })
  expect(ok.isError, JSON.stringify(ok)).toBeFalsy()
  expect(canvas.pages![0]).toEqual({ id: 'one', name: 'One', startFrameId: 'detail' })

  /* a page-list save (rename) keeps the start; only the start tool moves it */
  await client.callTool({
    name: 'set_canvas_pages',
    arguments: {
      canvas_id: canvas.id,
      expectedPages: [
        { id: 'one', name: 'One' },
        { id: 'two', name: 'Two' },
      ],
      pages: [
        { id: 'one', name: 'Renamed' },
        { id: 'two', name: 'Two' },
      ],
      agent_name: 'A',
    },
  })
  expect(canvas.pages![0]).toEqual({ id: 'one', name: 'Renamed', startFrameId: 'detail' })

  await client.callTool({
    name: 'set_prototype_start',
    arguments: { canvas_id: canvas.id, pageId: 'one', frame_id: null, agent_name: 'A' },
  })
  expect(canvas.pages![0]).toEqual({ id: 'one', name: 'Renamed' })
})
