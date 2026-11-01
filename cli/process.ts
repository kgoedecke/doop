import { Context, Deferred, Effect, Layer, Scope, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as NodeStream from '@effect/platform-node/NodeStream'
import { spawn, type ChildProcess as NodeChild } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Configuration } from './config.ts'
import { ProcessError } from './model.ts'

/** Observes both exit channels; safe even after the exit event has fired. */
export function hasExited(child: NodeChild): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

const waitForExit = (child: NodeChild) =>
  Effect.callback<void>((resume) => {
    if (hasExited(child)) {
      resume(Effect.void)
      return
    }
    const done = () => resume(Effect.void)
    child.once('exit', done)
    return Effect.sync(() => child.off('exit', done))
  })

/** Attempt IPC shutdown, then enforce a bounded SIGKILL escalation. */
export const stopChild = Effect.fn('Processes.stopChild')(
  function* (child: NodeChild, graceMs = 8000) {
    if (hasExited(child)) return
    yield* Effect.sync(() => {
      if (child.connected) child.disconnect()
    })
    yield* waitForExit(child).pipe(
      Effect.timeoutOrElse({
        duration: graceMs,
        orElse: () =>
          Effect.sync(() => child.kill('SIGKILL')).pipe(Effect.andThen(waitForExit(child)), Effect.timeout(5000)),
      }),
    )
  },
  Effect.mapError(
    () => new ProcessError({ operation: 'stopChild', message: 'Backend shutdown exceeded its termination budget.' }),
  ),
)

/** Narrow application view of an owned backend process. */
export interface BackendProcess {
  readonly pid: number
  readonly stdout: Stream.Stream<Uint8Array, ProcessError>
  readonly stderr: Stream.Stream<Uint8Array, ProcessError>
  readonly exited: Effect.Effect<void>
  readonly running: Effect.Effect<boolean>
}

/** OS process authority, including deliberate detached-service launches. */
export class Processes extends Context.Service<
  Processes,
  {
    readonly backend: (
      directory: string,
      environment: NodeJS.ProcessEnv,
    ) => Effect.Effect<BackendProcess, ProcessError, Scope.Scope>
    readonly detach: (
      args: ReadonlyArray<string>,
    ) => Effect.Effect<{ readonly pid: number; readonly exited: Effect.Effect<boolean> }, ProcessError>
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<{ readonly code: number; readonly stdout: string; readonly stderr: string }, ProcessError>
  }
>()('doop/Processes') {}

/** Use Effect's platform spawner for commands; adapt Node IPC only for the backend. */
export const processesLayer = Layer.effect(
  Processes,
  Effect.gen(function* () {
    const config = yield* Configuration
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const backend = Effect.fn('Processes.backend')(function* (directory: string, environment: NodeJS.ProcessEnv) {
      const loader = yield* Effect.try({
        try: () => pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        catch: () =>
          new ProcessError({ operation: 'resolveLoader', message: 'The installed TypeScript loader is missing.' }),
      })
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            spawn(config.executable, ['--import', loader, `${config.root}/server/index.ts`], {
              cwd: directory,
              env: environment,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            }),
          catch: () => new ProcessError({ operation: 'spawnBackend', message: 'Cannot launch the local backend.' }),
        }),
        (child) =>
          stopChild(child).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                child.stdout?.destroy()
                child.stderr?.destroy()
              }),
            ),
            Effect.catch((error) => Effect.logError(error.message)),
          ),
      )
      const exit = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void, ProcessError>()
      const onExit = () => Deferred.doneUnsafe(exit, Effect.void)
      const onError = () =>
        Deferred.doneUnsafe(
          started,
          Effect.fail(new ProcessError({ operation: 'spawnBackend', message: 'Cannot launch the local backend.' })),
        )
      const onSpawn = () => Deferred.doneUnsafe(started, Effect.void)
      child.once('exit', onExit)
      child.once('error', onError)
      child.once('spawn', onSpawn)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          child.off('exit', onExit)
          child.off('error', onError)
          child.off('spawn', onSpawn)
        }),
      )
      yield* Deferred.await(started)
      if (!child.pid || !child.stdout || !child.stderr)
        return yield* new ProcessError({ operation: 'spawnBackend', message: 'Backend pipes were not created.' })
      const stdout = child.stdout
      const stderr = child.stderr
      return {
        pid: child.pid,
        stdout: NodeStream.fromReadable({
          evaluate: () => stdout,
          closeOnDone: false,
          onError: () => new ProcessError({ operation: 'stdout', message: 'Backend output failed.' }),
        }),
        stderr: NodeStream.fromReadable({
          evaluate: () => stderr,
          closeOnDone: false,
          onError: () => new ProcessError({ operation: 'stderr', message: 'Backend error output failed.' }),
        }),
        exited: Deferred.await(exit),
        running: Effect.sync(() => !hasExited(child)),
      }
    })
    const detach = Effect.fn('Processes.detach')(function* (args: ReadonlyArray<string>) {
      const child = yield* Effect.try({
        try: () =>
          spawn(config.executable, [...args], {
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
            env: config.environment,
          }),
        catch: () => new ProcessError({ operation: 'detach', message: 'Cannot launch the background service.' }),
      })
      yield* Effect.callback<void, ProcessError>((resume) => {
        const started = () => resume(Effect.void)
        const failed = () =>
          resume(
            Effect.fail(new ProcessError({ operation: 'detach', message: 'Cannot launch the background service.' })),
          )
        child.once('spawn', started)
        child.once('error', failed)
        return Effect.sync(() => {
          child.off('spawn', started)
          child.off('error', failed)
        })
      })
      child.unref()
      if (!child.pid)
        return yield* new ProcessError({
          operation: 'detach',
          message: 'Background service did not receive a process ID.',
        })
      return { pid: child.pid, exited: Effect.sync(() => hasExited(child)) }
    })
    const run = Effect.fn('Processes.run')(
      function* (command: string, args: ReadonlyArray<string>) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, [...args], {
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
                windowsHide: true,
                forceKillAfter: '8 seconds',
                env: config.environment,
              }),
            )
            const capture = (stream: typeof handle.stdout) =>
              stream.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => '',
                  (text, chunk) => (text + chunk).slice(-1_048_576),
                ),
              )
            const [stdout, stderr, code] = yield* Effect.all(
              [capture(handle.stdout), capture(handle.stderr), handle.exitCode],
              { concurrency: 'unbounded' },
            )
            return { code: Number(code), stdout, stderr }
          }),
        )
      },
      Effect.mapError(() => new ProcessError({ operation: 'run', message: 'External command could not complete.' })),
    )
    return Processes.of({ backend, detach, run })
  }),
)
