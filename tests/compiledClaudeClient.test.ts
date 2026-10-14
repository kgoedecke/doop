import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { RemoteAppError } from '@cantelop/sdk'
type ClaudeApp = typeof import('../cantelop/.cantelop/client/client.mjs').doopClaude
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
it('uses the compiled client with backend credentials, shared SDK errors and isolated user Workspaces', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const outdir = join(root, 'cantelop/.cantelop/client')
  const manifest = JSON.parse(await readFile(join(outdir, 'cantelop-client.json'), 'utf8'))
  const declarations = await readFile(join(outdir, 'client.d.mts'), 'utf8')
  expect(declarations).toContain('doopClaude')
  expect(declarations).toContain('@cantelop/sdk/harnesses/claude/protocol')
  expect(declarations).not.toContain('createClaudeRuntime')
  vi.stubEnv('CANTELOP_APP_SLUG', 'doop-claude-runtime')
  vi.stubEnv('CANTELOP_EDGE_URL', 'https://claude.example')
  vi.stubEnv('CANTELOP_INTEGRATION_TOKEN', 'test-app-token')
  vi.stubEnv('CLAUDE_REMOTE_ISSUER', 'doop')
  const { checkRemoteAuth, remoteIdentity, remoteWorkspace } = await import('../server/remoteClaudeClient.ts')
  const workspaces: string[] = []
  const { doopClaude } = (await import(/* @vite-ignore */ pathToFileURL(join(outdir, 'client.mjs')).href)) as {
    doopClaude: ClaudeApp
  }
  const fetcher = vi.fn(async (request: Request) => {
    expect(request.url).toBe('https://claude.example/commands/auth')
    expect(request.headers.get('X-Cantelop-Session-Runtime')).toBe(manifest.apps[0].session_runtime_id)
    expect(request.headers.get('Authorization')).toBe('Bearer test-app-token')
    const command = await request.json()
    workspaces.push(command.workspace.slug)
    return Response.json({
      protocolVersion: 2,
      id: command.id,
      reply: { type: 'status', authenticated: command.command.auth.type !== 'logout' },
    })
  })
  vi.stubGlobal('fetch', fetcher)
  expect(await checkRemoteAuth('alice')).toBe(true)
  expect(await checkRemoteAuth('bob')).toBe(true)
  expect(await (await remoteWorkspace('alice')).auth().logout()).toBe(false)
  expect(workspaces).toEqual([
    `u-${remoteIdentity('alice')}`,
    `u-${remoteIdentity('bob')}`,
    `u-${remoteIdentity('alice')}`,
  ])
  vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'request_wait_timeout' } }, { status: 504 }))
  await expect(doopClaude.workspace({ slug: 'u-test-user' }).auth().status()).rejects.toBeInstanceOf(RemoteAppError)
}, 30_000)
