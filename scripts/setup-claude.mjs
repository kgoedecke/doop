import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  readSetup,
  prepareSetup,
  deploySetup,
  verifySetup,
  waitForSetup,
  run,
  httpsOrigin,
} from './lib/claude-setup.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      'mcp-origin': { type: 'string' },
      local: { type: 'boolean' },
      'prepare-only': { type: 'boolean' },
      check: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(`Usage: bun run cantelop:setup [--app NAME] [--mcp-origin https://doop.example | --local]

Run cantelop login first. Requires Node 22+, Bun, Cantelop CLI, and Docker.
Generates a private identity, deploys your app, and verifies its JWT handshake.
--local          Start the existing MCP tunnel after deployment; keep this terminal open.
--prepare-only   Write configuration without installing, deploying, or starting a tunnel.
--check          Verify the saved handshake without deploying or creating a workspace.

Reruns reuse the saved identity. Hosted environment export: .env.claude-hosted (private).
No credentials are printed or copied from another developer.`)
    return
  }
  if (values.local && values['mcp-origin']) throw new Error('Choose --local or --mcp-origin, not both.')
  if (values.check && (values.app || values.local || values['mcp-origin'] || values['prepare-only']))
    throw new Error('Use --check by itself to verify the saved configuration.')
  const current = await readSetup(root)
  for (const name of [
    'CLAUDE_REMOTE_URL',
    'CLAUDE_REMOTE_SIGNING_KEY',
    'CLAUDE_REMOTE_ISSUER',
    'CLAUDE_REMOTE_AUDIENCE',
    'CLAUDE_REMOTE_MCP_ORIGIN',
  ]) {
    const shellValue = process.env[name]?.replace(/\\n/g, '\n')
    const savedValue = current.env[name]?.replace(/\\n/g, '\n')
    if (shellValue && shellValue !== savedValue)
      throw new Error(
        `${name} in your shell overrides .env. Save your existing configuration in .env and unset the shell override before setup.`,
      )
  }
  if (values.check) {
    if (
      !current.env.CLAUDE_REMOTE_SIGNING_KEY ||
      !current.env.CLAUDE_REMOTE_ISSUER ||
      !current.env.CLAUDE_REMOTE_AUDIENCE
    )
      throw new Error('No complete saved identity. Run setup first.')
    await verifySetup(current.env)
    console.log('Doop → Cantelop handshake verified. No Claude session was started.')
    return
  }
  let app = values.app || current.app
  let mcpOrigin = values['mcp-origin']
  let local = values.local
  const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
  try {
    if (!app) {
      if (!terminal) throw new Error('Noninteractive setup requires --app NAME.')
      const suggested = `doop-claude-${randomUUID().slice(0, 8)}`
      app = (await terminal.question(`Cantelop app name [${suggested}]: `)).trim() || suggested
    }
    if (!mcpOrigin && !local) {
      const saved = current.env.CLAUDE_REMOTE_MCP_ORIGIN || current.env.BETTER_AUTH_URL
      const defaultOrigin = saved?.startsWith('https://') && !saved.includes('.trycloudflare.com') ? saved : 'local'
      if (!terminal && defaultOrigin === 'local')
        throw new Error('Specify --local or --mcp-origin https://your-doop-origin.')
      const answer = terminal
        ? (
            await terminal.question(`Public Doop origin, or local for a temporary MCP tunnel [${defaultOrigin}]: `)
          ).trim() || defaultOrigin
        : defaultOrigin
      if (answer === 'local') local = true
      else mcpOrigin = answer
    }
  } finally {
    terminal?.close()
  }
  if (mcpOrigin) mcpOrigin = httpsOrigin(mcpOrigin)
  const setup = await prepareSetup(root, { app, mcpOrigin })
  console.log(`Saved configuration for ${app}. Private key stays in Doop; Cantelop receives only the public key.
Hosted Doop configuration: .env.claude-hosted (private; import into your hosting provider).
Deployment target: services/claude-runtime/cantelop.local.json`)
  if (values['prepare-only']) {
    console.log('Configuration prepared. Rerun without --prepare-only to deploy and verify.')
    if (local) console.log('For local MCP access, run bun run cantelop:tunnel in a second terminal.')
    return
  }
  await deploySetup(setup)
  await waitForSetup(setup.env)
  console.log('Handshake verified. Restart Doop, then connect your Claude account in Settings → Claude Plan.')
  if (local) {
    console.log('Starting the MCP tunnel. Install cloudflared if needed; keep this terminal open while Claude works.')
    await run(process.execPath, ['--env-file-if-exists=.env', 'scripts/dev-mcp-tunnel.mjs'], root)
  }
}

main().catch((error) => {
  // Never print CLI response bodies, private configuration, or crypto error internals.
  console.error(error instanceof Error ? error.message : 'Claude setup failed.')
  process.exitCode = 1
})
