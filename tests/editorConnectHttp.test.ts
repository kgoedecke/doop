import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/* The editor extension's sign-in and canvas embed (server/editorConnect.ts)
   against the real server: the signed-in approval, the one-time exchange of
   the code for an agent key, the key's embed ticket, and the session the
   ticket gives the canvas view. */

let server: Server

beforeAll(async () => {
  server = await startServer()
}, 70_000)

afterAll(() => server?.stop())

const STATE = 'fedcba9876543210fedcba9876543210'

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(server.base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('editor connect', () => {
  let owner: Client
  let key: string

  beforeAll(async () => {
    owner = new Client(server)
    await owner.signUp('editor-owner@test.dev', 'Editor Owner')
  })

  it('refuses a redirect that is not an editor deep link', async () => {
    const res = await owner.post('/api/editor/connect', { redirect: 'https://evil.test/auth', state: STATE })
    expect(res.status).toBe(400)
  })

  it('needs a session to approve an editor', async () => {
    const res = await post('/api/editor/connect', { redirect: 'vscode://doop.doop/auth', state: STATE })
    expect(res.status).toBe(401)
  })

  it('mints a code for the editor that is exchanged once for an agent key', async () => {
    const res = await owner.post('/api/editor/connect', { redirect: 'vscode://doop.doop/auth', state: STATE })
    expect(res.status).toBe(200)
    const { url, editor } = (await res.json()) as { url: string; editor: string }
    expect(editor).toBe('VS Code')
    const link = new URL(url)
    expect(link.protocol).toBe('vscode:')
    expect(link.searchParams.get('state')).toBe(STATE)
    const code = link.searchParams.get('code')!
    expect(url).not.toContain('dpk_')

    const exchanged = await post('/editor/exchange', { code })
    expect(exchanged.status).toBe(200)
    const body = (await exchanged.json()) as { key: string; user: { email: string } }
    expect(body.key).toMatch(/^dpk_/)
    expect(body.user.email).toBe('editor-owner@test.dev')
    key = body.key

    expect((await post('/editor/exchange', { code })).status).toBe(400)

    const keys = (await (await owner.get('/api/agent-keys')).json()) as { name: string }[]
    expect(keys.map((k) => k.name)).toContain('VS Code extension')
  })

  async function ticketFor(secret: string): Promise<string> {
    const res = await post('/editor/embed-ticket', {}, { Authorization: `Bearer ${secret}` })
    expect(res.status).toBe(200)
    return ((await res.json()) as { ticket: string }).ticket
  }

  function embed(ticket: string, to: string, dest = 'iframe') {
    return fetch(`${server.base}/editor/embed?ticket=${ticket}&to=${encodeURIComponent(to)}`, {
      redirect: 'manual',
      headers: dest ? { 'Sec-Fetch-Dest': dest } : {},
    })
  }

  const sessionCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.includes('session_token'))

  it('tells the extension whose key it holds', async () => {
    const res = await post('/editor/whoami', {}, { Authorization: `Bearer ${key}` })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe('editor-owner@test.dev')
    expect((await post('/editor/whoami', {}, { Authorization: 'Bearer dpk_not-a-real-key-at-all-000' })).status).toBe(
      401,
    )
  })

  it('signs the canvas view in with a single-use ticket and a partitioned cookie', async () => {
    expect(
      (await post('/editor/embed-ticket', {}, { Authorization: 'Bearer dpk_not-a-real-key-at-all-000' })).status,
    ).toBe(401)
    const ticket = await ticketFor(key)

    const res = await embed(ticket, '/c/abc')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/c/abc')
    const cookie = sessionCookie(res)!
    expect(cookie).toMatch(/SameSite=None/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/Partitioned/i)

    const me = await fetch(`${server.base}/api/me`, { headers: { Cookie: cookie.split(';')[0]! } })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { email: string }).email).toBe('editor-owner@test.dev')

    const again = await embed(ticket, '//evil.test')
    expect(again.headers.get('location')).toBe('/')
    expect(sessionCookie(again)).toBeUndefined()
  })

  it('signs nothing in when the ticket is opened as a page', async () => {
    for (const dest of ['document', '']) {
      const res = await embed(await ticketFor(key), '/c/abc', dest)
      expect(res.status).toBe(302)
      expect(sessionCookie(res)).toBeUndefined()
    }
  })

  it('gives every view of one key the same session, which signing out ends with the key', async () => {
    const first = sessionCookie(await embed(await ticketFor(key), '/'))!.split(';')[0]!
    const second = sessionCookie(await embed(await ticketFor(key), '/'))!.split(';')[0]!
    expect(second).toBe(first)

    expect((await post('/editor/sign-out', {}, { Authorization: `Bearer ${key}` })).status).toBe(204)
    expect((await post('/editor/whoami', {}, { Authorization: `Bearer ${key}` })).status).toBe(401)
    expect((await fetch(`${server.base}/api/me`, { headers: { Cookie: first } })).status).toBe(401)
    /* the person's own browser session is untouched */
    expect((await owner.get('/api/me')).status).toBe(200)
  })

  it('leaves no key behind for a sign-in nobody finished', async () => {
    const before = ((await (await owner.get('/api/agent-keys')).json()) as unknown[]).length
    const res = await owner.post('/api/editor/connect', { redirect: 'cursor://doop.doop/auth', state: STATE })
    expect(res.status).toBe(200)
    expect(((await (await owner.get('/api/agent-keys')).json()) as unknown[]).length).toBe(before)
  })
})
