import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

/**
 * Integration tests for the canvas access model, run against the REAL server:
 * spawned as a child process on a fresh PGlite database in a temp directory,
 * exercised over HTTP and WebSocket exactly like the browser and MCP clients.
 * No mocks — this is the same surface a self-hoster exposes to the internet.
 */

const PORT = 4977
const BASE = `http://localhost:${PORT}`
const ROOT = process.cwd() // vitest runs from the repo root

let server: ChildProcess
let dataDir: string

/** Minimal cookie-jar client: better-auth drives everything through cookies. */
class Client {
  cookies = new Map<string, string>()

  private header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async req(pathname: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(BASE + pathname, {
      ...init,
      headers: { 'Content-Type': 'application/json', Cookie: this.header(), ...init.headers },
      redirect: 'manual',
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const idx = pair.indexOf('=')
      this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
    }
    return res
  }

  get(p: string) {
    return this.req(p)
  }

  post(p: string, body?: unknown) {
    return this.req(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  }

  patch(p: string, body: unknown) {
    return this.req(p, { method: 'PATCH', body: JSON.stringify(body) })
  }

  delete(p: string) {
    return this.req(p, { method: 'DELETE' })
  }

  async signUp(email: string, name: string) {
    const res = await this.post('/api/auth/sign-up/email', { email, password: 'password12345', name })
    expect(res.status).toBe(200)
    return this
  }

  /** join a canvas room over WS; resolves with how the server answered */
  joinWs(canvasId: string): Promise<{ kind: 'init' } | { kind: 'closed'; code: number }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: this.header() } })
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('ws join timed out'))
      }, 8000)
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 't', kind: 'user' })),
      )
      ws.on('message', (d) => {
        if (JSON.parse(String(d)).type === 'init') {
          clearTimeout(timer)
          ws.close()
          resolve({ kind: 'init' })
        }
      })
      ws.on('close', (code) => {
        clearTimeout(timer)
        resolve({ kind: 'closed', code })
      })
      ws.on('error', () => {}) // close event carries the verdict
    })
  }
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'doop-test-'))
  server = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [path.join(ROOT, 'server', 'index.ts')], {
    cwd: dataDir, // PGlite persists to <cwd>/data — isolated per run
    env: { ...process.env, PORT: String(PORT), NODE_ENV: undefined as unknown as string },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not boot within 60s')
    await new Promise((r) => setTimeout(r, 500))
  }
}, 70_000)

afterAll(() => {
  server?.kill()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('canvas access model', () => {
  const owner = new Client()
  const invited = new Client()
  const stranger = new Client()
  let canvasId: string
  let frameId: string
  let invitedId: string

  it('rejects unauthenticated API and MCP calls', async () => {
    expect((await fetch(`${BASE}/api/canvases`)).status).toBe(401)
    const mcp = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' })
    expect(mcp.status).toBe(401)
    expect(mcp.headers.get('www-authenticate')).toContain('oauth-protected-resource')
  })

  it('signs up three accounts and creates a canvas with a frame', async () => {
    await owner.signUp('owner@test.dev', 'Owner')
    await invited.signUp('invited@test.dev', 'Invited')
    await stranger.signUp('stranger@test.dev', 'Stranger')
    invitedId = (await (await invited.get('/api/me')).json()).id

    const canvas = await (await owner.post('/api/canvases', { name: 'ACL' })).json()
    canvasId = canvas.id
    const frame = await (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'F1' })).json()
    frameId = frame.id
  })

  it('rejects non-numeric frame geometry on create', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'Invalid', width: '640' })
    expect(res.status).toBe(400)
  })

  it('rejects null frame values on update', async () => {
    const res = await owner.patch(`/api/frames/${frameId}`, { x: null })
    expect(res.status).toBe(400)
    const current = await (await owner.get(`/api/canvases/${canvasId}`)).json()
    expect(current.frames.find((f: { id: string }) => f.id === frameId)?.x).toBe(120)
  })

  it('is private by default: non-owners are blocked everywhere', async () => {
    expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect((await stranger.post(`/api/canvases/${canvasId}/frames`, { name: 'x' })).status).toBe(403)
    expect((await stranger.patch(`/api/frames/${frameId}`, { name: 'hacked' })).status).toBe(403)
    expect((await stranger.delete(`/api/frames/${frameId}`)).status).toBe(403)
    expect((await stranger.patch(`/api/canvases/${canvasId}`, { name: 'renamed' })).status).toBe(403)
    expect(await stranger.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4403 })
  })

  it('invited members get full access; the owner is unaffected', async () => {
    const res = await owner.post(`/api/canvases/${canvasId}/members`, { email: 'invited@test.dev' })
    expect(res.status).toBe(200)
    expect((await invited.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect((await invited.post(`/api/canvases/${canvasId}/frames`, { name: 'by invited' })).status).toBe(200)
    expect(await invited.joinWs(canvasId)).toEqual({ kind: 'init' })
    expect((await owner.get(`/api/canvases/${canvasId}`)).status).toBe(200)
  })

  it('membership management is owner-only (members may leave)', async () => {
    expect((await invited.post(`/api/canvases/${canvasId}/members`, { email: 'stranger@test.dev' })).status).toBe(403)
    expect((await owner.post(`/api/canvases/${canvasId}/members`, { email: 'nobody@test.dev' })).status).toBe(404)
    expect((await stranger.delete(`/api/canvases/${canvasId}/members/${invitedId}`)).status).toBe(403)

    const people = await (await owner.get(`/api/canvases/${canvasId}/members`)).json()
    expect(people.map((p: { email: string; owner: boolean }) => [p.email, p.owner])).toEqual([
      ['owner@test.dev', true],
      ['invited@test.dev', false],
    ])
  })

  it('lists invited canvases on the member home screen, marked shared', async () => {
    const list = await (await invited.get('/api/canvases')).json()
    const entry = list.find((c: { id: string }) => c.id === canvasId)
    expect(entry?.shared).toBe(true)
  })

  it('only the owner can flip link access; edit opens the canvas to everyone signed in', async () => {
    expect((await invited.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })).status).toBe(403)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'bogus' })).status).toBe(400)

    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'edit' })).status).toBe(200)
    expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect(await stranger.joinWs(canvasId)).toEqual({ kind: 'init' })

    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'none' })).status).toBe(200)
    expect((await stranger.get(`/api/canvases/${canvasId}`)).status).toBe(403)
  })

  it('a member who leaves loses access', async () => {
    expect((await invited.delete(`/api/canvases/${canvasId}/members/${invitedId}`)).status).toBe(200)
    expect((await invited.get(`/api/canvases/${canvasId}`)).status).toBe(403)
  })

  it('canvas deletion stays owner-only', async () => {
    await owner.post(`/api/canvases/${canvasId}/members`, { email: 'invited@test.dev' })
    expect((await invited.delete(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect((await owner.delete(`/api/canvases/${canvasId}`)).status).toBe(200)
    expect((await owner.get(`/api/canvases/${canvasId}`)).status).toBe(404)
  })
})
