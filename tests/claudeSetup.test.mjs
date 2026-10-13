import { CantelopClient } from '@cantelop/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import {
  prepareSetup,
  readSetup,
  deploySetup,
  verifySetup,
  updateEnv,
  waitForSetup,
} from '../scripts/lib/claude-setup.mjs'
const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function fixture(env = '') {
  const root = await mkdtemp(join(tmpdir(), 'doop-claude-setup-'))
  directories.push(root)
  const service = join(root, 'cantelop')
  await mkdir(join(service, 'src'), { recursive: true })
  for (const name of ['cantelop.json', 'src/cantelop.ts']) {
    await writeFile(
      join(service, name),
      await readFile(new globalThis.URL(`../cantelop/${name}`, import.meta.url), 'utf8'),
    )
  }
  await writeFile(join(root, '.env'), env)
  return { root, service }
}
it('prepares SDK 1.0 without credentials or deployment while keeping a literal local App definition', async () => {
  const { root, service } = await fixture()
  await mkdir(join(root, 'scripts/lib'), { recursive: true })
  for (const name of ['setup-claude.mjs', 'lib/claude-setup.mjs'])
    await writeFile(
      join(root, 'scripts', name),
      await readFile(new globalThis.URL(`../scripts/${name}`, import.meta.url), 'utf8'),
    )
  const output = execFileSync(
    process.execPath,
    [join(root, 'scripts/setup-claude.mjs'), '--app', 'doop-reviewer', '--local', '--prepare-only'],
    { env: { PATH: '' }, encoding: 'utf8' },
  )
  expect(output).toContain('Configuration prepared')
  expect(output).not.toContain('BEGIN PRIVATE KEY')
  const setup = await readSetup(root)
  expect(setup.app).toBe('doop-reviewer')
  expect(setup.env).not.toHaveProperty('CLAUDE_REMOTE_SIGNING_KEY')
  expect(await readFile(join(service, 'src/cantelop.local.ts'), 'utf8')).toContain("name: 'doop-reviewer'")
})
it('preserves old Workspace identity and credentials without putting backend secrets in the Sandbox', async () => {
  const { root, service } = await fixture(
    'CLAUDE_REMOTE_ISSUER=existing-issuer\nCLAUDE_REMOTE_SIGNING_KEY=legacy-private\nCANTELOP_INTEGRATION_TOKEN=app-token\nOTHER_SECRET=keep\n',
  )
  const tracked = await readFile(join(service, 'cantelop.json'), 'utf8')
  const first = await prepareSetup(root, { app: 'doop-alice', mcpOrigin: 'https://doop.example' })
  const second = await prepareSetup(root, { app: 'doop-alice' })
  expect(second.env.CLAUDE_REMOTE_ISSUER).toBe('existing-issuer')
  expect(second.env.CANTELOP_INTEGRATION_TOKEN).toBe('app-token')
  expect(first.env).not.toHaveProperty('CANTELOP_EDGE_URL')
  expect(parseEnv(await readFile(join(service, '.env.setup'), 'utf8'))).toEqual({})
  expect(parseEnv(await readFile(join(root, '.env.claude-hosted'), 'utf8'))).toEqual({
    CANTELOP_APP_SLUG: 'doop-alice',
    CLAUDE_REMOTE_ISSUER: 'existing-issuer',
    CANTELOP_INTEGRATION_TOKEN: 'app-token',
    CLAUDE_REMOTE_MCP_ORIGIN: 'https://doop.example',
  })
  expect(await readFile(join(service, 'cantelop.json'), 'utf8')).toBe(tracked)
  expect(JSON.parse(await readFile(join(service, 'cantelop.local.json'), 'utf8'))).toEqual({
    schema_version: 3,
    definition: 'src/cantelop.local.ts',
  })
  expect((await stat(join(root, '.env.claude-hosted'))).mode & 0o777).toBe(0o600)
  await rm(join(service, 'cantelop.local.json'))
  expect((await readSetup(root)).app).toBe('doop-alice')
})
it('rejects target switches and malformed origins before modifying saved identity', async () => {
  const { root } = await fixture()
  await prepareSetup(root, { app: 'doop-alice' })
  const saved = await readFile(join(root, '.env'), 'utf8')
  await expect(prepareSetup(root, { app: 'doop-bob' })).rejects.toThrow('already paired')
  await expect(
    prepareSetup(root, { app: 'doop-alice', mcpOrigin: 'https://user:secret@doop.example' }),
  ).rejects.toThrow('HTTPS origin')
  expect(await readFile(join(root, '.env'), 'utf8')).toBe(saved)
})
it('migrates saved connection aliases to native SDK variables without changing the Workspace namespace', async () => {
  const { root } = await fixture(
    'CLAUDE_REMOTE_APP=doop-alice\nCLAUDE_REMOTE_URL=https://doop-alice.cantelop.dev\nCLAUDE_REMOTE_ISSUER=existing-issuer\nCANTELOP_INTEGRATION_TOKEN=app-token\n',
  )
  expect((await readSetup(root)).app).toBe('doop-alice')
  const setup = await prepareSetup(root, { app: 'doop-alice' })
  expect(setup.env).toMatchObject({
    CANTELOP_APP_SLUG: 'doop-alice',
    CANTELOP_EDGE_URL: 'https://doop-alice.cantelop.dev',
    CLAUDE_REMOTE_ISSUER: 'existing-issuer',
    CANTELOP_INTEGRATION_TOKEN: 'app-token',
  })
  expect(parseEnv(await readFile(join(root, '.env'), 'utf8'))).toMatchObject(setup.env)
})
it('requires a platform-issued integration token and deploys without uploading backend environment', async () => {
  const { root } = await fixture()
  const setup = await prepareSetup(root, { app: 'doop-alice' })
  const execute = vi.fn().mockResolvedValue(undefined)
  await expect(deploySetup(setup, execute)).rejects.toThrow('App-scoped CANTELOP_INTEGRATION_TOKEN')
  expect(execute).not.toHaveBeenCalled()
  setup.env.CANTELOP_INTEGRATION_TOKEN = 'app-token'
  await deploySetup(setup, execute)
  expect(execute.mock.calls).toEqual([
    ['bun', ['install', '--frozen-lockfile'], setup.service],
    ['cantelop', ['deploy', '--create-app', '-config', 'cantelop.local.json'], setup.service],
    ['node', ['scripts/build-claude-client.mjs'], setup.root],
  ])
})
it('checks the deployed projection through the SDK without provisioning and keeps errors private', async () => {
  const app = new CantelopClient().app({
    name: 'doop-claude-runtime',
    edgeUrl: 'https://claude.example',
    accessToken: 'token',
    runtime: { receive() {} },
  })
  const fetcher = vi.fn(async (request) => {
    expect(request.url).toBe('https://claude.example/commands')
    expect(request.redirect).toBe('manual')
    expect(request.headers.get('Authorization')).toBe('Bearer token')
    const body = await request.json()
    expect(body.command).toEqual({ type: 'view' })
    expect(body.session.id).toContain(':setup-probe')
    return globalThis.Response.json({ error: { code: 'session_view_not_found' } }, { status: 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    await verifySetup(app, 'doop')
    for (const code of ['resource_not_found', 'session_view_not_found']) {
      fetcher.mockImplementation(async () => globalThis.Response.json({ error: { code } }, { status: 404 }))
      await verifySetup(app, 'doop')
    }
    for (const code of ['app_not_found', 'not_found']) {
      fetcher.mockImplementation(async () => globalThis.Response.json({ error: { code } }, { status: 404 }))
      await expect(verifySetup(app, 'doop')).rejects.toThrow('HTTP 404')
    }
    fetcher.mockImplementation(async () => new globalThis.Response('sensitive error', { status: 401 }))
    await expect(verifySetup(app, 'doop')).rejects.toThrow('HTTP 401')
    fetcher.mockImplementation(async () =>
      globalThis.Response.json({ error: { code: 'unavailable' } }, { status: 503 }),
    )
    await expect(verifySetup(app, 'doop')).rejects.toMatchObject({ retryable: true })
  } finally {
    vi.unstubAllGlobals()
  }
})
it('updates multiline dotenv assignments while retaining unrelated settings', () => {
  const source =
    'SECRET="first\nCLAUDE_REMOTE_ISSUER=inside-secret\nlast"\nexport CLAUDE_REMOTE_ISSUER=old\nCLAUDE_REMOTE_ISSUER=duplicate\n'
  const updated = updateEnv(source, { CLAUDE_REMOTE_ISSUER: 'stable' })
  expect(parseEnv(updated)).toEqual({
    SECRET: 'first\nCLAUDE_REMOTE_ISSUER=inside-secret\nlast',
    CLAUDE_REMOTE_ISSUER: 'stable',
  })
  expect(updateEnv(updated, { CLAUDE_REMOTE_ISSUER: 'stable' })).toBe(updated)
})
it('waits for transient release propagation and stops on credential failures', async () => {
  const unavailable = Object.assign(new Error('not available'), { retryable: true })
  const verify = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValue(undefined)
  const pause = vi.fn()
  await waitForSetup(verify, { pause, log: () => {} })
  expect(verify).toHaveBeenCalledTimes(2)
  expect(pause).toHaveBeenCalledOnce()
  verify.mockRejectedValue(new Error('HTTP 401'))
  await expect(waitForSetup(verify, { pause, log: () => {} })).rejects.toThrow('HTTP 401')
})
