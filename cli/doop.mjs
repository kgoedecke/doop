#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { register } from 'tsx/esm/api'

class CliError extends Error {}

function defaultDirectory() {
  if (process.platform === 'win32')
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Doop')
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'Doop')
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'doop')
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, 'data-dir': { type: 'string' } },
  })
  if (values.help || positionals.length === 0) {
    console.log(
      'Usage: doop start [--port 4400] [--data-dir <directory>]\n\nRuns the local app and MCP server on 127.0.0.1. Ctrl+C stops it.\nUse --port 0 to select an available port. Data is kept between runs.',
    )
    return
  }
  if (positionals.length !== 1 || positionals[0] !== 'start') throw new CliError('Unknown command. Run doop --help.')
  const requestedPort = values.port ?? '4400'
  if (!/^\d+$/.test(requestedPort) || Number(requestedPort) > 65535)
    throw new CliError('--port must be an integer from 0 to 65535.')
  const directory = path.resolve(values['data-dir'] ?? defaultDirectory())
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = path.join(directory, '.doop-lock')
  try {
    mkdirSync(lock)
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new CliError(
        `Data directory is locked: ${directory}. Stop the other instance. After a crash, remove .doop-lock only when no instance is running.`,
        { cause: error },
      )
    throw error
  }
  process.once('exit', () => rmSync(lock, { recursive: true, force: true }))
  writeFileSync(path.join(lock, 'pid'), String(process.pid))
  const configPath = path.join(directory, 'local-auth.json')
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({ secret: randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 })
  }
  let config
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new CliError('Cannot read local-auth.json. Restore it from your backup.', { cause: error })
  }
  if (!config || typeof config.secret !== 'string' || !/^[a-f0-9]{64}$/.test(config.secret))
    throw new CliError(
      'Invalid local-auth.json. Restore it from your backup; changing it invalidates existing sessions.',
    )
  const port = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error) =>
      reject(new CliError(`Cannot bind local port ${requestedPort}: ${error.code}. Try --port 0.`, { cause: error })),
    )
    probe.listen(Number(requestedPort), '127.0.0.1', () => {
      const address = probe.address()
      probe.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
  process.chdir(directory)
  Object.assign(process.env, {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    BETTER_AUTH_SECRET: config.secret,
  })
  console.log(
    `Doop local: http://127.0.0.1:${port}\nMCP: http://127.0.0.1:${port}/mcp\nData: ${directory}\nStarting server; wait for the ready message.`,
  )
  register()
  // A desktop/supervisor may own the IPC channel; disconnect is a graceful stop.
  if (process.connected) process.once('disconnect', () => process.emit('SIGTERM'))
  await import('../server/index.ts')
}

main().catch((error) => {
  console.error(
    error instanceof CliError || error?.code?.startsWith('ERR_PARSE_ARGS')
      ? error.message
      : 'Doop startup failed. Check file permissions, runtime dependencies and server environment settings.',
  )
  process.exit(1)
})
