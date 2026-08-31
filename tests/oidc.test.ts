import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The /api/oidc-config surface and the guarantee that configuring SSO
 * doesn't disturb the existing email/password flow. discoveryUrl is fetched
 * lazily at sign-in time (confirmed against better-auth's source), so a
 * fake, unreachable OIDC_ISSUER is fine here - only the config-gating
 * behavior is under test, not a real IdP round trip.
 */

const ROOT = process.cwd()

/* 4970-4972: test files run in parallel, each claiming its own port range
   (see admin.test.ts's PORT comment) - this file's is clear of every other
   test file's (checked: 4977, 4979, 4980, 4985, 4993-4996 for admin.test.ts's
   PORT/+1/+2/+3, and 4973 for oidcAccountLinking.test.ts). */
const PORT_UNCONFIGURED = 4970
const PORT_CONFIGURED = 4971
const PORT_BOOT_REFUSAL = 4972

let unconfigured: Server
let configured: Server

beforeAll(async () => {
  unconfigured = await startServer(PORT_UNCONFIGURED)
  configured = await startServer(PORT_CONFIGURED, {
    OIDC_ISSUER: 'https://idp.invalid',
    OIDC_CLIENT_ID: 'test-client',
    OIDC_CLIENT_SECRET: 'test-secret',
    OIDC_PROVIDER_NAME: 'Zitadel',
  })
}, 70_000)

afterAll(() => {
  unconfigured?.stop()
  configured?.stop()
})

describe('GET /api/oidc-config', () => {
  it('reports disabled when no OIDC env vars are set', async () => {
    const client = new Client(unconfigured)
    expect(await (await client.get('/api/oidc-config')).json()).toEqual({ enabled: false })
  })

  it('reports enabled with the configured display name, and never the secret', async () => {
    const client = new Client(configured)
    const res = await client.get('/api/oidc-config')
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ enabled: true, displayName: 'Zitadel' })
    expect(body).not.toContain('test-secret')
  })
})

describe('email/password login, unaffected by SSO configuration', () => {
  it('still works on a server with OIDC fully configured', async () => {
    const client = new Client(configured)
    await client.signUp('alice@test.dev', 'Alice')
    expect((await (await client.get('/api/me')).json()).email).toBe('alice@test.dev')
  })
})

describe('boot-time refusal on partial OIDC config', () => {
  /* Not startServer(): its /healthz poll waits up to 60s before giving up,
     which is the right patience for a server that might just be slow to
     boot, but wrong for asserting one that should never come up at all -
     this spawns directly and asserts the process exits on its own. */
  it('exits rather than boot when only some of the three required vars are set', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'doop-test-'))
    const proc = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), [path.join(ROOT, 'server', 'index.ts')], {
      cwd: dataDir,
      env: {
        ...process.env,
        PORT: String(PORT_BOOT_REFUSAL),
        NODE_ENV: undefined as unknown as string,
        OIDC_ISSUER: 'https://idp.invalid',
        // OIDC_CLIENT_ID / OIDC_CLIENT_SECRET deliberately left unset
      },
      stdio: 'ignore',
    })
    try {
      const exitCode = await new Promise<number | null>((resolve) => proc.on('exit', resolve))
      expect(exitCode).not.toBe(0)
    } finally {
      proc.kill()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 15_000)
})
