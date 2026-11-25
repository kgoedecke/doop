import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Client, startServer, type Server } from './harness.ts'

/* The doop CLI's browser sign-in (server/cliConnect.ts) against the real server: the signed-in
   approval, and the one-time trade of the code and its verifier for an agent key. */

let server: Server
let owner: Client

const STATE = 'fedcba9876543210fedcba9876543210'
const VERIFIER = 'a-secret-only-the-cli-that-started-the-sign-in-holds'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const REQUEST = { state: STATE, challenge: CHALLENGE, name: 'test machine' }

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(server.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function approve(request: Record<string, unknown>): Promise<{ url?: string; code?: string }> {
  const res = await owner.post('/api/cli/connect', request)
  expect(res.status).toBe(200)
  return (await res.json()) as { url?: string; code?: string }
}

beforeAll(async () => {
  server = await startServer()
  owner = await new Client(server).signUp('cli-connect@test.dev', 'CLI Person')
}, 70_000)

afterAll(() => server?.stop())

describe('cli connect', () => {
  it('needs a session to approve, and a request the CLI could have made', async () => {
    expect((await post('/api/cli/connect', REQUEST)).status).toBe(401)
    expect((await owner.post('/api/cli/connect', { ...REQUEST, challenge: 'nope' })).status).toBe(400)
    expect((await owner.post('/api/cli/connect', { ...REQUEST, port: 80 })).status).toBe(400)
  })

  it('sends a listening CLI the code on its loopback address', async () => {
    const { url, code } = await approve({ ...REQUEST, port: 41234 })
    expect(code).toBeUndefined()
    const target = new URL(url!)
    expect(target.origin).toBe('http://127.0.0.1:41234')
    expect(target.searchParams.get('state')).toBe(STATE)
    expect(target.searchParams.get('code')).toBeTruthy()
  })

  it('trades the code and the verifier, once, for an agent key that works', async () => {
    const { code } = await approve(REQUEST)
    const exchanged = await post('/cli/exchange', { code, verifier: VERIFIER })
    expect(exchanged.status).toBe(200)
    const { key, user } = (await exchanged.json()) as { key: string; user: { name: string; email: string } }
    expect(key).toMatch(/^dpk_/)
    expect(user).toEqual({ name: 'CLI Person', email: 'cli-connect@test.dev' })

    /* the key is an ordinary agent key, named after the machine */
    const listed = (await (await owner.get('/api/agent-keys')).json()) as { name: string }[]
    expect(listed.map((entry) => entry.name)).toContain('doop CLI on test machine')
    const mcp = await post(
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_profile', arguments: {} } },
      { Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}` },
    )
    expect(await mcp.text()).toContain('CLI Person')

    expect((await post('/cli/exchange', { code, verifier: VERIFIER })).status).toBe(400)
  })

  it('gives nothing to a caller without the verifier, and uses the code up', async () => {
    const before = ((await (await owner.get('/api/agent-keys')).json()) as unknown[]).length
    const { code } = await approve(REQUEST)
    expect((await post('/cli/exchange', { code, verifier: 'x'.repeat(43) })).status).toBe(400)
    expect((await post('/cli/exchange', { code })).status).toBe(400)
    /* the right verifier is too late: the wrong one spent the code */
    expect((await post('/cli/exchange', { code, verifier: VERIFIER })).status).toBe(400)
    expect(((await (await owner.get('/api/agent-keys')).json()) as unknown[]).length).toBe(before)
  })
})
