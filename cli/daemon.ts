import { Deferred, Effect, Exit, FileSystem, Option, Redacted, Ref, Schema, Scope, Semaphore } from 'effect'
import { tmpdir } from 'node:os'
import { Configuration, secretHex } from './config.ts'
import { claimLock, readJson, writeJson } from './files.ts'
import { type CliError, Registration, type ServiceStatus } from './model.ts'
import { Server, type RunningServer } from './server.ts'
import { ServiceManager } from './service.ts'
import { serveControl, type ControlReply } from './transport.ts'

/** A service generation has its own scope so reload closes every old resource. */
interface Generation {
  readonly scope: Scope.Closeable
  readonly server: RunningServer
}

/** Own the service lease, control listener and successive backend generations. */
export const daemonProgram = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* Configuration
    const fs = yield* FileSystem.FileSystem
    const server = yield* Server
    const manager = yield* ServiceManager
    const owner = yield* Scope.Scope
    yield* claimLock(config.directory, '.service-lock')
    const token = Redacted.make(yield* secretHex())
    const socketId = (yield* secretHex()).slice(0, 24)
    const socketPath =
      config.platform === 'win32' ? `\\\\.\\pipe\\doop-${socketId}` : `${tmpdir()}/doop-${socketId}.sock`
    const done = yield* Deferred.make<void>()
    const active = yield* Ref.make<Option.Option<Generation>>(Option.none())
    const busy = yield* Ref.make(false)
    const mutex = yield* Semaphore.make(1)
    const start = Effect.fn('Daemon.startGeneration')(function* (port: number) {
      const scope = yield* Scope.fork(owner, 'sequential')
      const backend = yield* server.start(port, 'service').pipe(
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      )
      yield* Ref.set(active, Option.some({ scope, server: backend }))
      yield* backend.exited.pipe(
        Effect.andThen(Deferred.succeed(done, undefined)),
        Effect.forkScoped,
        Scope.provide(scope),
      )
      return backend
    })
    const stateFile = `${config.directory}/service-state.json`
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const state = yield* readJson(stateFile, SchemaRegistration, null)
        if (state && Redacted.value(state.token) === Redacted.value(token)) yield* fs.remove(stateFile, { force: true })
      }).pipe(Effect.ignore),
    )
    const first = yield* start((yield* manager.settings).port)
    const status = Effect.gen(function* () {
      const current = yield* Ref.get(active)
      return {
        running: Option.isSome(current) && (yield* current.value.server.running) && !(yield* Ref.get(busy)),
        pid: process.pid,
        backendPid: Option.isSome(current) ? current.value.server.pid : undefined,
        url: Option.isSome(current) ? current.value.server.url : first.url,
        installed: (yield* manager.settings).installed,
      } satisfies ServiceStatus
    })
    const handler = (command: 'status' | 'stop' | 'reload'): Effect.Effect<ControlReply, CliError> => {
      if (command === 'status') return status.pipe(Effect.map((value) => ({ value })))
      if (command === 'stop')
        return Effect.succeed({
          value: { running: false, stopping: true },
          after: Deferred.succeed(done, undefined).pipe(Effect.asVoid),
        })
      return Effect.gen(function* () {
        yield* Ref.set(busy, true)
        const current = yield* Ref.get(active)
        const previousPort = Option.isSome(current) ? Number(new URL(current.value.server.url).port) : 0
        if (Option.isSome(current)) yield* Scope.close(current.value.scope, Exit.void)
        const configured = (yield* manager.settings).port
        const next = yield* start(configured === 0 ? previousPort : configured)
        return { value: { running: true, pid: process.pid, backendPid: next.pid, url: next.url, reloaded: true } }
      }).pipe(
        Effect.ensuring(Ref.set(busy, false)),
        mutex.withPermits(1),
        Effect.catch(() =>
          Effect.succeed({
            value: { running: false, error: 'Reload failed; inspect service.log.' },
            after: Deferred.succeed(done, undefined).pipe(Effect.asVoid),
          }),
        ),
      )
    }
    yield* serveControl(socketPath, token, handler)
    yield* writeJson(stateFile, Registration, { pid: process.pid, url: first.url, socket: socketPath, token })
    yield* Deferred.await(done)
  }),
)

const SchemaRegistration = Schema.NullOr(Registration)
