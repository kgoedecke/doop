import { Context, Effect, FileSystem, Layer, Option, Schedule, Schema } from 'effect'
import { Configuration } from './config.ts'
import { readJson, writeJson } from './files.ts'
import {
  ConfigurationError,
  ControlError,
  ProcessError,
  Registration,
  ServiceSettings,
  type ServiceStatus,
  StorageError,
  type CliError,
  defaultSettings,
} from './model.ts'
import { Processes } from './process.ts'
import { requestControl } from './transport.ts'

/** Persistent service policy and authenticated control, shared by CLI consumers. */
export class ServiceManager extends Context.Service<
  ServiceManager,
  {
    readonly settings: Effect.Effect<ServiceSettings, StorageError>
    readonly save: (settings: ServiceSettings) => Effect.Effect<void, StorageError>
    readonly status: Effect.Effect<ServiceStatus, CliError>
    readonly start: (port?: number) => Effect.Effect<ServiceStatus, CliError>
    readonly stop: Effect.Effect<ServiceStatus, CliError>
    readonly reload: Effect.Effect<ServiceStatus, CliError>
    readonly endpoint: (explicit?: string) => Effect.Effect<string, CliError>
  }
>()('doop/ServiceManager') {}

/** Readiness and shutdown retries are bounded schedules, never PID ownership checks. */
export const serviceManagerLayer = Layer.effect(
  ServiceManager,
  Effect.gen(function* () {
    const config = yield* Configuration
    const fs = yield* FileSystem.FileSystem
    const processes = yield* Processes
    const stateFile = `${config.directory}/service-state.json`
    const settingsFile = `${config.directory}/service.json`
    const settings = readJson(settingsFile, ServiceSettings, defaultSettings).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    )
    const save = (value: ServiceSettings) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(config.directory, { recursive: true, mode: 0o700 })
        yield* writeJson(settingsFile, ServiceSettings, value)
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(() => new StorageError({ operation: 'settings', message: 'Cannot save service settings.' })),
      )
    const control = (command: 'status' | 'stop' | 'reload') =>
      Effect.gen(function* () {
        const state = yield* readJson(stateFile, Schema.NullOr(Registration), null)
        return state ? yield* requestControl(state, command) : Option.none<ServiceStatus>()
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs))
    const status = Effect.gen(function* () {
      const response = yield* control('status')
      return Option.isSome(response) ? response.value : { running: false, installed: (yield* settings).installed }
    })
    const start = Effect.fn('Service.start')(function* (port?: number) {
      const existing = yield* status
      if (existing.running) return existing
      yield* fs
        .makeDirectory(config.directory, { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError(
            () => new StorageError({ operation: 'directory', message: 'Cannot create service data directory.' }),
          ),
        )
      if (port !== undefined) yield* save({ ...(yield* settings), port })
      const launched = yield* processes.detach([`${config.root}/cli/service-runner.mjs`, config.directory])
      const attempt = Effect.gen(function* () {
        const current = yield* status
        if (current.running) return current
        if (yield* launched.exited)
          return yield* new ProcessError({
            operation: 'readiness',
            message: 'Background service exited; inspect doop debug logs.',
          })
        return yield* new ControlError({ operation: 'readiness', message: 'Waiting for service readiness.' })
      })
      return yield* attempt.pipe(
        Effect.retry({ schedule: Schedule.spaced(150), while: (error) => error._tag === 'ControlError' }),
        Effect.timeout(90_000),
        Effect.mapError((error) =>
          error._tag === 'TimeoutError'
            ? new ControlError({
                operation: 'readiness',
                message: 'Background service startup timed out; inspect doop debug logs.',
              })
            : error,
        ),
      )
    })
    const stop = Effect.gen(function* () {
      const response = yield* control('stop')
      if (Option.isNone(response)) return { running: false }
      if (!response.value.stopping)
        return yield* new ControlError({
          operation: 'stop',
          message: 'Service is busy; retry after its current operation.',
        })
      yield* Effect.gen(function* () {
        if (yield* fs.exists(stateFile))
          return yield* new ControlError({ operation: 'stop', message: 'Waiting for service shutdown.' })
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced(100), while: (error) => error._tag === 'ControlError' }),
        Effect.timeout(20_000),
        Effect.mapError(
          () => new ControlError({ operation: 'stop', message: 'Service shutdown timed out; inspect service.log.' }),
        ),
      )
      return { running: false }
    })
    const reload = Effect.gen(function* () {
      const response = yield* control('reload')
      if (Option.isNone(response) || !response.value.reloaded)
        return yield* new ControlError({
          operation: 'reload',
          message: 'Service could not be reloaded; inspect service.log.',
        })
      return response.value
    })
    const endpoint = Effect.fn('Service.endpoint')(function* (explicit?: string) {
      if (explicit) {
        const url = yield* Effect.try({
          try: () => new URL(explicit),
          catch: () => new ConfigurationError({ operation: 'endpoint', message: 'Invalid --server URL.' }),
        })
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== '/'
        )
          return yield* new ConfigurationError({
            operation: 'endpoint',
            message: '--server must be an HTTP(S) origin without credentials, paths or query parameters.',
          })
        return url.origin
      }
      const current = yield* status
      if (!current.running || !current.url)
        return yield* new ControlError({
          operation: 'endpoint',
          message: 'No background server is running. Run doop service start, or pass --server URL.',
        })
      return current.url
    })
    return ServiceManager.of({ settings, save, status, start, stop, reload, endpoint })
  }),
)
