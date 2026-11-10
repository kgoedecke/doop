import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { Canvas, Frame } from '../shared/types'

const mocks = vi.hoisted(() => ({ renderFrame: vi.fn() }))
vi.mock('../server/screenshot.ts', () => ({ renderFrame: mocks.renderFrame }))
vi.mock('../server/db/persist.ts', async (original) => ({
  ...(await original<typeof import('../server/db/persist.ts')>()),
  saveFrame: vi.fn(),
}))
vi.mock('../server/auth.ts', async (original) => ({
  ...(await original<typeof import('../server/auth.ts')>()),
  isBanned: async () => false,
}))

import { buildMcpServer } from '../server/mcp.ts'
import { getImage } from '../server/previews.ts'
import { store } from '../server/store.ts'
import { frameReadScope } from '../server/privateResources.ts'

const ownerId = 'test-owner-id'
const canvasId = 'shot-canvas'
const reader = { actorId: ownerId, currentActor: async () => ownerId }
let frame: Frame
let firstPng: Buffer
let freshPng: Buffer

beforeEach(async () => {
  firstPng = await sharp({ create: { width: 400, height: 300, channels: 4, background: 'green' } })
    .png()
    .toBuffer()
  freshPng = await sharp({ create: { width: 400, height: 300, channels: 4, background: 'red' } })
    .png()
    .toBuffer()
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
  store.init([canvas])
  mocks.renderFrame.mockReset()
})

async function screenshot() {
  const server = buildMcpServer('Test Owner', ownerId, undefined, undefined, reader)
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

const request = () => ({
  ext: 'png' as const,
  scale: 1 as const,
  quality: 90,
  preview: false,
  scope: frameReadScope(reader, frame),
})

it('primes the image cache so the preview card’s load is a free cached serve', async () => {
  mocks.renderFrame.mockResolvedValue(firstPng)
  const result = await screenshot()
  expect(result.isError).toBeFalsy()
  expect(await getImage(frame, request())).toEqual({ status: 'ok', buf: firstPng })
  expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
})

it('never files a screenshot under an edit that landed while it rendered', async () => {
  mocks.renderFrame.mockImplementationOnce(async () => {
    /* a collaborator edits the frame while Chromium is still rendering the old HTML */
    frame.html = '<p>two</p>'
    frame.updatedAt = 2
    return firstPng
  })
  mocks.renderFrame.mockResolvedValue(freshPng)
  await screenshot()
  expect(await getImage(frame, request())).toEqual({ status: 'ok', buf: freshPng })
  expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
})
