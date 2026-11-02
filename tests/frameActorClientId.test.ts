import { afterAll, beforeAll, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Canvas, Frame } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('actor-tab@test.dev', 'Tab Owner')
}, 60_000)

afterAll(() => server?.stop())

type FrameChange = { type: 'frame-change'; frame: Frame; actor: { name: string; kind: string; clientId?: string } }

/* A REST write carries the browser tab's presence token, so the tab can
   tell its own saves from everyone else's: the client only flashes a frame
   for an actor whose clientId is not its own. The name still comes from the
   account, never from the body. Frame changes reach browsers from the frame
   actor, so this subscribes the way a browser does: an actor ticket from the
   app, then the actor's own WebSocket. */
it('keeps the tab client id on a REST write and takes the name from the account', async () => {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Tabs' })).json()
  const frame: Frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Card', html: '<p>Card</p>' })
  ).json()
  const grant = (await (await owner.get(`/api/frames/${frame.id}/actor?clientId=tab-a`)).json()) as {
    websocketUrl: string
  }
  const ws = new WebSocket(grant.websocketUrl)
  const changes: FrameChange[] = []
  ws.on('message', (data) => {
    const event = JSON.parse(String(data)) as { type: string; changes?: { committed?: FrameChange } }
    const change = event.type === 'state_update' ? event.changes?.committed : undefined
    if (change?.type === 'frame-change') changes.push(change)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const response = await owner.patch(`/api/frames/${frame.id}`, {
      x: 300,
      actor: { clientId: 'tab-a', name: 'Forged name', kind: 'agent' },
    })
    expect(response.status).toBe(200)
    await expect
      .poll(() => changes.find((change) => change.frame.x === 300))
      .toMatchObject({ actor: { clientId: 'tab-a', name: 'Tab Owner', kind: 'user' } })
    /* a body without a token (an older client, a script) still works */
    expect((await owner.patch(`/api/frames/${frame.id}`, { x: 310 })).status).toBe(200)
    await expect.poll(() => changes.find((change) => change.frame.x === 310)).toBeTruthy()
    const second = changes.find((change) => change.frame.x === 310)!
    expect(second).toMatchObject({ actor: { name: 'Tab Owner', kind: 'user' } })
    expect(second.actor.clientId).toBeUndefined()
  } finally {
    ws.close()
  }
})
