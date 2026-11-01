#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { CliError, dataDirectory, metadata, parsePort } from './runtime.mjs'

const help = `Usage: doop start [--port 4400] [--data-dir <directory>]

Doop command line interface
  start | serve                 Run the local app, API and MCP in the foreground
  service [status]              Inspect the background server
  service install [--autostart]  Install configuration (optional login startup)
  service start | stop          Start or gracefully stop the background server
  service restart | uninstall   Restart or unregister the service, keeping data
  reload                        Restart the managed backend with current configuration
  api [METHOD] /path            Request the running API (--data JSON or @file)
  auth login | logout | status   Manage the CLI's local account session
  pair [--client NAME]          Configure a local MCP client using OAuth
  skill list | show | install    Inspect or install the bundled agent skill
  debug [paths|config|logs]      Inspect paths, safe configuration or server logs
  doctor                        Check runtime, assets, data and service health
  update | upgrade [tarball]    Upgrade the npm installation (--dry-run available)

Global: --data-dir PATH, --json, --help, --version
Service: --port NUMBER (0 selects an available port)
API: --server URL, --data JSON|@file
Auth: --email EMAIL, --password-stdin (otherwise prompted privately)
Pair/skill: --client codex|claude|cursor|opencode, --directory PATH, --force
Update: --prefix PATH, --dry-run
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      port: { type: 'string' },
      'data-dir': { type: 'string' },
      server: { type: 'string' },
      data: { type: 'string', short: 'd' },
      email: { type: 'string' },
      'password-stdin': { type: 'boolean' },
      client: { type: 'string' },
      directory: { type: 'string' },
      prefix: { type: 'string' },
      'dry-run': { type: 'boolean' },
      autostart: { type: 'boolean' },
      force: { type: 'boolean' },
    },
  })
  if (values.version) {
    console.log(metadata.version)
    return
  }
  if (values.help || !positionals.length) {
    console.log(help)
    return
  }
  const [command, ...args] = positionals
  const directory = dataDirectory(values['data-dir'])
  if (command === 'start' || command === 'serve') {
    if (args.length) throw new CliError('Unexpected argument. Run doop --help.')
    const { foreground } = await import('./foreground.mjs')
    return foreground(directory, parsePort(values.port))
  }
  const { dispatch } = await import('./commands.mjs')
  await dispatch(command, args, values, directory)
}

main().catch((error) => {
  console.error(
    error instanceof CliError || error?.code?.startsWith('ERR_PARSE_ARGS')
      ? error.message
      : 'Doop command failed. Check configuration, file permissions and service logs.',
  )
  process.exitCode = 1
})
