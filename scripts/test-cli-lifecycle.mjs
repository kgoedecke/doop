import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Deferred, Effect, Fiber } from 'effect'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { claimLock, logTail } from '../cli/files.ts'
import { hasExited, stopChild } from '../cli/process.ts'

const root = fileURLToPath(new URL('../', import.meta.url))

test('interrupting an Effect scope releases its lease', async () => {
  const work = directory()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make()
          const fiber = yield* Effect.scoped(
            claimLock(work, '.doop-lock').pipe(
              Effect.andThen(Deferred.succeed(ready, undefined)),
              Effect.andThen(Effect.never),
            ),
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(ready)
          yield* Fiber.interrupt(fiber)
          yield* claimLock(work, '.doop-lock')
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    assert.equal(existsSync(path.join(work, '.doop-lock')), false)
  } finally {
    remove(work)
  }
})
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
  await Effect.runPromise(stopChild(child))
})

test('shutdown forcibly ends a child that ignores graceful disconnection and SIGTERM', { timeout: 5000 }, async () => {
  const child = await fixture(
    "process.on('SIGTERM',()=>{});process.on('disconnect',()=>{});setInterval(()=>{},1000);process.send('ready')",
  )
  try {
    await Effect.runPromise(stopChild(child, 50))
    assert.equal(hasExited(child), true)
    assert.equal(child.signalCode, 'SIGKILL')
  } finally {
    if (!hasExited(child)) child.kill('SIGKILL')
  }
})

test('a stale ownerless lock is reclaimed after its lease, independently of PID state', async () => {
  const work = directory()
  try {
    const lock = path.join(work, '.service-lock')
    mkdirSync(lock)
    const stale = new Date(Date.now() - 20_000)
    utimesSync(lock, stale, stale)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* claimLock(work, '.service-lock')
          const error = yield* claimLock(work, '.service-lock').pipe(Effect.flip)
          assert.equal(error._tag, 'StorageError')
        }),
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    assert.equal(existsSync(lock), false)
  } finally {
    remove(work)
  }
})

test('concurrent processes cannot both claim the same data directory', { timeout: 10_000 }, async () => {
  const work = directory()
  const moduleUrl = pathToFileURL(path.join(root, 'cli/files.ts')).href
  const code = `import { claimLock } from ${JSON.stringify(moduleUrl)};
    import { Effect } from 'effect';
    import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
    import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
    const wait = Effect.callback(resume => { process.once('disconnect', () => resume(Effect.void)) });
    NodeRuntime.runMain(Effect.scoped(claimLock(${JSON.stringify(work)}, '.doop-lock').pipe(
      Effect.andThen(Effect.sync(() => process.send({ acquired: true }))), Effect.andThen(wait),
      Effect.catch(() => Effect.sync(() => process.send({ acquired: false })).pipe(Effect.andThen(wait)))
    )).pipe(Effect.provide(NodeFileSystem.layer)))`
  const children = [
    spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: true,
    }),
    spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: true,
    }),
  ]
  try {
    const results = await Promise.all(children.map((child) => once(child, 'message')))
    assert.equal(results.filter(([value]) => value.acquired).length, 1)
  } finally {
    await Promise.all(children.map((child) => Effect.runPromise(stopChild(child))))
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
        { encoding: 'utf8', timeout: 30_000 },
      )
      assert.equal(JSON.parse(output).authenticated, false)
      assert.equal(existsSync(session), false)
    }
  } finally {
    remove(work)
  }
})

test('debug logs returns only the bounded final bytes of a Unicode log', async () => {
  const work = directory()
  try {
    writeFileSync(path.join(work, 'service.log'), '🙂'.repeat(10_000) + 'END!')
    const tail = await Effect.runPromise(
      logTail(path.join(work, 'service.log')).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    assert.equal(Buffer.byteLength(tail), 32_768)
    assert.ok(tail.endsWith('END!'))
  } finally {
    remove(work)
  }
})
