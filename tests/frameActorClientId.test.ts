import { afterAll, beforeAll, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Canvas, Frame, ServerMessage } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('actor-tab@test.dev', 'Tab Owner')
}, 60_000)

afterAll(() => server?.stop())

/* A REST write carries the browser tab's presence token, so the room can
   tell the tab's own saves from everyone else's: the client only flashes
   a frame for an actor whose clientId is not its own. The name still
   comes from the account, never from the body. */
it('keeps the tab client id on a REST write and takes the name from the account', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Tabs' })).json()
  const frame: Frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Card', html: '<p>Card</p>' })
  ).json()
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  const messages: ServerMessage[] = []
  ws.on('message', (data) => messages.push(JSON.parse(String(data))))
  try {
    await new Promise<void>((resolve) => ws.once('open', resolve))
    ws.send(JSON.stringify({ type: 'join', canvasId: canvas.id, clientId: 'tab-a', name: 'Tab Owner', kind: 'user' }))
    await expect.poll(() => messages.some((m) => m.type === 'init')).toBe(true)
    const response = await owner.patch(`/api/frames/${frame.id}`, {
      x: 300,
      actor: { clientId: 'tab-a', name: 'Forged name', kind: 'agent' },
    })
    expect(response.status).toBe(200)
    await expect
      .poll(() => messages.find((m) => m.type === 'frame:updated' && m.frame.id === frame.id))
      .toMatchObject({ actor: { clientId: 'tab-a', name: 'Tab Owner', kind: 'user' } })
    /* a body without a token (an older client, a script) still works */
    expect((await owner.patch(`/api/frames/${frame.id}`, { x: 310 })).status).toBe(200)
    await expect
      .poll(() => messages.filter((m) => m.type === 'frame:updated' && m.frame.id === frame.id).length)
      .toBe(2)
    const second = messages.filter((m) => m.type === 'frame:updated' && m.frame.id === frame.id)[1]
    expect(second).toMatchObject({ actor: { name: 'Tab Owner', kind: 'user' } })
    expect((second as { actor: { clientId?: string } }).actor.clientId).toBeUndefined()
  } finally {
    ws.close()
  }
})
