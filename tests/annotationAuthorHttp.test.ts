import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * An annotation is not an edit, against the REAL server (see ./harness.ts): a comment that
 * stamps a `data-doop-id` into a frame, and a token rename that rewrites the frames naming it,
 * leave `updatedBy` as the design's last author and move `updatedAt` one step, so an agent
 * reading `get_frame` is not told the commenter just edited the frame (and keeps away from the
 * frame the comment asks it to change), while a save made against the older version is still
 * refused.
 */

let server: Server
let owner: Client
let commenter: Client
let canvasId: string
let ownerKey: string

const AGENT = 'Claude'

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('annotation-owner@test.dev', 'Owner')
  commenter = await new Client(server).signUp('annotation-commenter@test.dev', 'Commenter')
  const canvas = await (await owner.post('/api/canvases', { name: 'Annotations' })).json()
  canvasId = canvas.id
  const share = await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'comment' })
  expect(share.status, await share.text()).toBe(200)
  ownerKey = (await (await owner.post('/api/agent-keys', { name: 'owner-agent' })).json()).secret
}, 70_000)

afterAll(() => server?.stop())

async function mcpCall(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${ownerKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { isError?: boolean; content: { text?: string }[] } }
  const text = body.result.content.map((block) => block.text ?? '').join('\n')
  expect(body.result.isError, text).toBeFalsy()
  return text
}

/** who and when `get_frame` says last touched the frame */
async function agentSees(frameId: string): Promise<{ updatedBy: string; updatedAt: string }> {
  const text = await mcpCall('get_frame', { frame_id: frameId, agent_name: AGENT })
  const by = /"updatedBy":\s*"([^"]*)"/.exec(text)?.[1]
  const at = /"updatedAt":\s*"([^"]*)"/.exec(text)?.[1]
  expect(by, text).toBeDefined()
  expect(at, text).toBeDefined()
  return { updatedBy: by!, updatedAt: at! }
}

/** the frame as the canvas route hands it to a browser */
async function frameNow(id: string): Promise<{ html: string; updatedAt: number; updatedBy: string }> {
  const canvas = await (await owner.get(`/api/canvases/${canvasId}`)).json()
  return canvas.frames.find((f: { id: string }) => f.id === id)
}

/** a frame the agent designed, over MCP */
async function agentFrame(html: string): Promise<string> {
  const text = await mcpCall('create_frame', { canvas_id: canvasId, name: 'Home', html, agent_name: AGENT })
  const id = /"id":\s*"([^"]+)"/.exec(text)?.[1]
  expect(id, text).toBeDefined()
  return id!
}

/** The commenter's comment on the frame's heading. A frame an agent just wrote plays back for a
 *  few seconds, and an element is stamped only once it has landed (until then the comment pins
 *  to the frame, writing nothing to it), so this comments again until one lands on the heading. */
async function commentOnHeading(frameId: string): Promise<{ elementId?: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await commenter.post(`/api/frames/${frameId}/comments`, {
      selector: 'body > main:nth-of-type(1) > h1:nth-of-type(1)',
      snippet: '<h1>Welcome</h1>',
      text: 'Make this bigger',
      x: 4,
      y: 4,
    })
    const comment = await res.json()
    expect(res.status, JSON.stringify(comment)).toBe(200)
    if (comment.elementId || attempt === 40) return comment
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe('an annotation leaves who last edited the frame', () => {
  it('a comment stamping an element id keeps updatedBy and moves updatedAt one step', async () => {
    const frameId = await agentFrame('<main><h1>Welcome</h1><p>Hello</p></main>')
    const before = await frameNow(frameId)
    expect(before.updatedBy).toBe(AGENT)
    const seenBefore = await agentSees(frameId)

    const comment = await commentOnHeading(frameId)
    expect(comment.elementId).toMatch(/^[a-z0-9]{6}$/)

    const after = await frameNow(frameId)
    /* the stamp is in the frame: the annotation did happen */
    expect(after.html).toContain(`data-doop-id="${comment.elementId}"`)
    /* REST: still the agent's design, and the version moved by one step, not to now */
    expect(after.updatedBy).toBe(AGENT)
    expect(after.updatedAt).toBe(before.updatedAt + 1)
    /* MCP: the agent is not told the commenter edited its frame */
    const seenAfter = await agentSees(frameId)
    expect(seenAfter.updatedBy).toBe(AGENT)
    expect(Date.parse(seenAfter.updatedAt) - Date.parse(seenBefore.updatedAt)).toBe(1)

    /* still a version: a save made against the frame before the stamp is a conflict */
    const stale = await owner.patch(`/api/frames/${frameId}`, {
      html: '<main><h1>Welcome</h1></main>',
      expectedUpdatedAt: before.updatedAt,
    })
    expect(stale.status).toBe(409)
    expect((await frameNow(frameId)).html).toContain(`data-doop-id="${comment.elementId}"`)
  })

  it('a token rename rewriting a frame keeps its updatedBy', async () => {
    const created = await owner.post(`/api/canvases/${canvasId}/tokens`, {
      tokens: [{ name: '--color-brand', type: 'color', value: '#0177d3' }],
    })
    expect(created.status, await created.text()).toBe(200)
    const frameId = await agentFrame('<p style="color: var(--color-brand)">Brand</p>')
    const before = await frameNow(frameId)
    expect(before.updatedBy).toBe(AGENT)

    const renamed = await owner.put(`/api/canvases/${canvasId}/tokens/--color-brand`, { newName: '--color-accent' })
    expect(renamed.status, await renamed.text()).toBe(200)

    const after = await frameNow(frameId)
    expect(after.html).toContain('var(--color-accent)')
    expect(after.updatedBy).toBe(AGENT)
    expect(after.updatedAt).toBe(before.updatedAt + 1)
    expect((await agentSees(frameId)).updatedBy).toBe(AGENT)
  })

  it('an edit is still an edit: a person saving the design becomes its author', async () => {
    const frameId = await agentFrame('<p>Draft</p>')
    const before = await frameNow(frameId)
    const saved = await owner.patch(`/api/frames/${frameId}`, {
      html: '<p>Final</p>',
      expectedUpdatedAt: before.updatedAt,
    })
    expect(saved.status, await saved.text()).toBe(200)
    expect((await frameNow(frameId)).updatedBy).toBe('Owner')
    expect((await agentSees(frameId)).updatedBy).toBe('Owner')
  })
})
