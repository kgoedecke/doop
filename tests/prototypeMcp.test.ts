import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* SQL persistence is mocked: the tools' effect on the canvas (pages in the
   canvas actor, frames in their own actors) is the contract */
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveActivity: () => {},
  loadLegacyFrameIds: async () => [],
  legacyFrameCanvasId: async () => undefined,
}))

let canvas: Canvas
let frames: Record<'home' | 'detail' | 'other', Frame>
let client: Client
let close: () => Promise<void>

const pagesNow = () => store.getCanvasMetadata(canvas.id)!.pages!

beforeEach(async () => {
  canvas = {
    id: randomUUID(),
    ownerId: 'test-owner-id',
    name: 'Proto',
    pages: [
      { id: 'one', name: 'One' },
      { id: 'two', name: 'Two' },
    ],
    frames: [],
    createdAt: 0,
    updatedAt: 0,
  }
  store.init([canvas])
  const make = async (name: string, pageId: string) =>
    (await store.createFrame(canvas.id, { name, pageId, x: 0, y: 0, width: 100, height: 100 }, 'Test'))!
  const home = await make('HOME', 'one')
  const detail = await make('DETAIL', 'one')
  const other = await make('OTHER', 'two')
  frames = {
    home: (await store.updateFrame(
      home.id,
      { html: `<button data-doop-on="click" data-doop-action="navigate:${detail.id}">Open</button>` },
      'Test',
    ))!,
    detail: (await store.updateFrame(
      detail.id,
      { html: '<a data-doop-on="click" data-doop-action="overlay:ghost">Help</a>' },
      'Test',
    ))!,
    other: (await store.updateFrame(other.id, { html: '<p>elsewhere</p>' }, 'Test'))!,
  }
  await store.setFlowStart(canvas.id, 'one', home.id)
  await store.setFlowStart(canvas.id, 'two', other.id)
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
  expect(data.pages.map((p) => p.startFrameId)).toEqual([frames.home.id, frames.other.id])
  expect(data.interactions).toEqual([
    expect.objectContaining({ frameId: frames.home.id, action: `navigate:${frames.detail.id}`, targetName: 'DETAIL' }),
    expect.objectContaining({ frameId: frames.detail.id, action: 'overlay:ghost', targetName: null }),
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
    arguments: { canvas_id: canvas.id, pageId: 'two', frame_id: frames.detail.id, agent_name: 'A' },
  })
  expect(wrongPage.isError).toBe(true)

  const ok = await client.callTool({
    name: 'set_prototype_start',
    arguments: { canvas_id: canvas.id, frame_id: frames.detail.id, agent_name: 'A' },
  })
  expect(ok.isError, JSON.stringify(ok)).toBeFalsy()
  expect(pagesNow()[0]).toEqual({ id: 'one', name: 'One', startFrameId: frames.detail.id })

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
  expect(pagesNow()[0]).toEqual({ id: 'one', name: 'Renamed', startFrameId: frames.detail.id })

  await client.callTool({
    name: 'set_prototype_start',
    arguments: { canvas_id: canvas.id, pageId: 'one', frame_id: null, agent_name: 'A' },
  })
  expect(pagesNow()[0]).toEqual({ id: 'one', name: 'Renamed' })
})

it('paints a page through set_page_background and clears it again', async () => {
  const bad = await client.callTool({
    name: 'set_page_background',
    arguments: { canvas_id: canvas.id, page_id: 'two', color: 'red', agent_name: 'A' },
  })
  expect(bad.isError).toBe(true)
  const missing = await client.callTool({
    name: 'set_page_background',
    arguments: { canvas_id: canvas.id, page_id: 'nope', color: '#1e1e1e', agent_name: 'A' },
  })
  expect(missing.isError).toBe(true)
  const painted = await client.callTool({
    name: 'set_page_background',
    arguments: { canvas_id: canvas.id, page_id: 'two', color: '#1E1E1E', agent_name: 'A' },
  })
  /* the colour rides beside each page's flow start, which it leaves alone */
  expect(payload(painted).pages).toEqual([
    { id: 'one', name: 'One', startFrameId: frames.home.id },
    { id: 'two', name: 'Two', background: '#1e1e1e', startFrameId: frames.other.id },
  ])
  const cleared = await client.callTool({
    name: 'set_page_background',
    arguments: { canvas_id: canvas.id, color: null, agent_name: 'A' },
  })
  /* no page_id means the first page, which had no colour: a no-op there */
  expect(payload(cleared).pages).toEqual([
    { id: 'one', name: 'One', startFrameId: frames.home.id },
    { id: 'two', name: 'Two', background: '#1e1e1e', startFrameId: frames.other.id },
  ])
})
