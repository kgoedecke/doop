import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, fstatSync, readSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CliError, entry, readJson, writeJson } from './runtime.mjs'
import { claimLock } from './locks.mjs'

/** Service registration contains a private control capability; never print it. */
export function registration(directory) {
  return readJson(path.join(directory, 'service-state.json'), null)
}
/** Read persistent service settings. */
export function settings(directory) {
  return readJson(path.join(directory, 'service.json'), { port: 4400, installed: false, autostart: false })
}

/** Send an authenticated command over the local service control channel. */
export function control(directory, command) {
  const state = registration(directory)
  if (!state) return Promise.resolve(null)
  return new Promise((resolve) => {
    const socket = createConnection(state.socket)
    let result = ''
    socket.setTimeout(command === 'reload' ? 90_000 : 5000, () => socket.destroy())
    socket.on('error', () => resolve(null))
    socket.on('connect', () => socket.write(JSON.stringify({ token: state.token, command }) + '\n'))
    socket.on('data', (chunk) => {
      result += chunk
      if (result.length > 16_384) socket.destroy()
    })
    socket.on('close', () => {
      try {
        resolve(JSON.parse(result))
      } catch {
        resolve(null)
      }
    })
  })
}

/** Return safe operational metadata, excluding control credentials. */
export async function serviceStatus(directory) {
  const response = await control(directory, 'status')
  return response ?? { running: false, installed: settings(directory).installed }
}

/** Start a detached supervisor and wait for its authenticated ready response. */
export async function startService(directory, port) {
  const existing = await control(directory, 'status')
  if (existing?.running) return existing
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const config = settings(directory)
  if (port !== undefined) {
    config.port = port
    writeJson(path.join(directory, 'service.json'), config)
  }
  const log = openSync(path.join(directory, 'service.log'), 'a', 0o600)
  const child = spawn(process.execPath, [path.join(path.dirname(entry), 'service-runner.mjs'), directory], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  })
  let launchError = false
  child.once('error', () => {
    launchError = true
  })
  child.unref()
  closeSync(log)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const status = await control(directory, 'status')
    if (status?.running) return status
    if (launchError || child.exitCode !== null || child.signalCode !== null) break
    await delay(150)
  }
  // The runner owns a startup timeout and cleans up its child on failure.
  throw new CliError('Background server did not become ready. Inspect doop debug logs.')
}

/** Gracefully stop the supervisor and backend; never signal a PID from a stale file. */
export async function stopService(directory) {
  const response = await control(directory, 'stop')
  if (!response) {
    return { running: false }
  }
  if (!response.stopping) throw new CliError('Service is busy. Retry stop after the current operation completes.')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (!existsSync(path.join(directory, 'service-state.json'))) return { running: false }
    await delay(100)
  }
  throw new CliError('Service shutdown timed out. Inspect service.log before restarting.')
}

/** Return the current endpoint without starting a service implicitly. */
export async function endpoint(directory, explicit) {
  if (explicit) {
    let url
    try {
      url = new URL(explicit)
    } catch (cause) {
      throw new CliError('Invalid --server URL.', { cause })
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new CliError('--server must be an HTTP(S) origin without credentials, paths or query parameters.')
    return url.origin
  }
  const status = await serviceStatus(directory)
  if (!status.running)
    throw new CliError('No background server is running. Run doop service start, or pass --server URL.')
  return status.url
}

/** Read only the last bounded portion of server logs. */
export function logs(directory) {
  const file = path.join(directory, 'service.log')
  if (!existsSync(file)) return 'No service logs yet.'
  const fd = openSync(file, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, 32_768)
    const buffer = Buffer.alloc(length)
    const count = readSync(fd, buffer, 0, length, size - length)
    return buffer.subarray(0, count).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Claim a supervisor heartbeat lease, independent of PID reuse. */
export function claimSupervisor(directory) {
  return claimLock(directory, '.service-lock')
}
