import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'

interface Event {
  kind: string
  id?: string
  contextId?: string
  held?: boolean
  digest?: string
}
let fixture: Awaited<ReturnType<typeof startPrivateServer>> | undefined
let controlDir: string
let a: Client
let b: Client
let canvasId: string
const marker = 'private-native-rendezvous'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM9sAAAAASUVORK5CYII=',
  'base64',
)
const events = async (): Promise<Event[]> => {
  try {
    return (await readFile(path.join(controlDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
const setHold = (hold: boolean, holdTimeoutMs = 20_000) =>
  writeFile(path.join(controlDir, 'control.json'), JSON.stringify({ hold, holdTimeoutMs, needle: marker }))
const release = (event: Event) => writeFile(path.join(controlDir, `release-${event.id}`), '')
async function nextRender(start: number, kind = 'screenshot') {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const found = (await events()).slice(start).find((e) => e.kind === kind && e.held)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('actual Chromium did not reach the test rendezvous')
}
async function frame(name: string, color = '#ff0000') {
  const response = await a.post(`/api/canvases/${canvasId}/frames`, {
    name,
    width: 80,
    height: 60,
    html: `<!doctype html><html><body style="margin:0;background:${color}"><span>${marker}</span></body></html>`,
  })
  expect(response.status).toBe(200)
  return response.json() as Promise<{ id: string }>
}
function opaque(response: Response) {
  expect(response.status).toBe(404)
  for (const key of ['content-type', 'etag', 'last-modified', 'content-disposition', 'location'])
    expect(response.headers.get(key)).toBeNull()
  expect(response.headers.get('cache-control')).toBe('private, no-store')
}
beforeAll(async () => {
  controlDir = await mkdtemp(path.join(tmpdir(), 'doop-render-rendezvous-'))
  await setHold(false)
  fixture = await startPrivateServer({
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${path.resolve('tests/fixtures/private-render-rendezvous.mjs')}`,
    DOOP_RENDER_RENDEZVOUS: controlDir,
  })
  a = await new Client(fixture.server).signUp('cache-a@test.dev', 'Cache A')
  b = await new Client(fixture.server).signUp('cache-b@test.dev', 'Cache B')
  canvasId = (await (await a.post('/api/canvases', { name: 'Cache authority' })).json()).id
}, 60_000)
afterAll(async () => {
  try {
    if (controlDir) await setHold(false)
    if (fixture) expect(contextAccounting(await events()).active).toBe(0)
  } finally {
    try {
      await fixture?.close()
    } finally {
      if (controlDir) await rm(controlDir, { recursive: true, force: true })
    }
  }
})

describe('actual disk, Chromium and current private cache authority', () => {
  it('observes real disk reads and denies foreign/anonymous variants before disk IO', async () => {
    const uploaded = await a.req(`/api/canvases/${canvasId}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(PNG),
    })
    expect(uploaded.status).toBe(200)
    const asset = new URL((await uploaded.json()).url).pathname
    const before = (await events()).filter((e) => e.kind === 'disk-read').length
    expect(Buffer.from(await (await a.get(asset)).arrayBuffer())).toEqual(PNG)
    expect((await events()).filter((e) => e.kind === 'disk-read').length).toBe(before + 1)
    for (const client of [null, b])
      for (const [method, headers] of [
        ['GET', {}],
        ['HEAD', {}],
        ['GET', { Range: 'bytes=0-7' }],
        ['GET', { 'If-None-Match': '*' }],
      ] as const) {
        const response = client
          ? await client.req(asset + '?download', { method, headers })
          : await fetch(fixture!.server.base + asset + '?download', { method, headers, redirect: 'manual' })
        opaque(response)
        expect(await response.text()).toBe('')
      }
    expect((await events()).filter((e) => e.kind === 'disk-read').length).toBe(before + 1)
    for (const prefix of ['/data/assets/', '/assets/']) {
      const response = await fetch(fixture!.server.base + prefix + asset.slice(3))
      expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(false)
    }
  })
  it('warm image bytes never grant anonymous or foreign reads and no extra render starts', async () => {
    const f = await frame('Warm private pixels')
    const image = `/i/${f.id}.png`
    const warm = await a.get(image)
    expect(warm.status).toBe(200)
    const bytes = Buffer.from(await warm.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(100)
    const count = (await events()).filter((e) => e.kind === 'screenshot').length
    for (const client of [null, b]) {
      const response = client ? await client.get(image) : await fetch(fixture!.server.base + image)
      opaque(response)
      expect(await response.text()).toBe('')
    }
    const same = await a.get(image)
    expect(Buffer.from(await same.arrayBuffer())).toEqual(bytes)
    expect((await events()).filter((e) => e.kind === 'screenshot').length).toBe(count)
  })
  it('deleting only a frame while its real screenshot is complete denies delivery and cache resurrection', async () => {
    const f = await frame('Delete during render')
    const image = `/i/${f.id}.png`
    await setHold(true)
    const start = (await events()).length
    const pending = a.get(image)
    try {
      const completed = await nextRender(start)
      expect((await a.delete(`/api/frames/${f.id}`)).status).toBe(200)
      expect((await a.get(`/api/canvases/${canvasId}`)).status).toBe(200)
      await release(completed)
      const response = await pending
      opaque(response)
      expect(await response.text()).toBe('')
      const after = await a.get(image)
      opaque(after)
      expect(await after.text()).toBe('')
      expect((await events()).slice(start).filter((e) => e.kind === 'screenshot')).toHaveLength(1)
    } finally {
      await setHold(false)
      await pending
    }
  })
  it('live unmodified held screenshot delivers exactly the actual completed render', async () => {
    const f = await frame('Live render control')
    await setHold(true)
    const start = (await events()).length
    const pending = a.get(`/i/${f.id}.png`)
    try {
      const completed = await nextRender(start)
      await release(completed)
      const response = await pending
      expect(response.status).toBe(200)
      expect(
        createHash('sha256')
          .update(Buffer.from(await response.arrayBuffer()))
          .digest('hex'),
      ).toBe(completed.digest)
    } finally {
      await setHold(false)
      await pending
    }
  })
  it('multi-frame PDF loses the entire result when one selected frame alone disappears', async () => {
    const first = await frame('PDF survivor')
    const second = await frame('PDF deleted', '#0000ff')
    await setHold(true)
    const start = (await events()).length
    const pending = a.get(`/api/canvases/${canvasId}/export.pdf?frames=${first.id},${second.id}`)
    try {
      await nextRender(start, 'pdf')
      expect((await a.delete(`/api/frames/${second.id}`)).status).toBe(200)
      const liveCanvas = await (await a.get(`/api/canvases/${canvasId}`)).json()
      expect(liveCanvas.frames.some((f: { id: string }) => f.id === first.id)).toBe(true)
      expect(liveCanvas.frames.some((f: { id: string }) => f.id === second.id)).toBe(false)
      await setHold(false)
      const response = await pending
      opaque(response)
      expect(await response.text()).toBe('')
      expect((await a.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    } finally {
      await setHold(false)
      await pending
    }
  })
  it('normal MCP credential revoked after real render completion cannot return pixels or prime a readable result', async () => {
    const f = await frame('Revoked MCP fill')
    const key = await (await a.post('/api/agent-keys', { name: 'Render revocation' })).json()
    const client = new McpClient({ name: 'native-cache-race', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(fixture!.server.base + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${key.secret}` } },
      }),
    )
    await setHold(true)
    const start = (await events()).length
    const pending = client.callTool({ name: 'get_frame_screenshot', arguments: { frame_id: f.id } })
    try {
      const completed = await nextRender(start)
      expect((await a.delete(`/api/agent-keys/${key.id}`)).status).toBe(200)
      expect((await a.get(`/api/canvases/${canvasId}`)).status).toBe(200)
      await release(completed)
      const response = await pending
      expect(response.isError).toBe(true)
      expect(response.content).toEqual([{ type: 'text', text: 'Error: Private screenshot is unavailable' }])
      const denied = await fetch(fixture!.server.base + `/i/${f.id}.png`)
      opaque(denied)
    } finally {
      await setHold(false)
      await pending
      await client.close()
    }
  })
})

async function heldRenders(start: number, count: number) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const held = (await events()).slice(start).filter((e) => e.kind === 'screenshot' && e.held)
    if (held.length >= count) return held
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('actual render claimant count did not arrive')
}
function contextAccounting(records: Event[]) {
  let active = 0
  let peak = 0
  for (const event of records) {
    if (event.kind === 'context-open') {
      active++
      peak = Math.max(peak, active)
    }
    if (event.kind === 'context-close') active--
    expect(active).toBeGreaterThanOrEqual(0)
  }
  return { active, peak }
}

describe('actual thumbnail and context competing claimants', () => {
  it('two contents pending for one thumbnail deliver their own actual pixels and never mislabel persisted bytes', async () => {
    const f = await frame('Pending old thumbnail')
    await setHold(true)
    const start = (await events()).length
    const old = a.get(`/i/${f.id}.jpg?preview&quality=70`)
    let newer: Promise<Response> | undefined
    try {
      const oldRender = await nextRender(start)
      expect(
        (
          await a.patch(`/api/frames/${f.id}`, {
            html: `<!doctype html><html><body style="margin:0;background:#0000ff"><span>${marker}</span></body></html>`,
          })
        ).status,
      ).toBe(200)
      newer = a.get(`/i/${f.id}.jpg?preview&quality=70`)
      const held = await heldRenders(start, 2)
      const newRender = held.find((e) => e.id !== oldRender.id)!
      expect(newRender.digest).not.toBe(oldRender.digest)
      await release(newRender)
      const current = await newer
      expect(current.status).toBe(200)
      const currentBytes = Buffer.from(await current.arrayBuffer())
      expect(createHash('sha256').update(currentBytes).digest('hex')).toBe(newRender.digest)
      await release(oldRender)
      const previous = await old
      expect(previous.status).toBe(200)
      expect(
        createHash('sha256')
          .update(Buffer.from(await previous.arrayBuffer()))
          .digest('hex'),
      ).toBe(oldRender.digest)
      await setHold(false)
      /* Change outer variant to force the persisted-provenance path, rather than its cached promise. */
      const stored = await a.get(`/i/${f.id}.jpg?preview&quality=71`)
      expect(stored.status).toBe(200)
      expect(Buffer.from(await stored.arrayBuffer())).toEqual(currentBytes)
      const renders = (await events()).filter((e) => e.kind === 'screenshot').length
      const reads = (await events()).filter((e) => e.kind === 'disk-read').length
      const confirmed = await a.get(`/i/${f.id}.jpg?preview&quality=72`)
      expect(Buffer.from(await confirmed.arrayBuffer())).toEqual(currentBytes)
      expect((await events()).filter((e) => e.kind === 'screenshot').length).toBe(renders)
      expect((await events()).filter((e) => e.kind === 'disk-read').length).toBe(reads + 1)
    } finally {
      await setHold(false)
      await old
      await newer
    }
  })
  it('the production thumbnail path refuses the twentieth claimant while exactly three actual renders hold its pipeline', async () => {
    const frames = await Promise.all(Array.from({ length: 20 }, (_, i) => frame(`Thumbnail capacity ${i}`)))
    await setHold(true)
    const start = (await events()).length
    const all = frames.map((f) => a.get(`/i/${f.id}.jpg?preview`))
    try {
      const refusal = await Promise.race(all)
      expect(refusal.status).toBe(503)
      expect(await refusal.text()).toBe('{"error":"render capacity is temporarily unavailable"}')
      expect(await heldRenders(start, 3)).toHaveLength(3)
      expect((await events()).slice(start).filter((e) => e.kind === 'context-open')).toHaveLength(3)
      await setHold(false)
      const responses = await Promise.all(all)
      expect(responses.filter((r) => r.status === 200)).toHaveLength(19)
      expect(responses.filter((r) => r.status === 503)).toHaveLength(1)
      expect(contextAccounting((await events()).slice(start))).toEqual({ active: 0, peak: 3 })
    } finally {
      await setHold(false)
      await Promise.all(all)
    }
  }, 45_000)
  it('the production page owner refuses the twenty-first claimant and never exceeds four live contexts', async () => {
    const frames = await Promise.all(Array.from({ length: 21 }, (_, i) => frame(`Context capacity ${i}`)))
    await setHold(true)
    const start = (await events()).length
    const all = frames.map((f) => a.get(`/i/${f.id}.png`))
    try {
      expect((await Promise.race(all)).status).toBe(503)
      expect(await heldRenders(start, 4)).toHaveLength(4)
      expect((await events()).slice(start).filter((e) => e.kind === 'context-open')).toHaveLength(4)
      await setHold(false)
      const responses = await Promise.all(all)
      expect(responses.filter((r) => r.status === 200)).toHaveLength(20)
      expect(responses.filter((r) => r.status === 503)).toHaveLength(1)
      expect(contextAccounting((await events()).slice(start))).toEqual({ active: 0, peak: 4 })
    } finally {
      await setHold(false)
      await Promise.all(all)
    }
  }, 45_000)
  it('an actual context waiter expires at30s without starting a fifth render', async () => {
    const frames = await Promise.all(Array.from({ length: 5 }, (_, i) => frame(`Context deadline ${i}`)))
    await setHold(true, 45_000)
    const start = (await events()).length
    const active = frames.slice(0, 4).map((f) => a.get(`/i/${f.id}.png`))
    try {
      await heldRenders(start, 4)
      const began = Date.now()
      const response = await a.get(`/i/${frames[4]!.id}.png`)
      expect(response.status).toBe(503)
      expect(await response.text()).toBe('{"error":"render capacity is temporarily unavailable"}')
      expect(Date.now() - began).toBeGreaterThanOrEqual(29_000)
      expect((await events()).slice(start).filter((e) => e.kind === 'context-open')).toHaveLength(4)
      await setHold(false)
      for (const result of await Promise.all(active)) expect(result.status).toBe(200)
      expect(contextAccounting((await events()).slice(start))).toEqual({ active: 0, peak: 4 })
      expect((await a.get(`/i/${frames[4]!.id}.png`)).status).toBe(200)
    } finally {
      await setHold(false)
      await Promise.all(active)
    }
  }, 50_000)
})

describe('current browser and PDF credential delivery', () => {
  it('a revoked browser session cannot reuse warmed bytes while a second normal session still reads the same parent', async () => {
    const f = await frame('Browser session warm revocation')
    const image = `/i/${f.id}.png`
    expect((await a.get(image)).status).toBe(200)
    const original = (
      await fixture!.db.query('SELECT * FROM "session" WHERE user_id=(SELECT id FROM "user" WHERE email=$1)', [
        'cache-a@test.dev',
      ])
    ).rows
    const observer = new Client(fixture!.server)
    expect(
      (await observer.post('/api/auth/sign-in/email', { email: 'cache-a@test.dev', password: 'password12345' })).status,
    ).toBe(200)
    const before = (await events()).filter((e) => e.kind === 'screenshot').length
    try {
      for (const row of original) await fixture!.db.query('DELETE FROM "session" WHERE id=$1', [row.id])
      expect((await observer.get(`/api/canvases/${canvasId}`)).status).toBe(200)
      const denied = await a.get(image)
      opaque(denied)
      expect(await denied.text()).toBe('')
      expect((await events()).filter((e) => e.kind === 'screenshot').length).toBe(before)
    } finally {
      for (const row of original)
        await fixture!.db.query(
          'INSERT INTO "session" SELECT * FROM json_populate_record(NULL::"session",$1::json) ON CONFLICT (id) DO NOTHING',
          [JSON.stringify(row)],
        )
    }
  })
  it('a normal browser session revoked after actual render completion cannot receive the pending bytes', async () => {
    const f = await frame('Browser session pending revocation')
    const original = (
      await fixture!.db.query('SELECT * FROM "session" WHERE user_id=(SELECT id FROM "user" WHERE email=$1)', [
        'cache-a@test.dev',
      ])
    ).rows
    const observer = new Client(fixture!.server)
    expect(
      (await observer.post('/api/auth/sign-in/email', { email: 'cache-a@test.dev', password: 'password12345' })).status,
    ).toBe(200)
    await setHold(true)
    const start = (await events()).length
    const pending = a.get(`/i/${f.id}.png`)
    try {
      const completed = await nextRender(start)
      for (const row of original) await fixture!.db.query('DELETE FROM "session" WHERE id=$1', [row.id])
      expect((await observer.get(`/api/canvases/${canvasId}`)).status).toBe(200)
      await release(completed)
      const denied = await pending
      opaque(denied)
      expect(await denied.text()).toBe('')
    } finally {
      await setHold(false)
      await pending
      for (const row of original)
        await fixture!.db.query(
          'INSERT INTO "session" SELECT * FROM json_populate_record(NULL::"session",$1::json) ON CONFLICT (id) DO NOTHING',
          [JSON.stringify(row)],
        )
    }
  })
  it('MCP PDF revalidates the same normal credential after actual vector-page completion', async () => {
    const f = await frame('MCP PDF revoked')
    const key = await (await a.post('/api/agent-keys', { name: 'PDF revocation' })).json()
    const client = new McpClient({ name: 'native-pdf-revoke', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(fixture!.server.base + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${key.secret}` } },
      }),
    )
    await setHold(true)
    const start = (await events()).length
    const pending = client.callTool({ name: 'export_frame', arguments: { frame_id: f.id, format: 'pdf' } })
    try {
      const completed = await nextRender(start, 'pdf')
      expect((await a.delete(`/api/agent-keys/${key.id}`)).status).toBe(200)
      expect((await a.get(`/api/canvases/${canvasId}`)).status).toBe(200)
      await release(completed)
      const response = await pending
      expect(response.isError).toBe(true)
      expect(response.content).toEqual([{ type: 'text', text: 'Error: Private PDF is unavailable' }])
    } finally {
      await setHold(false)
      await pending
      await client.close()
    }
  })
})

describe('current workspace membership at private read boundaries', () => {
  async function shared() {
    const ws = await (await a.post('/api/workspaces', { name: 'Revoke file reader' })).json()
    const member = await a.post(`/api/workspaces/${ws.id}/members`, { email: 'cache-b@test.dev' })
    expect(member.status).toBe(200)
    const userId = (await member.json()).member.userId as string
    const canvas = await (await a.post('/api/canvases', { name: 'Membership boundary', workspaceId: ws.id })).json()
    const f = await (
      await a.post(`/api/canvases/${canvas.id}/frames`, {
        name: 'Shared reader pixels',
        width: 80,
        height: 60,
        html: `<html><body style="background:green">${marker}</body></html>`,
      })
    ).json()
    expect((await b.get(`/api/canvases/${canvas.id}`)).status).toBe(200)
    return { workspaceId: ws.id as string, userId, canvasId: canvas.id as string, frameId: f.id as string }
  }
  it('revoked membership denies warmed image and asset paths before cache or disk reuse', async () => {
    const s = await shared()
    const uploaded = await a.req(`/api/canvases/${s.canvasId}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(PNG),
    })
    expect(uploaded.status).toBe(200)
    const asset = new URL((await uploaded.json()).url).pathname
    expect((await b.get(asset)).status).toBe(200)
    const image = `/i/${s.frameId}.png`
    const warm = await b.get(image)
    expect(warm.status).toBe(200)
    const bytes = Buffer.from(await warm.arrayBuffer())
    const before = await events()
    expect((await a.delete(`/api/workspaces/${s.workspaceId}/members/${s.userId}`)).status).toBe(200)
    for (const resource of [asset, image]) {
      const r = await b.get(resource)
      opaque(r)
      expect(await r.text()).toBe('')
    }
    const allowed = await a.get(image)
    expect(allowed.status).toBe(200)
    expect(Buffer.from(await allowed.arrayBuffer())).toEqual(bytes)
    const after = await events()
    for (const kind of ['disk-read', 'screenshot'])
      expect(after.filter((e) => e.kind === kind).length).toBe(before.filter((e) => e.kind === kind).length)
  })
  it('membership revoked after real render completion denies that pending reader while its parent survives', async () => {
    const s = await shared()
    await setHold(true)
    const start = (await events()).length
    const pending = b.get(`/i/${s.frameId}.png`)
    try {
      const completed = await nextRender(start)
      expect((await a.delete(`/api/workspaces/${s.workspaceId}/members/${s.userId}`)).status).toBe(200)
      expect((await a.get(`/api/canvases/${s.canvasId}`)).status).toBe(200)
      await release(completed)
      const r = await pending
      opaque(r)
      expect(await r.text()).toBe('')
      const again = await b.get(`/i/${s.frameId}.png`)
      opaque(again)
      expect((await events()).slice(start).filter((e) => e.kind === 'screenshot')).toHaveLength(1)
    } finally {
      await setHold(false)
      await pending
    }
  })
})

it('the actual thumbnail queue expires after30s before using the spare fourth context', async () => {
  const frames = await Promise.all(Array.from({ length: 4 }, (_, i) => frame(`Thumbnail deadline ${i}`)))
  await setHold(true, 45_000)
  const start = (await events()).length
  const active = frames.slice(0, 3).map((f) => a.get(`/i/${f.id}.jpg?preview`))
  try {
    await heldRenders(start, 3)
    const began = Date.now()
    const response = await a.get(`/i/${frames[3]!.id}.jpg?preview`)
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"error":"render capacity is temporarily unavailable"}')
    expect(Date.now() - began).toBeGreaterThanOrEqual(29_000)
    expect((await events()).slice(start).filter((e) => e.kind === 'context-open')).toHaveLength(3)
    await setHold(false)
    for (const response of await Promise.all(active)) expect(response.status).toBe(200)
    expect(contextAccounting((await events()).slice(start))).toEqual({ active: 0, peak: 3 })
    expect((await a.get(`/i/${frames[3]!.id}.jpg?preview`)).status).toBe(200)
  } finally {
    await setHold(false)
    await Promise.all(active)
  }
}, 50_000)
