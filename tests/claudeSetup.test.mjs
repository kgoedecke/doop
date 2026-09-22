import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import {
  prepareSetup,
  readSetup,
  deploySetup,
  verifySetup,
  updateEnv,
  waitForSetup,
} from '../scripts/lib/claude-setup.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import process from 'node:process'
import api from '../cantelop/src/api.ts'

const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('runs the public prepare-only command without credentials, a CLI, or any deployment', async () => {
  const { root } = await fixture()
  await mkdir(join(root, 'scripts/lib'), { recursive: true })
  for (const name of ['setup-claude.mjs', 'lib/claude-setup.mjs']) {
    const source = await readFile(new globalThis.URL(`../scripts/${name}`, import.meta.url), 'utf8')
    await writeFile(join(root, 'scripts', name), source)
  }
  const output = execFileSync(
    process.execPath,
    [join(root, 'scripts/setup-claude.mjs'), '--app', 'doop-reviewer', '--local', '--prepare-only'],
    {
      cwd: tmpdir(),
      env: { PATH: '' },
      encoding: 'utf8',
    },
  )
  expect(output).toContain('Configuration prepared')
  expect(output).not.toContain('BEGIN PRIVATE KEY')
  const setup = await readSetup(root)
  expect(setup.app).toBe('doop-reviewer')
  expect(setup.env.CLAUDE_REMOTE_SIGNING_KEY).toContain('BEGIN PRIVATE KEY')
  const conflicting = spawnSync(process.execPath, [join(root, 'scripts/setup-claude.mjs'), '--check'], {
    env: { PATH: '', CLAUDE_REMOTE_ISSUER: 'shell-value-must-not-appear' },
    encoding: 'utf8',
  })
  expect(conflicting.status).toBe(1)
  expect(conflicting.stderr).toContain('CLAUDE_REMOTE_ISSUER in your shell overrides .env')
  expect(conflicting.stderr).not.toContain('shell-value-must-not-appear')
  expect((await readSetup(root)).env.CLAUDE_REMOTE_ISSUER).toBe(setup.env.CLAUDE_REMOTE_ISSUER)
})

async function fixture(env = '') {
  const root = await mkdtemp(join(tmpdir(), 'doop-claude-setup-'))
  directories.push(root)
  const service = join(root, 'cantelop')
  await mkdir(service, { recursive: true })
  const manifest = await readFile(new globalThis.URL('../cantelop/cantelop.json', import.meta.url), 'utf8')
  await writeFile(join(service, 'cantelop.json'), manifest)
  await writeFile(join(root, '.env'), env)
  return { root, service, manifest }
}

it('generates a private Doop identity and public-only Cantelop configuration without changing the tracked target', async () => {
  const { root, service, manifest } = await fixture('# Keep this comment\nPORT=4500\nOTHER_SECRET=keep-me\n')
  const setup = await prepareSetup(root, { app: 'doop-alice', mcpOrigin: 'https://doop.example/' })
  const saved = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  expect(saved).toMatchObject({
    PORT: '4500',
    OTHER_SECRET: 'keep-me',
    CLAUDE_REMOTE_MCP_ORIGIN: 'https://doop.example',
  })
  expect(saved.CLAUDE_REMOTE_ISSUER).toMatch(/^urn:doop:/)
  const publicEnv = parseEnv(await readFile(join(service, '.env.setup'), 'utf8'))
  expect(Object.keys(publicEnv).sort()).toEqual(['AUTH_AUDIENCE', 'AUTH_ISSUER', 'AUTH_PUBLIC_JWK'])
  const jwk = JSON.parse(publicEnv.AUTH_PUBLIC_JWK)
  expect(jwk.d).toBeUndefined()
  expect(jwk).toEqual(createPublicKey(saved.CLAUDE_REMOTE_SIGNING_KEY.replace(/\\n/g, '\n')).export({ format: 'jwk' }))
  expect(await readFile(join(service, 'cantelop.json'), 'utf8')).toBe(manifest)
  expect(JSON.parse(await readFile(join(service, 'cantelop.local.json'), 'utf8')).app).toBe('doop-alice')
  expect(parseEnv(await readFile(join(root, '.env.claude-hosted'), 'utf8'))).not.toHaveProperty('OTHER_SECRET')
  expect((await stat(join(root, '.env'))).mode & 0o777).toBe(0o600)
  expect((await stat(join(root, '.env.claude-hosted'))).mode & 0o777).toBe(0o600)
  expect(setup.env.CLAUDE_REMOTE_URL).toBe('https://doop-alice.cantelop.dev')
})

it('reuses identity on retry and preserves existing manually configured users', async () => {
  const { root, service } = await fixture()
  const first = await prepareSetup(root, { app: 'doop-alice' })
  const second = await prepareSetup(root, { app: 'doop-alice', mcpOrigin: 'https://new-doop.example' })
  for (const key of ['CLAUDE_REMOTE_SIGNING_KEY', 'CLAUDE_REMOTE_ISSUER', 'CLAUDE_REMOTE_AUDIENCE'])
    expect(second.env[key]).toBe(first.env[key])
  // Losing the local manifest must not generate a new identity or app.
  await rm(join(service, 'cantelop.local.json'))
  expect((await readSetup(root)).app).toBe('doop-alice')
  const third = await prepareSetup(root, { app: 'doop-alice' })
  expect(third.env.CLAUDE_REMOTE_ISSUER).toBe(first.env.CLAUDE_REMOTE_ISSUER)
  expect(third.env.CLAUDE_REMOTE_SIGNING_KEY).toBe(first.env.CLAUDE_REMOTE_SIGNING_KEY)
})

it('rejects switching targets, invalid origins, and incomplete identities before changing files', async () => {
  const { root } = await fixture()
  await prepareSetup(root, { app: 'doop-alice' })
  const original = await readFile(join(root, '.env'), 'utf8')
  await expect(prepareSetup(root, { app: 'doop-bob' })).rejects.toThrow('already paired')
  await expect(
    prepareSetup(root, { app: 'doop-alice', mcpOrigin: 'https://user:secret@doop.example' }),
  ).rejects.toThrow('HTTPS origin')
  expect(await readFile(join(root, '.env'), 'utf8')).toBe(original)
  const incomplete = await fixture('CLAUDE_REMOTE_ISSUER=existing-user-identity\n')
  await expect(prepareSetup(incomplete.root, { app: 'doop-alice' })).rejects.toThrow('incomplete')
  expect(await readFile(join(incomplete.root, '.env'), 'utf8')).toBe('CLAUDE_REMOTE_ISSUER=existing-user-identity\n')
})

it('does not silently replace an existing key of a different algorithm', async () => {
  const key = generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
    .replace(/\n/g, '\\n')
  const { root } = await fixture(
    `CLAUDE_REMOTE_SIGNING_KEY='${key}'\nCLAUDE_REMOTE_ISSUER=old\nCLAUDE_REMOTE_AUDIENCE=old\n`,
  )
  await expect(prepareSetup(root, { app: 'doop-alice' })).rejects.toThrow('ES256')
})

it('updates exported, duplicate, and multiline dotenv assignments while retaining unrelated settings', () => {
  const source =
    '# original\nexport CLAUDE_REMOTE_ISSUER = "old" # comment\nSECRET="first\nCLAUDE_REMOTE_ISSUER=inside-secret\nlast"\nCLAUDE_REMOTE_SIGNING_KEY="line1\nline2"\nCLAUDE_REMOTE_ISSUER=duplicate\n'
  const next = updateEnv(source, { CLAUDE_REMOTE_ISSUER: 'stable', CLAUDE_REMOTE_SIGNING_KEY: 'pem\\nkey' })
  expect(parseEnv(next)).toEqual({
    CLAUDE_REMOTE_ISSUER: 'stable',
    CLAUDE_REMOTE_SIGNING_KEY: 'pem\\nkey',
    SECRET: 'first\nCLAUDE_REMOTE_ISSUER=inside-secret\nlast',
  })
  expect(next).toContain('# original')
  expect(updateEnv(next, { CLAUDE_REMOTE_ISSUER: 'stable' })).toBe(next)
})

it('deploys only the public env file and local manifest; failed deployment retains retryable identity', async () => {
  const { root } = await fixture()
  const setup = await prepareSetup(root, { app: 'doop-alice' })
  const execute = vi.fn().mockResolvedValue(undefined)
  await deploySetup(setup, execute)
  expect(execute.mock.calls).toEqual([
    ['bun', ['install', '--frozen-lockfile'], setup.service],
    [
      'cantelop',
      ['deploy', '--create-app', '--env-file', '.env.setup', '-config', 'cantelop.local.json'],
      setup.service,
    ],
  ])
  execute.mockRejectedValueOnce(new Error('offline'))
  await expect(deploySetup(setup, execute)).rejects.toThrow('offline')
  expect((await readSetup(root)).env.CLAUDE_REMOTE_SIGNING_KEY).toBe(setup.env.CLAUDE_REMOTE_SIGNING_KEY)
})

it('verifies a generated identity against the real API without provisioning a workspace or Claude session', async () => {
  const { root, service } = await fixture()
  const setup = await prepareSetup(root, { app: 'doop-alice' })
  const env = parseEnv(await readFile(join(service, '.env.setup'), 'utf8'))
  const open = vi.fn(() => {
    throw new Error('Must not allocate resources')
  })
  const router = api.create({ env, app: { workspaces: { open }, sessions: { open } } })
  const fetcher = (url, options) => router.handle(new globalThis.Request(url, options))
  await verifySetup(setup.env, fetcher)
  expect(open).not.toHaveBeenCalled()
  await expect(verifySetup({ ...setup.env, CLAUDE_REMOTE_AUDIENCE: 'wrong' }, fetcher)).rejects.toThrow('HTTP 401')
})

it('rejects wrong identity, redirects, and non-success responses without exposing response bodies', async () => {
  const { root } = await fixture()
  const setup = await prepareSetup(root, { app: 'doop-alice' })
  await expect(
    verifySetup(setup.env, async (_url, options) => {
      expect(options.redirect).toBe('error')
      return globalThis.Response.json({ userId: 'other', workspaceSlug: 'u-other' })
    }),
  ).rejects.toThrow('different identity')
  await expect(
    verifySetup(setup.env, async () => new globalThis.Response('private upstream details', { status: 503 })),
  ).rejects.toThrow('HTTP 503')
})

it('waits for release propagation but never retries a rejected identity', async () => {
  const unavailable = Object.assign(new Error('not deployed yet'), { retryable: true })
  const verify = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValue(undefined)
  const pause = vi.fn().mockResolvedValue(undefined)
  const log = vi.fn()
  await waitForSetup({}, { verify, pause, log })
  expect(verify).toHaveBeenCalledTimes(2)
  expect(pause).toHaveBeenCalledOnce()
  verify.mockRejectedValue(new Error('HTTP 401'))
  await expect(waitForSetup({}, { verify, pause, log })).rejects.toThrow('HTTP 401')
  expect(pause).toHaveBeenCalledOnce()
  verify.mockRejectedValue(unavailable)
  await expect(waitForSetup({}, { verify, pause, log, attempts: 2 })).rejects.toThrow('not deployed yet')
})
