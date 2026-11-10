import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Canvas, ServerMessage } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let alice: Client
let bob: Client

beforeAll(async () => {
  server = await startServer()
  alice = await new Client(server).signUp('alice-switch@test.dev', 'Alice Switch')
  bob = await new Client(server).signUp('bob-switch@test.dev', 'Bob Switch')
}, 60_000)

afterAll(() => server?.stop())

describe('WebSocket room switching', () => {
  it('broadcasts presence:leave to the previous room when a connection joins a different canvas', async () => {
    const canvas1: Canvas = await (await alice.post('/api/canvases', { name: 'Room Switch 1' })).json()
    const canvas2: Canvas = await (await alice.post('/api/canvases', { name: 'Room Switch 2' })).json()

    await alice.post(`/api/canvases/${canvas1.id}/members`, { email: 'bob-switch@test.dev' })
    await alice.post(`/api/canvases/${canvas2.id}/members`, { email: 'bob-switch@test.dev' })

    const bobWs = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: bob.header() } })
    const bobMessages: ServerMessage[] = []
    bobWs.on('message', (d) => bobMessages.push(JSON.parse(String(d))))

    const aliceWs = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: alice.header() } })
    const aliceMessages: ServerMessage[] = []
    aliceWs.on('message', (d) => aliceMessages.push(JSON.parse(String(d))))

    try {
      await Promise.all([
        new Promise<void>((resolve) => bobWs.once('open', resolve)),
        new Promise<void>((resolve) => aliceWs.once('open', resolve)),
      ])

      bobWs.send(JSON.stringify({ type: 'join', canvasId: canvas1.id, clientId: 'bob-tab', name: 'Bob', kind: 'user' }))
      await expect.poll(() => bobMessages.some((m) => m.type === 'init')).toBe(true)

      aliceWs.send(
        JSON.stringify({ type: 'join', canvasId: canvas1.id, clientId: 'alice-tab', name: 'Alice', kind: 'user' }),
      )
      await expect.poll(() => aliceMessages.some((m) => m.type === 'init')).toBe(true)

      await expect
        .poll(() =>
          bobMessages.some(
            (m) =>
              m.type === 'presence:join' &&
              (m as { presence: { clientId: string } }).presence.clientId === 'alice-tab',
          ),
        )
        .toBe(true)

      // Alice switches to canvas 2 over the same WebSocket connection
      aliceWs.send(
        JSON.stringify({ type: 'join', canvasId: canvas2.id, clientId: 'alice-tab', name: 'Alice', kind: 'user' }),
      )
      await expect
        .poll(() => aliceMessages.some((m) => m.type === 'init' && (m as { canvas: Canvas }).canvas.id === canvas2.id))
        .toBe(true)

      // Bob in canvas 1 must receive presence:leave for Alice
      await expect
        .poll(() =>
          bobMessages.some((m) => m.type === 'presence:leave' && (m as { clientId: string }).clientId === 'alice-tab'),
        )
        .toBe(true)
    } finally {
      bobWs.close()
      aliceWs.close()
    }
  })

  it('handles back-to-back overlapping joins without leaving ghost presences', async () => {
    const canvas1: Canvas = await (await alice.post('/api/canvases', { name: 'Overlap 1' })).json()
    const canvas2: Canvas = await (await alice.post('/api/canvases', { name: 'Overlap 2' })).json()

    await alice.post(`/api/canvases/${canvas1.id}/members`, { email: 'bob-switch@test.dev' })
    await alice.post(`/api/canvases/${canvas2.id}/members`, { email: 'bob-switch@test.dev' })

    const bobWs = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: bob.header() } })
    const bobMessages: ServerMessage[] = []
    bobWs.on('message', (d) => bobMessages.push(JSON.parse(String(d))))

    const aliceWs = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: alice.header() } })
    const aliceMessages: ServerMessage[] = []
    aliceWs.on('message', (d) => aliceMessages.push(JSON.parse(String(d))))

    try {
      await Promise.all([
        new Promise<void>((resolve) => bobWs.once('open', resolve)),
        new Promise<void>((resolve) => aliceWs.once('open', resolve)),
      ])

      bobWs.send(JSON.stringify({ type: 'join', canvasId: canvas1.id, clientId: 'bob-tab', name: 'Bob', kind: 'user' }))
      await expect.poll(() => bobMessages.some((m) => m.type === 'init')).toBe(true)

      // Alice sends back-to-back joins without waiting between them
      aliceWs.send(
        JSON.stringify({ type: 'join', canvasId: canvas1.id, clientId: 'alice-tab', name: 'Alice', kind: 'user' }),
      )
      aliceWs.send(
        JSON.stringify({ type: 'join', canvasId: canvas2.id, clientId: 'alice-tab', name: 'Alice', kind: 'user' }),
      )

      // Alice receives init for canvas 2
      await expect
        .poll(() => aliceMessages.some((m) => m.type === 'init' && (m as { canvas: Canvas }).canvas.id === canvas2.id))
        .toBe(true)

      // Bob in canvas 1 sees Alice join and then leave canvas 1
      await expect
        .poll(() =>
          bobMessages.some(
            (m) =>
              m.type === 'presence:join' &&
              (m as { presence: { clientId: string } }).presence.clientId === 'alice-tab',
          ),
        )
        .toBe(true)

      await expect
        .poll(() =>
          bobMessages.some((m) => m.type === 'presence:leave' && (m as { clientId: string }).clientId === 'alice-tab'),
        )
        .toBe(true)
    } finally {
      bobWs.close()
      aliceWs.close()
    }
  })
})
