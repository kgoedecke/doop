import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'

/* The write boundary against the REAL server, its database included (see ./harness.ts): a
   request or tool call refused for its work budget part of the way leaves nothing in
   memory, tells the room nothing, and stores nothing, which a reboot on the same data
   directory proves. One that lands is stored whole. The harness runs every server with
   DOOP_WRITE_BOUNDARY=throw, so a store write outside any boundary fails the request. */

interface Seen {
  frames: { id: string; name: string; html: string }[]
  components: { name: string; rev: number }[]
  pages: { name: string }[]
  activity: string[]
}

let server: Server
let owner: Client
let key: string
let canvasId: string

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

/* small enough to be read once, large enough that the main's write, which reads it several
   times over, runs out of a 1 MB budget after the definition and its frame exist */
const HEAVY = `<section class="big"><h2>Big</h2><p>${'lorem ipsum '.repeat(22_000)}</p></section>`

/** Everything the server holds for the canvas: what a person joining now is sent. */
function joined(): Promise<{ seen: Seen; messages: { type: string }[]; close(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, { headers: { Cookie: owner.header() } })
    const messages: { type: string }[] = []
    const timer = setTimeout(() => reject(new Error('ws join timed out')), 8000)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 'watcher', kind: 'user' }),
      ),
    )
    ws.on('error', reject)
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as {
        type: string
        canvas?: { pages?: { name: string }[]; components?: { name: string; rev: number }[] }
        activity?: { message: string }[]
      }
      if (message.type !== 'init') return void messages.push(message)
      clearTimeout(timer)
      void owner
        .get(`/api/canvases/${canvasId}`)
        .then((res) => res.json())
        .then((canvas: { frames: Seen['frames'] }) =>
          resolve({
            seen: {
              frames: canvas.frames.map(({ id, name, html }) => ({ id, name, html })),
              components: (message.canvas?.components ?? []).map(({ name, rev }) => ({ name, rev })),
              pages: (message.canvas?.pages ?? []).map(({ name }) => ({ name })),
              /* lines of one millisecond come back from the database in either order */
              activity: (message.activity ?? []).map((item) => item.message).sort(),
            },
            messages,
            close: () => ws.close(),
          }),
        )
    })
  })
}

const seenNow = async () => {
  const view = await joined()
  view.close()
  return view.seen
}

/** What the room was told that changes a canvas (presence and the like aside). */
const writes = (messages: { type: string }[]) =>
  messages
    .map((message) => message.type)
    .filter((type) => /^(frame:|component|canvas:pages|activity|task|library)/.test(type))

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

async function reboot() {
  /* long enough for the debounced frame writes of what did land */
  await new Promise((resolve) => setTimeout(resolve, 700))
  const dataDir = server.dataDir
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer({ DOOP_WORK_BUDGET_PARSE_MB: '1' }, dataDir)
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { isError?: boolean; content: { type: string; text?: string }[] } }
  return { isError: !!body.result.isError, text: body.result.content.map((block) => block.text ?? '').join('\n') }
}

beforeAll(async () => {
  server = await startServer({ DOOP_WORK_BUDGET_PARSE_MB: '1' })
  owner = await new Client(server).signUp('owner@boundary.test', 'Owner')
  key = ((await (await owner.post('/api/agent-keys', { name: 'agent' })).json()) as { secret: string }).secret
  canvasId = ((await (await owner.post('/api/canvases', { name: 'Boundary' })).json()) as { id: string }).id
  const frame = await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Page', html: doc('<p>Hello</p>') })
  expect(frame.status).toBe(200)
}, 70_000)

afterAll(() => server?.stop())

describe('a request refused part of the way', () => {
  it('POST components: no definition, no Components page, no frame, no activity, in the room or after a reboot', async () => {
    const before = await seenNow()
    const watching = await joined()
    const refused = await owner.post(`/api/canvases/${canvasId}/components`, { name: 'Big', html: HEAVY })
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as { code: string }).code).toBe('work_budget_exceeded')
    await settle()
    expect(writes(watching.messages)).toEqual([])
    watching.close()
    expect(await seenNow()).toEqual(before)
    await reboot()
    expect(await seenNow()).toEqual(before)
  }, 60_000)

  it('create_component over MCP: the same, and the tool says nothing was changed', async () => {
    const before = await seenNow()
    const watching = await joined()
    const refused = await mcpCall('create_component', { canvas_id: canvasId, name: 'Big', html: HEAVY })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Nothing was changed')
    await settle()
    expect(writes(watching.messages)).toEqual([])
    watching.close()
    expect(await seenNow()).toEqual(before)
    await reboot()
    expect(await seenNow()).toEqual(before)
  }, 60_000)
})

describe('a request that lands', () => {
  it('tells the room before it answers, and is stored whole', async () => {
    const watching = await joined()
    const made = await owner.post(`/api/canvases/${canvasId}/components`, {
      name: 'Chip',
      html: '<span class="chip">Chip</span>',
      css: '.chip { color: red }',
    })
    expect(made.status).toBe(200)
    /* committed as the response started: a client that has its answer has had the broadcasts */
    await settle()
    const heard = writes(watching.messages)
    expect(heard).toContain('component')
    expect(heard).toContain('frame:created')
    expect(heard).toContain('canvas:pages')
    expect(heard).toContain('activity')
    /* in the order the request made them: the page before the frame placed on it */
    expect(heard.indexOf('canvas:pages')).toBeLessThan(heard.indexOf('frame:created'))
    watching.close()
    const after = await seenNow()
    expect(after.components).toEqual([{ name: 'Chip', rev: 1 }])
    expect(after.pages.map((page) => page.name)).toContain('Components')
    expect(after.frames.map((frame) => frame.name)).toContain('Chip')
    await reboot()
    expect(await seenNow()).toEqual(after)
  }, 60_000)

  it('an MCP tool call is committed when the tool returns', async () => {
    const watching = await joined()
    const made = await mcpCall('create_frame', {
      canvas_id: canvasId,
      name: 'From an agent',
      html: doc('<doop-use component="Chip"></doop-use>'),
      agent_name: 'Tester',
    })
    expect(made.isError).toBe(false)
    await settle()
    expect(writes(watching.messages)).toContain('frame:created')
    watching.close()
    const after = await seenNow()
    expect(after.frames.map((frame) => frame.name)).toContain('From an agent')
    await reboot()
    expect((await seenNow()).frames.find((frame) => frame.name === 'From an agent')?.html).toContain('chip')
  }, 60_000)

  it('a refused PATCH of a main leaves the frame, its history, the component and the feed as they were', async () => {
    const before = await seenNow()
    const main = before.frames.find((frame) => frame.name === 'Chip')!
    const historyOf = async () => (await (await owner.get(`/api/frames/${main.id}/versions`)).json()) as unknown[]
    const history = await historyOf()
    const watching = await joined()
    const heavy = main.html
      .replace('>Chip<', '>Changed<')
      .replace('</body>', `<p>${'lorem ipsum '.repeat(40_000)}</p></body>`)
    const refused = await owner.patch(`/api/frames/${main.id}`, { html: heavy })
    expect(refused.status).toBe(422)
    await settle()
    expect(writes(watching.messages)).toEqual([])
    watching.close()
    expect(await historyOf()).toEqual(history)
    expect(await seenNow()).toEqual(before)
    await reboot()
    expect(await seenNow()).toEqual(before)
    expect(await historyOf()).toEqual(history)
  }, 60_000)
})
