import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { claimLock } from '../cli/locks.mjs'
import { hasExited, stopChild } from '../cli/processes.mjs'
import { logs } from '../cli/service.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
function directory() {
  return mkdtempSync(path.join(tmpdir(), 'doop-lifecycle-'))
}
function remove(work) {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
async function fixture(code) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    windowsHide: true,
  })
  await once(child, 'message')
  return child
}

test('already signal-killed children do not hang shutdown', { timeout: 5000 }, async () => {
  const child = await fixture("setInterval(()=>{},1000);process.send('ready')")
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  assert.equal(hasExited(child), true)
  await stopChild(child)
})

test('shutdown forcibly ends a child that ignores graceful disconnection and SIGTERM', { timeout: 5000 }, async () => {
  const child = await fixture(
    "process.on('SIGTERM',()=>{});process.on('disconnect',()=>{});setInterval(()=>{},1000);process.send('ready')",
  )
  try {
    await stopChild(child, 50)
    assert.equal(hasExited(child), true)
    assert.equal(child.signalCode, 'SIGKILL')
  } finally {
    if (!hasExited(child)) child.kill('SIGKILL')
  }
})

test('a stale ownerless lock is reclaimed after its lease, independently of PID state', () => {
  const work = directory()
  try {
    const lock = path.join(work, '.service-lock')
    mkdirSync(lock)
    const stale = new Date(Date.now() - 20_000)
    utimesSync(lock, stale, stale)
    const release = claimLock(work, '.service-lock')
    assert.throws(() => claimLock(work, '.service-lock'), /Data directory is locked/)
    release()
    assert.equal(existsSync(lock), false)
  } finally {
    remove(work)
  }
})

test('concurrent processes cannot both claim the same data directory', { timeout: 10_000 }, async () => {
  const work = directory()
  const moduleUrl = pathToFileURL(path.join(root, 'cli/locks.mjs')).href
  const code = `import { claimLock } from ${JSON.stringify(moduleUrl)};
    try { claimLock(${JSON.stringify(work)}, '.doop-lock'); process.send({ acquired: true }) }
    catch { process.send({ acquired: false }) }
    process.on('disconnect',()=>process.exit(0)); setInterval(()=>{},1000)`
  const children = [
    spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: true,
    }),
    spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: true,
    }),
  ]
  try {
    const results = await Promise.all(children.map((child) => once(child, 'message')))
    assert.equal(results.filter(([value]) => value.acquired).length, 1)
  } finally {
    await Promise.all(children.map((child) => stopChild(child)))
    remove(work)
  }
})

test('logout always removes local cookies with a stopped or unreachable server', () => {
  const work = directory()
  try {
    for (const server of [undefined, 'http://127.0.0.1:1']) {
      const session = path.join(work, 'cli-session.json')
      writeFileSync(session, JSON.stringify({ origin: server || 'http://127.0.0.1:4400', cookie: 'fixture=session' }))
      const output = execFileSync(
        process.execPath,
        [
          path.join(root, 'cli/doop.mjs'),
          'auth',
          'logout',
          '--data-dir',
          work,
          ...(server ? ['--server', server] : []),
        ],
        { encoding: 'utf8', timeout: 5000 },
      )
      assert.equal(JSON.parse(output).authenticated, false)
      assert.equal(existsSync(session), false)
    }
  } finally {
    remove(work)
  }
})

test('debug logs returns only the bounded final bytes of a Unicode log', () => {
  const work = directory()
  try {
    writeFileSync(path.join(work, 'service.log'), '🙂'.repeat(10_000) + 'END!')
    const tail = logs(work)
    assert.equal(Buffer.byteLength(tail), 32_768)
    assert.ok(tail.endsWith('END!'))
  } finally {
    remove(work)
  }
})
