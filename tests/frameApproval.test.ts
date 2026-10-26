import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import WebSocket from 'ws'
import type { Canvas, Frame, ServerMessage } from '../shared/types'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let owner: Client
let stranger: Client
let agent: McpClient

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('approval@test.dev', 'Review Owner')
  stranger = await new Client(server).signUp('approval-stranger@test.dev', 'Stranger')
  const { secret } = await (await owner.post('/api/agent-keys', { name: 'Implementation agent' })).json()
  agent = new McpClient({ name: 'approval-test', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
}, 60_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
})

async function create() {
  const canvas: Canvas = await (await owner.post('/api/canvases', { name: 'Handoff' })).json()
  const frame: Frame = await (
    await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Checkout', html: '<h1>Checkout</h1>' })
  ).json()
  return { canvas, frame }
}

function approval(frame: Frame, status = 'ready_for_dev', client = owner, extra = {}) {
  return client.req(`/api/frames/${frame.id}/approval`, {
    method: 'PUT',
    body: JSON.stringify({ status, expectedUpdatedAt: frame.updatedAt, ...extra }),
  })
}

async function approve(frame: Frame): Promise<Frame> {
  const response = await approval(frame)
  expect(response.status, await response.clone().text()).toBe(200)
  return response.json()
}

async function read(frame: Frame): Promise<Frame> {
  const canvas: Canvas = await (await owner.get(`/api/canvases/${frame.canvasId}`)).json()
  return canvas.frames.find((f) => f.id === frame.id)!
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await agent.callTool({ name, arguments: args })
  expect(result.isError).toBeFalsy()
  const content = result.content as { type: string; text?: string }[]
  return JSON.parse(content.find((item) => item.type === 'text')!.text!)
}

it('attributes approvals to the signed-in person, broadcasts them and records activity', async () => {
  const { canvas, frame } = await create()
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
  const messages: ServerMessage[] = []
  ws.on('message', (data) => messages.push(JSON.parse(String(data))))
  try {
    await new Promise<void>((resolve) => ws.once('open', resolve))
    ws.send(
      JSON.stringify({
        type: 'join',
        canvasId: canvas.id,
        clientId: 'review-test',
        name: 'Review Owner',
        kind: 'user',
      }),
    )
    await expect.poll(() => messages.some((m) => m.type === 'init')).toBe(true)
    const response = await approval(frame, 'ready_for_dev', owner, {
      approvedBy: 'Forged reviewer',
      actor: { name: 'Forged reviewer' },
    })
    expect(response.status).toBe(200)
    const approved: Frame = await response.json()
    expect(approved.approval).toEqual({
      status: 'ready_for_dev',
      approvedBy: 'Review Owner',
      approvedByUserId: canvas.ownerId,
      approvedAt: expect.any(Number),
      approvedFrameUpdatedAt: frame.updatedAt,
    })
    expect((await read(frame)).approval).toEqual(approved.approval)
    await expect
      .poll(() => messages.some((m) => m.type === 'frame:updated' && m.frame.approval?.status === 'ready_for_dev'))
      .toBe(true)
    await expect
      .poll(() => messages.some((m) => m.type === 'activity' && m.item.message.includes('ready for dev')))
      .toBe(true)
    const draft: Frame = await (await approval(approved, 'draft')).json()
    expect(draft.approval).toBeNull()
  } finally {
    ws.close()
  }
})

it('checks access, input and the exact revision before accepting approval', async () => {
  const { frame } = await create()
  expect((await approval(frame, 'ready_for_dev', stranger)).status).toBe(403)
  expect((await approval(frame, 'ready_for_dev', new Client(server))).status).toBe(401)
  expect((await approval(frame, 'needs_review')).status).toBe(400)
  for (const expectedUpdatedAt of [undefined, null, -1, 'invalid']) {
    expect((await approval(frame, 'ready_for_dev', owner, { expectedUpdatedAt })).status).toBe(400)
  }
  await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>New design</h1>' })
  expect((await approval(frame)).status).toBe(409)
  expect((await read(frame)).approval).toBeFalsy()
  const current = await approve(await read(frame))
  expect((await approval(frame, 'draft')).status).toBe(409)
  expect((await read(frame)).approval).toEqual(current.approval)
})

it.each([{ html: '<p>Updated design</p>' }, { width: 800 }, { height: 600 }])(
  'requires another review after a design edit: %j',
  async (patch) => {
    const { frame } = await create()
    const approved = await approve(frame)
    const edited: Frame = await (await owner.patch(`/api/frames/${frame.id}`, patch)).json()
    expect(edited.approval).toEqual({ ...approved.approval, status: 'needs_review' })
    const again = await approve(edited)
    expect(again.approval).toMatchObject({ status: 'ready_for_dev', approvedFrameUpdatedAt: edited.updatedAt })
  },
)

it('preserves approval for organizational and no-op design edits, and ignores forged approval metadata', async () => {
  const { frame } = await create()
  const approved = await approve(frame)
  const edited: Frame = await (
    await owner.patch(`/api/frames/${frame.id}`, {
      name: 'Checkout final',
      x: 70,
      y: 40,
      hidden: true,
      locked: true,
      html: frame.html,
      width: frame.width,
      height: frame.height,
      approval: { status: 'ready_for_dev', approvedBy: 'Forged' },
    })
  ).json()
  expect(edited.approval).toEqual(approved.approval)
})

it('invalidates streamed edits and refuses approval until the stream finishes', async () => {
  const { frame } = await create()
  await approve(frame)
  await owner.post(`/api/frames/${frame.id}/append`, { html_chunk: '<h1>New', start: true })
  const streaming = await read(frame)
  expect(streaming.approval?.status).toBe('needs_review')
  expect((await approval(streaming)).status).toBe(409)
  await owner.post(`/api/frames/${frame.id}/append`, { html_chunk: ' design</h1>', done: true })
  await approve(await read(frame))
})

it('exposes approval to agents, filters implementation candidates, and invalidates agent edits', async () => {
  const { canvas, frame } = await create()
  await owner.post(`/api/canvases/${canvas.id}/frames`, { name: 'Draft screen' })
  expect((await callTool('get_frame', { frame_id: frame.id })).approvalStatus).toBe('draft')
  const approved = await approve(frame)
  const ready = await callTool('get_canvas', { canvas_id: canvas.id, approval_status: 'ready_for_dev' })
  expect(ready.frames).toHaveLength(1)
  expect(ready.frames[0]).toMatchObject({ id: frame.id, approvalStatus: 'ready_for_dev', approval: approved.approval })
  expect((await callTool('get_frame', { frame_id: frame.id })).approval).toEqual(approved.approval)
  await callTool('update_frame', { frame_id: frame.id, width: 900, agent_name: 'Implementer' })
  expect((await callTool('get_canvas', { canvas_id: canvas.id, approval_status: 'ready_for_dev' })).frames).toEqual([])
  expect((await callTool('get_frame', { frame_id: frame.id })).approvalStatus).toBe('needs_review')
  expect((await callTool('get_canvas', { canvas_id: canvas.id, approval_status: 'draft' })).frames).toHaveLength(1)
  expect((await callTool('get_canvas', { canvas_id: canvas.id, approval_status: 'needs_review' })).frames).toHaveLength(
    1,
  )
})

it('copies approved screens as drafts on duplicated pages and canvases', async () => {
  const { canvas, frame } = await create()
  await approve(frame)
  const pageCopy = await (await owner.post(`/api/canvases/${canvas.id}/pages/${frame.pageId}/duplicate`)).json()
  expect(pageCopy.frames).toHaveLength(1)
  expect(pageCopy.frames[0].approval).toBeFalsy()
  const canvasCopy: Canvas = await (await owner.post(`/api/canvases/${canvas.id}/duplicate`)).json()
  expect(canvasCopy.frames.every((f) => !f.approval)).toBe(true)
  expect((await read(frame)).approval?.status).toBe('ready_for_dev')
})

it('requires another review when an earlier design is restored', async () => {
  const { frame } = await create()
  await owner.patch(`/api/frames/${frame.id}`, { html: '<main>A different screen</main>' })
  const versions = await (await owner.get(`/api/frames/${frame.id}/versions`)).json()
  expect(versions.length).toBeGreaterThan(0)
  await approve(await read(frame))
  const response = await owner.post(`/api/frames/${frame.id}/versions/${versions[0].id}/restore`)
  expect(response.status).toBe(200)
  const restored = await response.json()
  expect(restored.frame.html).toBe(frame.html)
  expect(restored.frame.approval.status).toBe('needs_review')
})

it('persists current approvals and stale approvals through a server restart', async () => {
  const { frame } = await create()
  const { frame: stale } = await create()
  const approved = await approve(frame)
  await approve(stale)
  await owner.patch(`/api/frames/${stale.id}`, { height: 900 })
  const dataDir = server.dataDir
  await agent.close()
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({}, dataDir)
  owner = new Client(server)
  await owner.post('/api/auth/sign-in/email', { email: 'approval@test.dev', password: 'password12345' })
  expect((await read(frame)).approval).toEqual(approved.approval)
  expect((await read(stale)).approval?.status).toBe('needs_review')
}, 60_000)
