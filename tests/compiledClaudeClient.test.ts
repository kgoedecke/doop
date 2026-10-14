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
it('loads the real compiled client with Doop’s SDK and sends the matching runtime identity', async () => {
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
  const { doopClaude } = (await import(/* @vite-ignore */ pathToFileURL(join(outdir, 'client.mjs')).href)) as {
    doopClaude: ClaudeApp
  }
  const fetcher = vi.fn(async (request: Request) => {
    expect(request.url).toBe('https://claude.example/commands')
    expect(request.headers.get('X-Cantelop-Session-Runtime')).toBe(manifest.apps[0].session_runtime_id)
    expect(request.headers.get('Authorization')).toBe('Bearer test-app-token')
    const command = await request.json()
    return Response.json({ protocolVersion: 2, id: command.id, reply: { type: 'status', authenticated: true } })
  })
  vi.stubGlobal('fetch', fetcher)
  expect(await doopClaude.workspace({ slug: 'u-test-user' }).auth().status()).toBe(true)
  vi.stubGlobal('fetch', async () => Response.json({ error: { code: 'request_wait_timeout' } }, { status: 504 }))
  await expect(doopClaude.workspace({ slug: 'u-test-user' }).auth().status()).rejects.toBeInstanceOf(RemoteAppError)
}, 30_000)
