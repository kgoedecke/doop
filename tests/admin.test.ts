import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The admin surface, against the real server. Two things are being pinned
 * down here, and the second matters more than the first:
 *
 *  1. an admin can see every canvas on the instance;
 *  2. being an admin does NOT widen canAccessCanvas. The only way into
 *     someone's canvas is impersonation — which is read-only, leaves
 *     session.impersonatedBy behind, and cannot mint MCP tokens.
 */

let server: Server
let boss: Client
let alice: Client
let mallory: Client
let aliceId: string
let canvasId: string

beforeAll(async () => {
  server = await startServer({ ADMIN_EMAILS: 'boss@test.dev' })
  boss = new Client(server)
  alice = new Client(server)
  mallory = new Client(server)
  await boss.signUp('boss@test.dev', 'Boss Person')
  await alice.signUp('alice@test.dev', 'Alice')
  await mallory.signUp('mallory@test.dev', 'Mallory')
  aliceId = (await (await alice.get('/api/me')).json()).id
  const canvas = await (await alice.post('/api/canvases', { name: "Alice's private work" })).json()
  canvasId = canvas.id
}, 70_000)

afterAll(() => server?.stop())

describe('admin surface', () => {
  it('promotes ADMIN_EMAILS accounts at signup and nobody else', async () => {
    expect((await (await boss.get('/api/me')).json()).admin).toBe(true)
    expect((await (await alice.get('/api/me')).json()).admin).toBe(false)
  })

  it('still creates a first canvas on signup (the admin plugin adds its own db hooks)', async () => {
    const list = await (await alice.get('/api/canvases')).json()
    expect(list.some((c: { name: string }) => c.name === "Alice's first canvas")).toBe(true)
  })

  it('hides the admin surface from non-admins as 404, not 403', async () => {
    expect((await mallory.get('/api/admin/canvases')).status).toBe(404)
    expect((await mallory.get('/api/admin/users')).status).toBe(404)
    expect((await mallory.get('/api/admin/stats')).status).toBe(404)
  })

  it('lists every canvas on the instance with its owner', async () => {
    const { total, canvases } = await (await boss.get('/api/admin/canvases')).json()
    const entry = canvases.find((c: { id: string }) => c.id === canvasId)
    expect(entry?.name).toBe("Alice's private work")
    expect(entry?.owner?.email).toBe('alice@test.dev')
    expect(total).toBeGreaterThanOrEqual(4) // three first-canvases plus Alice's
  })

  it('does not leak other people’s canvases into the admin’s own dashboard', async () => {
    const mine = await (await boss.get('/api/canvases')).json()
    expect(mine.some((c: { id: string }) => c.id === canvasId)).toBe(false)
  })

  it('leaves canAccessCanvas untouched: an admin cannot open a private canvas', async () => {
    expect((await boss.get(`/api/canvases/${canvasId}`)).status).toBe(403)
    expect(await boss.joinWs(canvasId)).toEqual({ kind: 'closed', code: 4403 })
  })

  it('refuses to impersonate for non-admins', async () => {
    const res = await mallory.post('/api/auth/admin/impersonate-user', { userId: aliceId })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await (await mallory.get('/api/me')).json()).email).toBe('mallory@test.dev')
  })

  describe('viewing as another user', () => {
    it('swaps the session and reports who is behind it', async () => {
      expect((await boss.post('/api/auth/admin/impersonate-user', { userId: aliceId })).status).toBe(200)
      const me = await (await boss.get('/api/me')).json()
      expect(me.email).toBe('alice@test.dev')
      expect(me.admin).toBe(false) // the session is Alice's; only `impersonating` gives it away
      expect(me.impersonating).toEqual({ byName: 'Boss Person' })
    })

    it('opens the canvas through the ordinary gate', async () => {
      expect((await boss.get(`/api/canvases/${canvasId}`)).status).toBe(200)
      expect(await boss.joinWs(canvasId)).toEqual({ kind: 'init' })
    })

    it('is read-only', async () => {
      expect((await boss.patch(`/api/canvases/${canvasId}`, { name: 'renamed by admin' })).status).toBe(403)
      expect((await boss.post(`/api/canvases/${canvasId}/frames`, { name: 'sneaky' })).status).toBe(403)
      expect((await boss.post('/api/canvases', { name: 'as alice' })).status).toBe(403)
      expect((await boss.delete(`/api/canvases/${canvasId}`)).status).toBe(403)
      const canvas = await (await boss.get(`/api/canvases/${canvasId}`)).json()
      expect(canvas.name).toBe("Alice's private work")
    })

    it('closes the admin surface, since the session is no longer an admin', async () => {
      expect((await boss.get('/api/admin/canvases')).status).toBe(404)
    })

    it('cannot mint an MCP token as the person being viewed', async () => {
      const res = await boss.get('/api/auth/mcp/authorize?client_id=x&response_type=code')
      expect(res.status).toBe(403)
    })

    it('cannot edit the viewed account through better-auth either', async () => {
      /* /api/auth/* is mounted before the /api gate, so these would otherwise
         slip past the read-only rule and change someone else's account */
      expect((await boss.post('/api/auth/update-user', { name: 'Renamed By Admin' })).status).toBe(403)
      expect((await boss.post('/api/auth/change-email', { newEmail: 'stolen@test.dev' })).status).toBe(403)
      expect((await boss.post('/api/auth/revoke-sessions')).status).toBe(403)
      const me = await (await boss.get('/api/me')).json()
      expect(me.name).toBe('Alice') // unchanged
    })

    it('restores the admin on stop', async () => {
      expect((await boss.post('/api/auth/admin/stop-impersonating')).status).toBe(200)
      const me = await (await boss.get('/api/me')).json()
      expect(me.email).toBe('boss@test.dev')
      expect(me.admin).toBe(true)
      expect(me.impersonating).toBeUndefined()
      expect((await boss.get('/api/admin/canvases')).status).toBe(200)
    })
  })

  it('refuses to hand the role to an unverified claim on the address in production', async () => {
    /* No SMTP means signup is open and nothing can ever be verified, so
       whoever types the admin's address first would otherwise BE the admin.
       Production must refuse; development keeps working for convenience. */
    const prod = await startServer({
      ADMIN_EMAILS: 'boss@test.dev',
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'test-secret-not-for-real-use',
    })
    try {
      const impostor = new Client(prod)
      await impostor.signUp('boss@test.dev', 'Not The Boss')
      const me = await (await impostor.get('/api/me')).json()
      expect(me.email).toBe('boss@test.dev')
      expect(me.admin).toBe(false)
      expect((await impostor.get('/api/admin/canvases')).status).toBe(404)
    } finally {
      prod.stop()
    }
  }, 70_000)

  it('lets unverified accounts in when verification is optional, but still will not promote them', async () => {
    /* REQUIRE_EMAIL_VERIFICATION=false trades proof-of-address for signup
       conversion. The admin role must not be part of that trade: signing in
       is opened up, promotion still demands a verified address. */
    const open = await startServer({
      ADMIN_EMAILS: 'boss@test.dev',
      REQUIRE_EMAIL_VERIFICATION: 'false',
      SMTP_HOST: 'smtp.invalid.test', // mailer "configured", so verification is possible
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'test-secret-not-for-real-use',
    })
    try {
      const eager = new Client(open)
      await eager.signUp('boss@test.dev', 'Unverified Boss')
      /* the point of the flag: usable immediately, no inbox round trip */
      const me = await (await eager.get('/api/me')).json()
      expect(me.email).toBe('boss@test.dev')
      expect((await eager.get('/api/canvases')).status).toBe(200)
      /* ...but the address is still unproven, so no admin */
      expect(me.admin).toBe(false)
      expect((await eager.get('/api/admin/canvases')).status).toBe(404)
    } finally {
      open.stop()
    }
  }, 70_000)

  it('promotes accounts that already existed when ADMIN_EMAILS gained them', async () => {
    /* the real-world order: someone signs up first, and is named an admin
       later. Reboot the same database with a wider ADMIN_EMAILS. */
    server.stop({ keepData: true })
    const rebooted = await startServer({ ADMIN_EMAILS: 'boss@test.dev,alice@test.dev' }, server.dataDir)
    try {
      const promoted = new Client(rebooted)
      await promoted.post('/api/auth/sign-in/email', { email: 'alice@test.dev', password: 'password12345' })
      const me = await (await promoted.get('/api/me')).json()
      expect(me.email).toBe('alice@test.dev')
      expect(me.admin).toBe(true)
    } finally {
      rebooted.stop()
    }
  }, 70_000)
})
