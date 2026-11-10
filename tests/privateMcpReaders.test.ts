import { beforeEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CustomFont } from '../shared/fonts.ts'
const mocks = vi.hoisted(() => ({ flow: vi.fn(), library: vi.fn(), render: vi.fn() }))
vi.mock('../server/auth.ts', async (original) => ({
  ...(await original<typeof import('../server/auth.ts')>()),
  isBanned: async () => false,
}))
vi.mock('../server/db/persist.ts', async (original) => ({
  ...(await original<typeof import('../server/db/persist.ts')>()),
  saveFrame: vi.fn(),
}))
vi.mock('../server/ingest.ts', async (original) => ({
  ...(await original<typeof import('../server/ingest.ts')>()),
  getSyncFlow: mocks.flow,
}))
vi.mock('../server/fonts.ts', async (original) => ({
  ...(await original<typeof import('../server/fonts.ts')>()),
  fontsForCanvas: mocks.library,
}))
vi.mock('../server/screenshot.ts', () => ({ renderFrame: mocks.render, findBrowserPath: () => '/fixture-renderer' }))
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { ResourceReader } from '../server/privateResources.ts'
const actorId = 'private-mcp-reader'
const reader = { actorId, currentActor: async () => actorId }
const family = 'Private family marker'
async function connected<T>(scope: ResourceReader | undefined, run: (client: Client) => Promise<T>) {
  const server = buildMcpServer('Reader', actorId, undefined, undefined, scope)
  const client = new Client({ name: 'private-reader-fixture', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}
beforeEach(() => {
  store.init([
    {
      id: 'mcp-read-canvas',
      name: 'Private metadata',
      ownerId: actorId,
      frames: [
        {
          id: 'mcp-read-frame',
          canvasId: 'mcp-read-canvas',
          name: 'Frame',
          html: '<p>frame</p>',
          width: 80,
          height: 60,
          x: 0,
          y: 0,
          createdAt: 0,
          updatedAt: 0,
          updatedBy: actorId,
        },
      ],
      createdAt: 0,
      updatedAt: 0,
    },
  ])
  mocks.flow.mockReset().mockResolvedValue({ links: [], edges: [] })
  mocks.library.mockReset().mockReturnValue([
    {
      id: 'private-font-id',
      family,
      weight: '400',
      style: 'normal',
      format: 'woff2',
      url: '/a/private-font.woff2',
      fileName: 'private.woff2',
      size: 1024,
      createdAt: 0,
    } satisfies CustomFont,
  ])
  mocks.render.mockReset().mockResolvedValue(Buffer.from('private-pixels'))
})
it('a programmatic MCP factory without a current reader cannot read private font metadata or image bytes', async () => {
  await connected(undefined, async (client) => {
    const canvas = await client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'mcp-read-canvas' } })
    expect(canvas.isError, JSON.stringify(canvas)).toBeFalsy()
    expect(JSON.stringify(canvas)).not.toContain(family)
    expect(mocks.library).not.toHaveBeenCalled()
    const shot = await client.callTool({ name: 'get_frame_screenshot', arguments: { frame_id: 'mcp-read-frame' } })
    expect(shot.isError).toBe(true)
    expect(mocks.render).not.toHaveBeenCalled()
  })
})
it('a current private reader receives the scoped library as a positive control', async () => {
  const response = await connected(reader, (client) =>
    client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'mcp-read-canvas' } }),
  )
  expect(response.isError, JSON.stringify(response)).toBeFalsy()
  expect(JSON.stringify(response)).toContain(family)
  expect(mocks.library).toHaveBeenCalledTimes(1)
})
it('credential revocation during the real get_canvas async flow path denies already-read private metadata', async () => {
  let reached!: () => void
  let release!: () => void
  const arrived = new Promise<void>((resolve) => {
    reached = resolve
  })
  const resumed = new Promise<void>((resolve) => {
    release = resolve
  })
  mocks.flow.mockImplementation(async () => {
    reached()
    await resumed
    return { links: [], edges: [] }
  })
  let valid = true
  await connected({ actorId, currentActor: async () => (valid ? actorId : undefined) }, async (client) => {
    const pending = client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'mcp-read-canvas' } })
    try {
      await arrived
      expect(mocks.library).toHaveBeenCalledTimes(1)
      valid = false
      release()
      const response = await pending
      expect(response.isError).toBe(true)
      expect(response.content).toEqual([{ type: 'text', text: 'Error: Canvas read is unavailable' }])
      expect(JSON.stringify(response)).not.toContain(family)
      expect(JSON.stringify(response)).not.toContain('private-font')
    } finally {
      release()
      await pending
    }
  })
})

it('async private metadata failures expose neither driver SQL nor already-read font metadata', async () => {
  mocks.flow.mockRejectedValue(new Error('SELECT private_metadata WHERE credential=secret-synthetic-marker'))
  const response = await connected(reader, (client) =>
    client.callTool({ name: 'get_canvas', arguments: { canvas_id: 'mcp-read-canvas' } }),
  )
  expect(response.isError).toBe(true)
  expect(response.content).toEqual([{ type: 'text', text: 'Error: Canvas read is unavailable' }])
  expect(JSON.stringify(response)).not.toContain('secret-synthetic-marker')
  expect(JSON.stringify(response)).not.toContain(family)
})

it('rejects a foreign tool target before lazy loading its private canvas', async () => {
  const existing = store.getCanvas('mcp-read-canvas')!
  store.init([
    {
      ...existing,
      id: 'foreign-lazy-canvas',
      ownerId: 'another-owner',
      frames: existing.frames.map((frame) => ({ ...frame, id: 'foreign-lazy-frame', canvasId: 'foreign-lazy-canvas' })),
    },
  ])
  const load = vi.spyOn(store, 'load')
  try {
    await connected(reader, async (client) => {
      for (const call of [
        { name: 'get_canvas', arguments: { canvas_id: 'foreign-lazy-canvas' } },
        { name: 'get_frame', arguments: { frame_id: 'foreign-lazy-frame' } },
      ]) {
        const result = await client.callTool(call)
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result)).not.toContain('<p>frame</p>')
      }
    })
    expect(load).not.toHaveBeenCalled()
  } finally {
    load.mockRestore()
  }
})

it('rechecks tool-target authority after lazy loading and releases its hold on refusal', async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = store.load.bind(store)
  const canvas = store.getCanvas('mcp-read-canvas')!
  const load = vi.spyOn(store, 'load').mockImplementation(async (id) => {
    await wait
    return original(id)
  })
  try {
    await connected(reader, async (client) => {
      const pending = client.callTool({ name: 'get_frame', arguments: { frame_id: 'mcp-read-frame' } })
      await vi.waitFor(() => expect(load).toHaveBeenCalled())
      canvas.ownerId = 'revoked-owner'
      release()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).not.toContain('<p>frame</p>')
      expect(store.stats().held).toBe(0)
    })
  } finally {
    release()
    canvas.ownerId = actorId
    load.mockRestore()
  }
})
