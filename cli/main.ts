import { Cause, Console, Effect, FileSystem, Path, Schema } from 'effect'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { HttpClient } from 'effect/http'
import type { HttpMethod } from 'effect/http/HttpMethod'
import { parseArgs } from 'node:util'
import { Api } from './auth.ts'
import { autostart } from './autostart.ts'
import { Configuration } from './config.ts'
import { daemonProgram } from './daemon.ts'
import { logTail } from './files.ts'
import { pair, skill } from './integrations.ts'
import { runtimeLayer } from './layers.ts'
import { ApiError, ConfigurationError, ControlError, Port, ProcessError, StorageError, type Options } from './model.ts'
import { Server } from './server.ts'
import { ServiceManager } from './service.ts'
import { upgrade } from './update.ts'

const help = `Usage: doop <command> [options]

Doop command line interface
  start | serve                 Run the local app, API and MCP in the foreground
  service [status]              Inspect the background server
  service install [--autostart]  Install configuration (optional login startup)
  service start | stop          Start or gracefully stop the background server
  service restart | uninstall   Restart or unregister the service, keeping data
  reload                        Restart the managed backend with current configuration
  api [METHOD] /path            Request the running API (--data JSON or @file)
  auth login | logout | status   Manage the CLI's local account session
  pair [--client NAME]          Configure a local MCP client using OAuth
  skill list | show | install    Inspect or install the bundled agent skill
  debug [paths|config|logs]      Inspect paths, safe configuration or server logs
  doctor                        Check runtime, assets, data and service health
  update | upgrade [tarball]    Upgrade the npm installation (--dry-run available)

Global: --data-dir PATH, --json, --help, --version
Service: --port NUMBER (0 selects an available port)
API: --server URL, --data JSON|@file
Auth: --email EMAIL, --password-stdin (otherwise prompted privately)
Pair/skill: --client codex|claude|cursor|opencode, --directory PATH, --force
Update: --prefix PATH, --dry-run
`

/** Parse argv into typed option values before acquiring application services. */
const parse = (args: ReadonlyArray<string>) =>
  Effect.try({
    try: () =>
      parseArgs({
        args: [...args],
        allowPositionals: true,
        options: {
          help: { type: 'boolean', short: 'h' },
          version: { type: 'boolean', short: 'v' },
          json: { type: 'boolean' },
          port: { type: 'string' },
          'data-dir': { type: 'string' },
          server: { type: 'string' },
          data: { type: 'string', short: 'd' },
          email: { type: 'string' },
          'password-stdin': { type: 'boolean' },
          client: { type: 'string' },
          directory: { type: 'string' },
          prefix: { type: 'string' },
          'dry-run': { type: 'boolean' },
          autostart: { type: 'boolean' },
          force: { type: 'boolean' },
        },
      }),
    catch: () => new ConfigurationError({ operation: 'arguments', message: 'Invalid CLI arguments. Run doop --help.' }),
  })

/** Validate a port without retaining an unchecked numeric conversion. */
const parsePort = (value = '4400') =>
  /^\d+$/.test(value)
    ? Schema.decodeUnknownEffect(Port)(Number(value)).pipe(
        Effect.mapError(
          () => new ConfigurationError({ operation: 'port', message: '--port must be an integer from 0 to 65535.' }),
        ),
      )
    : Effect.fail(new ConfigurationError({ operation: 'port', message: '--port must be an integer from 0 to 65535.' }))
const arity = (args: ReadonlyArray<string>, maximum: number) =>
  args.length <= maximum
    ? Effect.void
    : Effect.fail(new ConfigurationError({ operation: 'arguments', message: 'Too many arguments. Run doop --help.' }))
const print = (value: unknown) => Console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))

/** Route parsed requests into services; this module owns output and exit policy only. */
export const dispatch = Effect.fn('Cli.dispatch')(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: Options,
) {
  const config = yield* Configuration
  const manager = yield* ServiceManager
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (command === 'start' || command === 'serve') {
    yield* arity(args, 0)
    const server = yield* Server
    yield* Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* server.start(yield* parsePort(options.port), 'foreground')
        yield* backend.exited
      }),
    )
    return
  }
  if (command === 'service') {
    yield* arity(args, 1)
    const action = args[0] || 'status'
    if (action === 'status') return yield* print(yield* manager.status)
    if (action === 'start')
      return yield* print(yield* manager.start(options.port === undefined ? undefined : yield* parsePort(options.port)))
    if (action === 'stop') return yield* print(yield* manager.stop)
    if (action === 'restart') {
      yield* manager.stop
      return yield* print(yield* manager.start(options.port === undefined ? undefined : yield* parsePort(options.port)))
    }
    if (action === 'install') {
      const previous = yield* manager.settings
      const next = {
        ...previous,
        port: options.port === undefined ? previous.port : yield* parsePort(options.port),
        installed: true,
        autostart: options.autostart || previous.autostart,
      }
      yield* manager.save(next)
      if (options.autostart && !previous.autostart)
        yield* autostart(true).pipe(Effect.onError(() => manager.save(previous).pipe(Effect.ignore)))
      return yield* print(next)
    }
    if (action === 'uninstall') {
      yield* manager.stop
      if ((yield* manager.settings).autostart) yield* autostart(false)
      yield* fs.remove(path.join(config.directory, 'service.json'), { force: true })
      return yield* print({ uninstalled: true, dataRetained: true })
    }
    return yield* new ConfigurationError({ operation: 'service', message: 'Unknown service command. Run doop --help.' })
  }
  if (command === 'reload') {
    yield* arity(args, 0)
    return yield* print(yield* manager.reload)
  }
  if (command === 'api') {
    yield* arity(args, 2)
    const method = args.length === 1 ? 'GET' : args[0]?.toUpperCase()
    const route = args.length === 1 ? args[0] : args[1]
    const parsedMethod = yield* Schema.decodeUnknownEffect(
      Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
    )(method).pipe(
      Effect.mapError(
        () =>
          new ConfigurationError({ operation: 'api', message: 'Usage: doop api [METHOD] /path [--data JSON|@file]' }),
      ),
    )
    if (!route)
      return yield* new ConfigurationError({
        operation: 'api',
        message: 'Usage: doop api [METHOD] /path [--data JSON|@file]',
      })
    const api = yield* Api
    return yield* print(
      yield* api.request(
        yield* manager.endpoint(options.server),
        route,
        parsedMethod satisfies HttpMethod,
        yield* api.body(options.data),
      ),
    )
  }
  if (command === 'auth') {
    yield* arity(args, 1)
    const api = yield* Api
    const action = args[0] || 'status'
    if (action === 'logout') return yield* print(yield* api.logout(options.server))
    const base = yield* manager.endpoint(options.server)
    if (action === 'login') return yield* print(yield* api.login(base, options))
    if (['status', 'list', 'whoami'].includes(action)) return yield* print(yield* api.request(base, '/api/me'))
    return yield* new ConfigurationError({
      operation: 'auth',
      message: 'Unknown auth command. Use login, logout or status.',
    })
  }
  if (command === 'pair') {
    yield* arity(args, 0)
    return yield* print(yield* pair(yield* manager.endpoint(options.server), options))
  }
  if (command === 'skill') {
    yield* arity(args, 1)
    return yield* print(yield* skill(args[0] || 'list', options))
  }
  if (command === 'update' || command === 'upgrade') {
    yield* arity(args, 1)
    return yield* print(yield* upgrade(args[0], options))
  }
  if (command === 'debug') {
    yield* arity(args, 1)
    if (args[0] === 'logs') return yield* print(yield* logTail(path.join(config.directory, 'service.log')))
    if (!args[0] || args[0] === 'paths')
      return yield* print({
        package: config.root,
        data: config.directory,
        database: path.join(config.directory, 'data/pg'),
        assets: path.join(config.directory, 'data/assets'),
        logs: path.join(config.directory, 'service.log'),
      })
    if (args[0] === 'config')
      return yield* print({
        version: config.version,
        service: yield* manager.settings,
        host: '127.0.0.1',
        sessionKeyPresent: yield* fs.exists(path.join(config.directory, 'local-auth.json')),
      })
    return yield* new ConfigurationError({
      operation: 'debug',
      message: 'Unknown debug command. Use paths, config or logs.',
    })
  }
  if (command === 'doctor') {
    yield* arity(args, 0)
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
    const current = yield* manager.status
    const writable = yield* fs
      .access((yield* fs.exists(config.directory)) ? config.directory : path.dirname(config.directory), {
        writable: true,
      })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
    const http = yield* HttpClient.HttpClient
    const healthy =
      !current.running ||
      (current.url !== undefined &&
        (yield* http.get(`${current.url}/healthz`).pipe(
          Effect.map((response) => response.status === 200),
          Effect.timeout(3000),
          Effect.catch(() => Effect.succeed(false)),
        )))
    const checks = {
      node: major > 22 || (major === 22 && minor >= 19),
      frontend: yield* fs.exists(path.join(config.root, 'dist/index.html')),
      migrations: yield* fs.exists(path.join(config.root, 'server/db/migrations/meta/_journal.json')),
      writable,
      service: healthy,
    }
    const ok = Object.values(checks).every(Boolean)
    yield* print({ ok, version: config.version, node: process.versions.node, checks, background: current })
    if (!ok)
      return yield* new ConfigurationError({ operation: 'doctor', message: 'Doctor found failed required checks.' })
    return
  }
  return yield* new ConfigurationError({ operation: 'command', message: 'Unknown command. Run doop --help.' })
})

/** Error output contains only approved messages, never raw request/configuration objects. */
const safeMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof ConfigurationError ||
    error instanceof StorageError ||
    error instanceof ProcessError ||
    error instanceof ControlError ||
    error instanceof ApiError
    ? error.message
    : 'Doop command failed. Inspect configuration, permissions and service logs.'
}

/** Execute one CLI request with one managed runtime and scoped platform resources. */
export function runCli(): void {
  const program = Effect.gen(function* () {
    const parsed = yield* parse(process.argv.slice(2))
    yield* Effect.gen(function* () {
      const config = yield* Configuration
      if (parsed.values.version) return yield* Console.log(config.version)
      if (parsed.values.help || !parsed.positionals.length) return yield* Console.log(help)
      const [command = '', ...args] = parsed.positionals
      yield* dispatch(command, args, parsed.values)
    }).pipe(Effect.provide(runtimeLayer(parsed.values)))
  })
  const parentDisconnected = Effect.callback<void>((resume) => {
    const onDisconnect = () => resume(Effect.void)
    process.once('disconnect', onDisconnect)
    return Effect.sync(() => process.off('disconnect', onDisconnect))
  })
  const owned = process.connected ? Effect.raceFirst(program, parentDisconnected) : program
  NodeRuntime.runMain(
    owned.pipe(
      Effect.onError((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Console.error(safeMessage(cause)))),
    ),
    { disableErrorReporting: true },
  )
}

/** Start the detached service in its own runtime; foreground clients never own its lifetime. */
export function runDaemon(directory: string | undefined): void {
  const program = daemonProgram.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const config = yield* Configuration
        const fs = yield* FileSystem.FileSystem
        yield* fs
          .writeFileString(
            `${config.directory}/service.log`,
            `Service startup failed: ${safeMessage(Cause.fail(error))}\n`,
            { flag: 'a', mode: 0o600 },
          )
          .pipe(Effect.ignore)
        return yield* Effect.fail(error)
      }),
    ),
    Effect.provide(runtimeLayer(directory ? { 'data-dir': directory } : {})),
  )
  NodeRuntime.runMain(program, { disableErrorReporting: true })
}
