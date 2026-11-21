import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import WebSocket from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let canvasId: string
let frame: { id: string; html: string }

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('room-compression@test.dev', 'Room Owner')
  const canvas = await (await owner.post('/api/canvases', { name: 'Compression' })).json()
  canvasId = canvas.id
  const html = '<main>' + '<p>A paragraph on the canvas.</p>'.repeat(1000) + '</main>'
  frame = await (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Article', html })).json()
}, 60_000)
afterAll(() => server?.stop())

it.each([true, false])('delivers the full room init with perMessageDeflate=%s', async (perMessageDeflate) => {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, {
    perMessageDeflate,
    headers: { Cookie: owner.header() },
  })
  try {
    const [[response]] = await Promise.all([once(ws, 'upgrade'), once(ws, 'open')])
    const { socket } = response as IncomingMessage
    const before = socket.bytesRead
    const message = once(ws, 'message')
    ws.send(JSON.stringify({ type: 'join', canvasId, clientId: 'reader', kind: 'user', name: 'Reader' }))
    const [data] = await message
    expect(JSON.parse(String(data))).toMatchObject({
      type: 'init',
      canvas: { frames: [{ id: frame.id, html: frame.html }] },
    })
    expect(ws.extensions).toBe(perMessageDeflate ? 'permessage-deflate' : '')
    const received = socket.bytesRead - before
    const decoded = Buffer.byteLength(data)
    if (perMessageDeflate) expect(received).toBeLessThan(decoded)
    else expect(received).toBeGreaterThanOrEqual(decoded)
  } finally {
    ws.close()
  }
})
