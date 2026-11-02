import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({ renderFrame: vi.fn() }))
vi.mock('../server/screenshot.ts', () => ({ renderFrame: mocks.renderFrame }))

import { buildMcpServer } from '../server/mcp.ts'
import { getImage } from '../server/previews.ts'
import { store } from '../server/store.ts'

const ownerId = 'test-owner-id'
const canvasId = 'shot-canvas'
let frame: Frame

beforeEach(() => {
  frame = {
    id: 'shot-frame',
    canvasId,
    name: 'Hero',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    html: '<p>one</p>',
    updatedAt: 1,
    updatedBy: ownerId,
  } as Frame
  const canvas: Canvas = { id: canvasId, ownerId, name: 'Shots', frames: [frame], createdAt: 0, updatedAt: 0 }
  /* the frame as its actor would answer now: the test edits it mid-render */
  vi.restoreAllMocks()
  vi.spyOn(store, 'getCanvasMetadata').mockImplementation((id) => (id === canvasId ? canvas : undefined))
  vi.spyOn(store, 'syncCanvas').mockImplementation(async (id) => (id === canvasId ? canvas : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation(async (id) => (id === frame.id ? frame : undefined))
  vi.spyOn(store, 'getFrameMembership').mockImplementation(async (id) =>
    id === frame.id ? { id, canvasId } : undefined,
  )
  mocks.renderFrame.mockReset()
})

async function screenshot() {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'screenshot-cache-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  try {
    return await client.callTool({
      name: 'get_frame_screenshot',
      arguments: { frame_id: frame.id, agent_name: 'Agent' },
    })
  } finally {
    await client.close()
    await server.close()
  }
}

const request = (ip: string) => ({
  ext: 'png' as const,
  scale: 1 as const,
  quality: 90,
  preview: false,
  ip,
  isAuthenticated: () => Promise.resolve(false),
})

it('primes the image cache so the preview card’s load is a free cached serve', async () => {
  mocks.renderFrame.mockResolvedValue(Buffer.from('first'))
  const result = await screenshot()
  expect(result.isError).toBeFalsy()
  expect(await getImage(frame, request('ip-a'))).toEqual({ status: 'ok', buf: Buffer.from('first') })
  expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
})

it('never files a screenshot under an edit that landed while it rendered', async () => {
  mocks.renderFrame.mockImplementationOnce(async () => {
    /* a collaborator edits the frame while Chromium is still rendering the old HTML */
    frame.html = '<p>two</p>'
    frame.updatedAt = 2
    return Buffer.from('stale')
  })
  mocks.renderFrame.mockResolvedValue(Buffer.from('fresh'))
  await screenshot()
  expect(await getImage(frame, request('ip-b'))).toEqual({ status: 'ok', buf: Buffer.from('fresh') })
  expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
})
