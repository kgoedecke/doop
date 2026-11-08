import { beforeAll, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import * as t from '../server/db/schema.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { describeFrameList } from '../server/resident.ts'
import { store } from '../server/store.ts'
import type { Frame } from '../shared/types.ts'

/**
 * What agents read: get_canvas and get_frame list each frame's images with
 * their descriptions, say once how to treat them, and the resident kickoff's
 * frame list quotes the same text under the frame.
 */

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return { db: drizzle(new PGlite(), { schema }) }
})
vi.mock('../server/db/persist.ts', () => ({ saveCanvas: () => {}, saveFrame: () => {}, saveActivity: () => {} }))

const CANVAS = 'mcp-images'
const frame = (id: string, name: string, html: string): Frame => ({
  id,
  canvasId: CANVAS,
  name,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  html,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
})
const shot = frame(
  'shot',
  'Screenshot 2026-11-03.png',
  '<!doctype html><html><body data-doop-canvas-element="true"><img data-doop-drawing="image" src="/a/pic1.png" alt="Screenshot 2026-11-03.png"></body></html>',
)
const design = frame('design', 'Hero', '<!doctype html><html><body><h1>Hello</h1></body></html>')

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
  const asset = { canvasId: CANVAS, size: 10, uploadedBy: 'alice', createdAt: 0 }
  await db.insert(t.assets).values([
    { id: 'pic1', mime: 'image/png', ext: 'png', description: 'A checkout page with a blue Pay button.', ...asset },
    { id: 'pic2', mime: 'image/jpeg', ext: 'jpg', ...asset },
  ])
  await db.insert(t.assetRefs).values([
    { assetId: 'pic1', frameId: 'shot' },
    { assetId: 'pic2', frameId: 'shot' },
  ])
  /* init, not canvases.set: get_frame looks frames up through the store's index */
  store.init([
    {
      id: CANVAS,
      ownerId: 'owner',
      name: 'Shots',
      pages: [{ id: 'p1', name: 'Page 1' }],
      frames: [shot, design],
      createdAt: 0,
      updatedAt: 0,
    },
  ])
}, 30_000)

async function connect() {
  const server = buildMcpServer('Owner', 'owner')
  const client = new Client({ name: 'images-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  await client.connect(a)
  return client
}

const parse = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as { type: string; text: string }[]).find((c) => c.type === 'text')!.text)

it('get_canvas lists a frame’s images, pending ones included, and says how to treat them', async () => {
  const client = await connect()
  const body = parse(await client.callTool({ name: 'get_canvas', arguments: { canvas_id: CANVAS } }))
  const frames = body.frames as { id: string; images?: unknown }[]
  expect(frames.find((f) => f.id === 'shot')!.images).toEqual([
    { src: '/a/pic1.png', description: 'A checkout page with a blue Pay button.' },
    { src: '/a/pic2.jpg', description: null },
  ])
  expect(frames.find((f) => f.id === 'design')).not.toHaveProperty('images')
  expect(body.note).toContain('Frames with `images`')
  await client.close()
})

it('get_frame carries the same images beside the HTML', async () => {
  const client = await connect()
  const body = parse(await client.callTool({ name: 'get_frame', arguments: { frame_id: 'shot' } }))
  expect(body.images).toHaveLength(2)
  expect(body.html).toContain('/a/pic1.png')
  const plain = parse(await client.callTool({ name: 'get_frame', arguments: { frame_id: 'design' } }))
  expect(plain).not.toHaveProperty('images')
  await client.close()
})

it('the kickoff quotes each image under its frame and labels a pasted image', () => {
  const images = new Map([['shot', [{ src: '/a/pic1.png', description: 'A checkout page with a blue Pay button.' }]]])
  const text = describeFrameList([shot, design], images)
  expect(text).toContain('name="Screenshot 2026-11-03.png" (pasted image)')
  expect(text).toContain('    image /a/pic1.png: A checkout page with a blue Pay button.')
  expect(text).toContain('name="Hero", 400x300')
  expect(text).toMatch(
    /A frame marked \(pasted image\) is a reference .* A design that uses images is an ordinary frame\.$/,
  )
  expect(describeFrameList([design], new Map())).not.toContain('screenshot_frame')
})

it.each([
  '<article><h1>Buy now</h1><img src="/a/pic1.png"></article>',
  '<img data-doop-drawing="image" src="/a/pic1.png"><h1>Buy now</h1>',
  'Buy now<img data-doop-drawing="image" src="/a/pic1.png">',
])('does not mark an editable design as a pasted reference: %s', (content) => {
  const card = frame('card', 'Product card', `<html><body data-doop-canvas-element="true">${content}</body></html>`)
  const text = describeFrameList([card], new Map([['card', [{ src: '/a/pic1.png', description: 'A product photo.' }]]]))
  expect(text).not.toContain('name="Product card" (pasted image)')
})
