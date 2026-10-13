import { claudeRuntimeOrigin } from './remoteClaudeOrigins.ts'

export type ClaudeApp = typeof import('../.cantelop/claude-client/client.mjs').doopClaude
let pending: Promise<ClaudeApp> | undefined
export function loadClaudeApp(): Promise<ClaudeApp> {
  if (!pending) {
    const origin = claudeRuntimeOrigin(process.env.CLAUDE_REMOTE_URL!).origin
    pending = (async () => {
      // The compiler removes all native runtime/auth dependencies and stamps
      // the same runtime identity used by the deployed protocol Edge Worker.
      const { readFile } = await import('node:fs/promises')
      const manifest = JSON.parse(
        await readFile(new URL('../.cantelop/claude-client/cantelop-client.json', import.meta.url), 'utf8'),
      ) as { apps: { name: string }[] }
      const app = manifest.apps[0]?.name
      if (!app || manifest.apps.length !== 1) throw new Error('Expected one hosted Claude App.')
      if (process.env.CLAUDE_REMOTE_APP && process.env.CLAUDE_REMOTE_APP !== app)
        throw new Error('The compiled backend belongs to a different App.')
      process.env.CANTELOP_APP_SLUG = app
      process.env.CANTELOP_EDGE_URL = origin
      const module = await import('../.cantelop/claude-client/client.mjs')
      return module.doopClaude
    })().catch(() => {
      pending = undefined
      throw new Error('Build the SDK 1.0 backend client with bun run cantelop:client, then restart Doop.')
    })
  }
  return pending
}
