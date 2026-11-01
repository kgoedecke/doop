import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { entry, writeJson } from './runtime.mjs'
import { claimSupervisor, settings } from './service.mjs'
import { hasExited, stopChild as stopProcess } from './processes.mjs'

const directory = process.argv[2]
const token = randomBytes(32).toString('hex')
const socketId = randomBytes(16).toString('hex')
const socketPath =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\doop-${socketId}`
    : path.join(tmpdir(), `doop-${socketId.slice(0, 24)}.sock`)
let lock
let child
let server
let currentPort
let currentUrl
let busy = false
let stopping = false
let shutdownPromise
const stopChild = () => stopProcess(child)

async function startChild() {
  let output = ''
  child = spawn(
    process.execPath,
    [entry, 'start', '--port', String(currentPort ?? settings(directory).port), '--data-dir', directory],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  const launched = child
  launched.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-65_536)
    appendFileSync(path.join(directory, 'service.log'), chunk)
  })
  launched.stderr.on('data', (chunk) => appendFileSync(path.join(directory, 'service.log'), chunk))
  launched.once('error', () => {
    process.stderr.write('Backend process could not be launched.\n')
  })
  const deadline = Date.now() + 75_000
  while (Date.now() < deadline) {
    if (stopping) throw new Error('Startup cancelled by shutdown.')
    if (hasExited(launched)) throw new Error('Backend exited during startup.')
    const url = output.match(/Doop local: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
    if (url && output.includes('doop server')) {
      currentUrl = url
      currentPort = Number(new URL(url).port)
      return
    }
    await delay(100)
  }
  throw new Error('Backend startup timed out.')
}

function shutdown() {
  if (shutdownPromise) return shutdownPromise
  stopping = true
  shutdownPromise = (async () => {
    await stopChild()
    server?.close()
    rmSync(path.join(directory, 'service-state.json'), { force: true })
    lock?.()
    if (process.platform !== 'win32') rmSync(socketPath, { force: true })
    process.exit(0)
  })()
  return shutdownPromise
}

async function main() {
  lock = claimSupervisor(directory)
  await startChild()
  server = createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = ''
    socket.setTimeout(5_000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', async (chunk) => {
      buffer += chunk
      if (buffer.length > 4096) {
        socket.destroy()
        return
      }
      if (!buffer.includes('\n')) return
      socket.removeAllListeners('data')
      let request
      try {
        request = JSON.parse(buffer)
      } catch {
        socket.end('{}')
        return
      }
      if (!request || request.token !== token) {
        socket.end('{}')
        return
      }
      try {
        socket.setTimeout(0)
        if (request.command === 'status') {
          socket.end(
            JSON.stringify({
              running: !!child && !hasExited(child) && !busy && !stopping,
              pid: process.pid,
              backendPid: child?.pid,
              url: currentUrl,
              installed: settings(directory).installed,
            }),
          )
        } else if (request.command === 'stop') {
          socket.end('{"stopping":true}')
          await shutdown()
        } else if (request.command === 'reload' && !busy && !stopping) {
          busy = true
          await stopChild()
          if (stopping) {
            socket.end('{"error":"Reload cancelled by shutdown"}')
            return
          }
          const configuredPort = settings(directory).port
          if (configuredPort !== 0) currentPort = configuredPort
          await startChild()
          busy = false
          socket.end(JSON.stringify({ running: true, pid: process.pid, url: currentUrl, reloaded: true }))
        } else socket.end('{}')
      } catch {
        socket.end('{"error":"Service operation failed; inspect service.log"}')
        await shutdown()
      }
    })
  })
  server.on('error', () => {
    void shutdown()
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  if (process.platform !== 'win32') chmodSync(socketPath, 0o600)
  writeJson(path.join(directory, 'service-state.json'), {
    pid: process.pid,
    url: currentUrl,
    socket: socketPath,
    token,
  })
  const monitor = setInterval(() => {
    if (child && hasExited(child) && !busy) void shutdown()
  }, 1000)
  monitor.unref()
  process.once('SIGINT', () => {
    void shutdown()
  })
  process.once('SIGTERM', () => {
    void shutdown()
  })
}

main().catch(async () => {
  console.error('Service startup failed. Check the backend messages above.')
  if (lock) await shutdown()
  process.exit(1)
})
