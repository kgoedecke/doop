import { Console, Context, Deferred, Effect, FileSystem, Layer, Redacted, Ref, Scope, Stdio, Stream } from 'effect'
import { createServer } from 'node:net'
import * as Crypto from 'effect/Crypto'
import { Configuration, localAuth } from './config.ts'
import { claimLock } from './files.ts'
import { type CliError, ProcessError } from './model.ts'
import { Processes, type BackendProcess } from './process.ts'

/** A ready backend whose lifetime belongs to the caller's scope. */
export interface RunningServer extends BackendProcess {
  readonly url: string
}

/** Reusable backend startup policy shared by foreground and service entry points. */
export class Server extends Context.Service<
  Server,
  {
    readonly start: (
      port: number,
      output: 'foreground' | 'service',
    ) => Effect.Effect<RunningServer, CliError, Scope.Scope>
  }
>()('doop/Server') {}

const allocatePort = (port: number) =>
  Effect.acquireUseRelease(
    Effect.sync(() => createServer()),
    (server) =>
      Effect.callback<number, ProcessError>((resume) => {
        server.once('error', () =>
          resume(
            Effect.fail(
              new ProcessError({ operation: 'bind', message: `Cannot bind local port ${port}. Try --port 0.` }),
            ),
          ),
        )
        server.listen(port, '127.0.0.1', () => {
          const address = server.address()
          resume(
            typeof address === 'object' && address
              ? Effect.succeed(address.port)
              : Effect.fail(new ProcessError({ operation: 'bind', message: 'No local TCP address was allocated.' })),
          )
        })
      }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void))
      }),
  )

/** Startup acquires its lock/process/streams and readiness timeout in one scope. */
export const serverLayer = Layer.effect(
  Server,
  Effect.gen(function* () {
    const config = yield* Configuration
    const processes = yield* Processes
    const fs = yield* FileSystem.FileSystem
    const stdio = yield* Stdio.Stdio
    const random = yield* Crypto.Crypto
    const start = Effect.fn('Server.start')(
      function* (requested: number, output: 'foreground' | 'service') {
        yield* claimLock(config.directory, '.doop-lock')
        const auth = yield* localAuth().pipe(
          Effect.provideService(Configuration, config),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Crypto.Crypto, random),
        )
        const port = yield* allocatePort(requested)
        const url = `http://127.0.0.1:${port}`
        const header = `Doop local: ${url}\nMCP: ${url}/mcp\nData: ${config.directory}\nStarting server; wait for the ready message.\n`
        const write = (text: string, error = false) =>
          output === 'service'
            ? fs.writeFileString(`${config.directory}/service.log`, text, { flag: 'a', mode: 0o600 })
            : Stream.make(text).pipe(Stream.run(error ? stdio.stderr() : stdio.stdout()))
        yield* write(header)
        const backend = yield* processes.backend(config.directory, {
          ...config.environment,
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
          PORT: String(port),
          BETTER_AUTH_URL: url,
          BETTER_AUTH_SECRET: Redacted.value(auth.secret),
        })
        const ready = yield* Deferred.make<void>()
        const text = yield* Ref.make('')
        yield* backend.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              yield* write(chunk)
              const accumulated = yield* Ref.updateAndGet(text, (value) => (value + chunk).slice(-65_536))
              if (accumulated.includes('doop server')) yield* Deferred.succeed(ready, undefined)
            }),
          ),
          Effect.catch((error) => Console.error('Backend stdout failed.').pipe(Effect.andThen(Effect.fail(error)))),
          Effect.forkScoped,
        )
        yield* backend.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => write(chunk, true)),
          Effect.forkScoped,
        )
        yield* Effect.raceFirst(
          Deferred.await(ready),
          backend.exited.pipe(
            Effect.andThen(
              Effect.fail(
                new ProcessError({
                  operation: 'readiness',
                  message: 'Backend exited during startup; inspect service.log.',
                }),
              ),
            ),
          ),
        ).pipe(
          Effect.timeout(75_000),
          Effect.mapError((error) =>
            error instanceof ProcessError
              ? error
              : new ProcessError({
                  operation: 'readiness',
                  message: 'Backend startup timed out; inspect service.log.',
                }),
          ),
        )
        return { ...backend, url }
      },
      Effect.mapError((error) =>
        error instanceof ProcessError || ('_tag' in error && error._tag === 'StorageError')
          ? error
          : new ProcessError({ operation: 'start', message: 'Cannot start the local backend.' }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
    )
    return Server.of({ start })
  }),
)
