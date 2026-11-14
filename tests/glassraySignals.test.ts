import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Canvas, Frame } from '../shared/types.ts'
import { Client, startServer, type Server } from './harness.ts'
import { startGlassraySink, type GlassraySink } from './glassraySink.ts'

/**
 * What Glassray hears when a person reacts to an agent's work: one signal per
 * reaction, on the canvas it happened on, naming the person — and silence
 * when the same action lands on a design no agent touched.
 *
 * The suite's servers are real child processes, so the signals are collected
 * by a stand-in Glassray (tests/glassraySink.ts) the server is pointed at.
 */

let sink: GlassraySink
let server: Server
let user: Client
let userId: string
let agent: McpClient

let canvasId: string

beforeAll(async () => {
  sink = await startGlassraySink()
  server = await startServer({
    GLASSRAY_API_KEY: 'gr_test',
    GLASSRAY_ENDPOINT: sink.origin,
    RESIDENT_TASK_LIMIT: '100',
  })
  user = await new Client(server).signUp('glassray-signals@test.dev', 'Glassray Person')
  userId = (await (await user.get('/api/me')).json()).id
  const { secret } = await (await user.post('/api/agent-keys', { name: 'Signals agent' })).json()
  agent = new McpClient({ name: 'signals-test-client', version: '1.0.0' })
  await agent.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', server.base), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  canvasId = (await (await user.post('/api/canvases', { name: 'Signals' })).json()).id
}, 90_000)

afterAll(async () => {
  await agent?.close()
  server?.stop()
  await sink?.close()
})

beforeEach(() => sink.clear())

/* ------------------------------------------------------------------ */

/** A frame an agent drew, through the MCP server, as a real agent would. */
async function agentFrame(name: string, html = '<h1>Agent</h1>'): Promise<Frame> {
  const result = await agent.callTool({
    name: 'create_frame',
    arguments: { canvas_id: canvasId, name, html, agent_name: 'Tester' },
  })
  expect(result.isError).toBeFalsy()
  return frameNamed(name)
}

/** A frame the person drew themselves. */
async function humanFrame(name: string): Promise<Frame> {
  const res = await user.post(`/api/canvases/${canvasId}/frames`, { name, html: '<h1>Mine</h1>' })
  expect(res.status).toBe(200)
  return res.json()
}

async function frameNamed(name: string): Promise<Frame> {
  const canvas: Canvas = await (await user.get(`/api/canvases/${canvasId}`)).json()
  const frame = canvas.frames.find((f) => f.name === name)
  if (!frame) throw new Error(`no frame named ${name}`)
  return frame
}

/** An agent's one-shot write plays back to viewers for a beat; approval waits for it. */
async function settled(frameId: string): Promise<Frame> {
  for (let i = 0; i < 60; i++) {
    const fresh = (await (await user.get(`/api/canvases/${canvasId}`)).json()).frames.find(
      (f: Frame) => f.id === frameId,
    )
    const res = await user.put(`/api/frames/${frameId}/approval`, {
      status: 'ready_for_dev',
      expectedUpdatedAt: fresh.updatedAt,
    })
    if (res.status !== 409) {
      expect(res.status).toBe(200)
      return res.json()
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('the frame never stopped streaming')
}

const onCanvas = (kind: string) => (s: { source: string; kind: string; work_item?: unknown }) =>
  s.source === 'user' &&
  s.kind === kind &&
  JSON.stringify(s.work_item) === JSON.stringify({ type: 'canvas', id: canvasId })

/* ------------------------------------------------------------------ */

it('reports a person rewriting what an agent just drew, and stays quiet on their own frame', async () => {
  const mine = await humanFrame('Mine to rewrite')
  await user.patch(`/api/frames/${mine.id}`, { html: '<h1>Changed my mind</h1>' })
  await sink.expectNone(onCanvas('replaced_agent_work'))

  const theirs = await agentFrame('Agent to rewrite')
  expect((await user.patch(`/api/frames/${theirs.id}`, { html: '<h1>Not like that</h1>' })).status).toBe(200)

  const [signal, ...rest] = await sink.waitFor(onCanvas('replaced_agent_work'))
  expect(rest).toEqual([])
  expect(signal?.refs?.user).toBe(userId)
  expect(signal?.context).toMatchObject({ frame: theirs.id, frame_name: 'Agent to rewrite', agent: 'Tester' })
}, 60_000)

it('reports a person deleting an agent`s frame, and stays quiet on their own', async () => {
  const mine = await humanFrame('Mine to delete')
  await user.delete(`/api/frames/${mine.id}`)
  await sink.expectNone(onCanvas('deleted_agent_work'))

  const theirs = await agentFrame('Agent to delete')
  expect((await user.delete(`/api/frames/${theirs.id}`)).status).toBe(200)

  const [signal, ...rest] = await sink.waitFor(onCanvas('deleted_agent_work'))
  expect(rest).toEqual([])
  expect(signal?.refs?.user).toBe(userId)
  expect(signal?.context).toMatchObject({ frame: theirs.id, agent: 'Tester' })
}, 60_000)

it('reports a person putting an earlier version back over an agent`s work', async () => {
  const frame = await agentFrame('Agent to revert', '<h1>First</h1>')
  const edit = await agent.callTool({
    name: 'set_frame_html',
    arguments: { frame_id: frame.id, html: '<h1>Second</h1>', agent_name: 'Tester' },
  })
  expect(edit.isError).toBeFalsy()
  sink.clear()

  const versions = await (await user.get(`/api/frames/${frame.id}/versions`)).json()
  expect(versions.length).toBeGreaterThan(0)
  const res = await user.post(`/api/frames/${frame.id}/versions/${versions[0].id}/restore`)
  expect(res.status).toBe(200)

  const [signal, ...rest] = await sink.waitFor(onCanvas('revert'))
  expect(rest).toEqual([])
  expect(signal?.refs?.user).toBe(userId)
  expect(signal?.context).toMatchObject({ frame: frame.id, agent: 'Tester' })
}, 60_000)

it('reports a person signing an agent`s design off, and sending it back', async () => {
  const frame = await agentFrame('Agent to approve')
  const approved = await settled(frame.id)

  const [signed, ...more] = await sink.waitFor(onCanvas('ready_for_dev'))
  expect(more).toEqual([])
  expect(signed?.refs?.user).toBe(userId)
  expect(signed?.context).toMatchObject({ frame: frame.id, agent: 'Tester' })

  /* signing off twice is not a second reaction */
  sink.clear()
  await user.put(`/api/frames/${frame.id}/approval`, {
    status: 'ready_for_dev',
    expectedUpdatedAt: approved.updatedAt,
  })
  await sink.expectNone(onCanvas('ready_for_dev'))

  const back = await user.put(`/api/frames/${frame.id}/approval`, {
    status: 'draft',
    expectedUpdatedAt: approved.updatedAt,
  })
  expect(back.status).toBe(200)
  const [returned] = await sink.waitFor(onCanvas('needs_review'))
  expect(returned?.refs?.user).toBe(userId)
}, 90_000)

it('reports a person writing back to an agent on its task card', async () => {
  const card = await (await user.post(`/api/canvases/${canvasId}/cards`, { title: 'Design a pricing page' })).json()
  sink.clear()

  const res = await user.post(`/api/tasks/${card.id}/feedback`, { text: 'No, rounder corners' })
  expect(res.status).toBe(200)

  const [signal, ...rest] = await sink.waitFor(onCanvas('correction'))
  expect(rest).toEqual([])
  expect(signal?.message).toBe('No, rounder corners')
  expect(signal?.refs?.user).toBe(userId)
}, 60_000)

it('reports a person asking for another go, and stopping an agent mid-task', async () => {
  const card = await (await user.post(`/api/canvases/${canvasId}/cards`, { title: 'Retry me' })).json()
  sink.clear()
  expect((await user.post(`/api/canvases/${canvasId}/cards/${card.id}/stop`)).status).toBe(200)
  const [stopped] = await sink.waitFor(onCanvas('abandon'))
  expect(stopped?.refs?.user).toBe(userId)
  expect(stopped?.context).toMatchObject({ task: card.id, card: 'Retry me' })

  sink.clear()
  expect((await user.post(`/api/canvases/${canvasId}/cards/${card.id}/retry`)).status).toBe(200)
  const [again, ...rest] = await sink.waitFor(onCanvas('regenerate'))
  expect(rest).toEqual([])
  expect(again?.refs?.user).toBe(userId)
  expect(again?.context).toMatchObject({ task: card.id })
}, 60_000)

it('reports a comment telling an agent to change its design, and not one on the person`s own frame', async () => {
  const mine = await humanFrame('Mine to comment on')
  await user.post(`/api/frames/${mine.id}/comments`, { selector: 'h1', snippet: '<h1>', text: '@doop make it blue' })
  await sink.expectNone(onCanvas('correction'))

  const theirs = await agentFrame('Agent to comment on')
  sink.clear()
  const res = await user.post(`/api/frames/${theirs.id}/comments`, {
    selector: 'h1',
    snippet: '<h1>',
    text: '@doop this heading is too loud',
  })
  expect(res.status).toBe(200)

  const [signal, ...rest] = await sink.waitFor(onCanvas('correction'))
  expect(rest).toEqual([])
  expect(signal?.message).toBe('@doop this heading is too loud')
  expect(signal?.refs?.user).toBe(userId)
  expect(signal?.context).toMatchObject({ frame: theirs.id, agent: 'Tester' })
}, 60_000)

it('reports a reply that writes back to the agent, and not a note between people', async () => {
  const frame = await agentFrame('Agent thread')
  const root = await (
    await user.post(`/api/frames/${frame.id}/comments`, { selector: 'h1', snippet: '<h1>', text: 'Looks good' })
  ).json()
  sink.clear()

  await user.post(`/api/comments/${root.id}/replies`, { text: 'agreed, shipping it' })
  await sink.expectNone(onCanvas('correction'))

  expect((await user.post(`/api/comments/${root.id}/replies`, { text: '@doop tighten the spacing' })).status).toBe(200)
  const [signal, ...rest] = await sink.waitFor(onCanvas('correction'))
  expect(rest).toEqual([])
  expect(signal?.message).toBe('@doop tighten the spacing')
  expect(signal?.refs?.user).toBe(userId)
}, 60_000)

/* The other two "another go" buttons retry work a resident run left failed.
   Nothing on the HTTP surface can fail a comment or a task reply — only a
   run that crashed does — so what is checked here is the guard: asking for
   another go at work that never failed changes nothing and says nothing. */
it('says nothing when there was nothing to have another go at', async () => {
  const card = await (await user.post(`/api/canvases/${canvasId}/cards`, { title: 'Still running' })).json()
  const fb = await (await user.post(`/api/tasks/${card.id}/feedback`, { text: 'one more thing' })).json()
  const frame = await agentFrame('Agent retry thread')
  const comment = await (
    await user.post(`/api/frames/${frame.id}/comments`, { selector: 'h1', snippet: '<h1>', text: '@doop redo this' })
  ).json()
  sink.clear()

  expect((await user.post(`/api/feedback/${fb.id}/retry`)).status).toBe(200)
  expect((await user.post(`/api/comments/${comment.id}/retry`)).status).toBe(200)
  await sink.expectNone(onCanvas('regenerate'))
}, 60_000)

it('reports an agent`s own account of a tool that failed', async () => {
  const result = await agent.callTool({
    name: 'report_issue',
    arguments: {
      category: 'tool_error',
      message: 'edit_frame_html could not find the text I copied out of get_frame',
      tool: 'edit_frame_html',
      canvas_id: canvasId,
      agent_name: 'Tester',
    },
  })
  expect(result.isError).toBeFalsy()

  const [signal] = await sink.waitFor(
    (s) => s.source === 'agent' && s.kind === 'tool_failure' && s.tool === 'edit_frame_html',
  )
  expect(signal?.refs?.user).toBe(userId)
  expect(signal?.work_item).toEqual({ type: 'canvas', id: canvasId })
  expect(signal?.agent).toMatchObject({ name: 'Tester', client: 'signals-test-client' })
  expect(signal?.sentiment).toBe('negative')
}, 60_000)
