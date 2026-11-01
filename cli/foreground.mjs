import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { register } from 'tsx/esm/api'
import { alive, CliError, readJson, writeJson } from './runtime.mjs'

/** Run the existing production server in this process. */
export async function foreground(directory, requestedPort) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = path.join(directory, '.doop-lock')
  if (existsSync(path.join(lock, 'pid'))) {
    const pid = Number(readFileSync(path.join(lock, 'pid'), 'utf8'))
    if (!alive(pid)) rmSync(lock, { recursive: true })
  }
  try {
    mkdirSync(lock)
  } catch (cause) {
    throw new CliError('Data directory is locked. Stop the other instance before starting another server.', { cause })
  }
  process.once('exit', () => rmSync(lock, { recursive: true, force: true }))
  writeFileSync(path.join(lock, 'pid'), String(process.pid))
  const configPath = path.join(directory, 'local-auth.json')
  if (!existsSync(configPath)) writeJson(configPath, { secret: randomBytes(32).toString('hex') })
  const config = readJson(configPath)
  if (!config || typeof config.secret !== 'string' || !/^[a-f0-9]{64}$/.test(config.secret))
    throw new CliError('Invalid local-auth.json. Restore it from a backup.')
  const port = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error) =>
      reject(new CliError(`Cannot bind local port ${requestedPort}: ${error.code}. Try --port 0.`, { cause: error })),
    )
    probe.listen(requestedPort, '127.0.0.1', () => {
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
  if (process.connected) process.once('disconnect', () => process.emit('SIGTERM'))
  await import('../server/index.ts')
}
