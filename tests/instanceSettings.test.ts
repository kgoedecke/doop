import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { refusalFor } from '../server/instanceSettings.ts'

/**
 * Admin → Sign-in: the instance's sign-in policy, against the real server.
 * Email/password sign-up can be turned off, a default workspace takes every
 * newcomer in, and the SSO auto-redirect is refused until an admin has
 * come in through SSO (checked as the pure rule below: no IdP to drive here).
 */

let server: Server
let boss: Client
let mallory: Client

beforeAll(async () => {
  server = await startServer({
    ADMIN_EMAILS: 'boss@test.dev',
    OIDC_ISSUER: 'https://idp.invalid',
    OIDC_CLIENT_ID: 'test-client',
    OIDC_CLIENT_SECRET: 'test-secret',
    OIDC_PROVIDER_NAME: 'Zitadel',
  })
  boss = new Client(server)
  mallory = new Client(server)
  await boss.signUp('boss@test.dev', 'Boss Person')
  await mallory.signUp('mallory@test.dev', 'Mallory')
}, 70_000)

afterAll(() => server?.stop())

async function policy() {
  return (await (await new Client(server).get('/api/oidc-config')).json()) as {
    emailPasswordSignup: boolean
    ssoAutoRedirect: boolean
  }
}

describe('the refusal rule', () => {
  const ctx = { ssoConfigured: true, ssoAdminSignedIn: true, workspaceExists: (id: string) => id === 'ws1' }
  it('accepts a sound patch', () => {
    expect(refusalFor({ emailPasswordSignup: false, ssoAutoRedirect: true, defaultWorkspaceId: 'ws1' }, ctx)).toBeNull()
    expect(refusalFor({ defaultWorkspaceId: null }, ctx)).toBeNull()
  })
  it('refuses auto-redirect without SSO, or before an admin has used it', () => {
    expect(refusalFor({ ssoAutoRedirect: true }, { ...ctx, ssoConfigured: false })).toBe('sso_not_configured')
    expect(refusalFor({ ssoAutoRedirect: true }, { ...ctx, ssoAdminSignedIn: false })).toBe('sso_no_admin_signed_in')
    /* turning it off never needs the guard */
    expect(refusalFor({ ssoAutoRedirect: false }, { ...ctx, ssoConfigured: false })).toBeNull()
  })
  it('refuses a workspace that does not exist', () => {
    expect(refusalFor({ defaultWorkspaceId: 'gone' }, ctx)).toBe('workspace_not_found')
  })
})

describe('GET/PATCH /api/admin/instance-settings', () => {
  it('is 404 for non-admins', async () => {
    expect((await mallory.get('/api/admin/instance-settings')).status).toBe(404)
    expect((await mallory.patch('/api/admin/instance-settings', { emailPasswordSignup: false })).status).toBe(404)
  })

  it('starts at the defaults, with the providers and the workspaces to pick from', async () => {
    const view = await (await boss.get('/api/admin/instance-settings')).json()
    expect(view.settings).toEqual({ emailPasswordSignup: true, ssoAutoRedirect: false, defaultWorkspaceId: null })
    expect(view.providers).toMatchObject({ enabled: true, displayName: 'Zitadel' })
    expect(view.ssoAdminSignedIn).toBe(false)
    expect(Array.isArray(view.workspaces)).toBe(true)
  })

  it('rejects a malformed body', async () => {
    const res = await boss.patch('/api/admin/instance-settings', { emailPasswordSignup: 'no' })
    expect(res.status).toBe(400)
    expect((await boss.patch('/api/admin/instance-settings', { other: true })).status).toBe(400)
  })

  it('refuses the auto-redirect until an admin has signed in through SSO', async () => {
    const res = await boss.patch('/api/admin/instance-settings', { ssoAutoRedirect: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ refusal: 'sso_no_admin_signed_in' })
    expect((await policy()).ssoAutoRedirect).toBe(false)
  })

  it('refuses a default workspace that does not exist', async () => {
    const res = await boss.patch('/api/admin/instance-settings', { defaultWorkspaceId: 'nope' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ refusal: 'workspace_not_found' })
  })
})

describe('email/password sign-up off', () => {
  it('hides it from the sign-in page and refuses the call; sign-in still works', async () => {
    const res = await boss.patch('/api/admin/instance-settings', { emailPasswordSignup: false })
    expect(res.status, await res.text()).toBe(200)
    expect((await policy()).emailPasswordSignup).toBe(false)

    const newcomer = new Client(server)
    const signup = await newcomer.post('/api/auth/sign-up/email', {
      email: 'late@test.dev',
      password: 'password12345',
      name: 'Late',
    })
    expect(signup.status).toBe(403)
    expect((await signup.json()).code).toBe('SIGNUP_DISABLED')
    expect(await (await newcomer.post('/api/account-exists', { email: 'late@test.dev' })).json()).toEqual({
      exists: false,
    })

    const again = new Client(server)
    const signin = await again.post('/api/auth/sign-in/email', { email: 'mallory@test.dev', password: 'password12345' })
    expect(signin.status).toBe(200)
    expect((await (await again.get('/api/me')).json()).email).toBe('mallory@test.dev')
  })

  it('comes back on', async () => {
    await boss.patch('/api/admin/instance-settings', { emailPasswordSignup: true })
    expect((await policy()).emailPasswordSignup).toBe(true)
  })
})

describe('the default workspace', () => {
  let workspaceId: string

  it('takes every new account in as a member', async () => {
    const created = await (await boss.post('/api/workspaces', { name: 'Everyone' })).json()
    workspaceId = created.id
    const res = await boss.patch('/api/admin/instance-settings', { defaultWorkspaceId: workspaceId })
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.settings.defaultWorkspaceId).toBe(workspaceId)

    const newcomer = new Client(server)
    await newcomer.signUp('newcomer@test.dev', 'Newcomer')
    const { workspaces: mine } = (await (await newcomer.get('/api/workspaces')).json()) as {
      workspaces: { id: string; role: string }[]
    }
    expect(mine.find((ws) => ws.id === workspaceId)?.role).toBe('member')
  })

  it('leaves accounts that signed up before it alone', async () => {
    const { workspaces: mine } = (await (await mallory.get('/api/workspaces')).json()) as {
      workspaces: { id: string }[]
    }
    expect(mine.some((ws) => ws.id === workspaceId)).toBe(false)
  })

  it('survives a restart and reads as none once the workspace is gone', async () => {
    server.stop({ keepData: true })
    server = await startServer({ ADMIN_EMAILS: 'boss@test.dev' }, server.dataDir)
    let view = await (await boss.get('/api/admin/instance-settings')).json()
    expect(view.settings.defaultWorkspaceId).toBe(workspaceId)

    expect((await boss.delete(`/api/workspaces/${workspaceId}`)).status).toBeLessThan(300)
    view = await (await boss.get('/api/admin/instance-settings')).json()
    expect(view.settings.defaultWorkspaceId).toBeNull()
  }, 70_000)
})
