import { Context, Effect, FileSystem, Layer, Redacted, Schema, Stdio, Stream } from 'effect'
import { Cookies, HttpClient, HttpClientRequest } from 'effect/http'
import { Prompt } from 'effect/cli'
import type { HttpMethod } from 'effect/http/HttpMethod'
import { Configuration } from './config.ts'
import { readJson, writeJson } from './files.ts'
import { ApiError, type CliError, type Options, Session, StorageError } from './model.ts'
import { ServiceManager } from './service.ts'

/** Authenticated requests and account sessions, with origin-scoped redacted cookies. */
export class Api extends Context.Service<
  Api,
  {
    readonly request: (
      base: string,
      route: string,
      method?: HttpMethod,
      body?: string,
    ) => Effect.Effect<string, CliError>
    readonly login: (base: string, options: Options) => Effect.Effect<{ authenticated: true; origin: string }, CliError>
    readonly logout: (explicit?: string) => Effect.Effect<{ authenticated: false; revoked: boolean }, CliError>
    readonly body: (value?: string) => Effect.Effect<string | undefined, CliError>
  }
>()('doop/Api') {}

/** Requests never follow redirects or attach one origin's cookie to another origin. */
export const apiLayer = Layer.effect(
  Api,
  Effect.gen(function* () {
    const config = yield* Configuration
    const fs = yield* FileSystem.FileSystem
    const http = yield* HttpClient.HttpClient
    const stdio = yield* Stdio.Stdio
    const manager = yield* ServiceManager
    const terminalContext = yield* Effect.context<Prompt.Environment>()
    const file = `${config.directory}/cli-session.json`
    const readSession = readJson(file, Schema.NullOr(Session), null).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    )
    const send = Effect.fn('Api.send')(
      function* (base: string, route: string, method: HttpMethod, body?: string, cookie?: Redacted.Redacted<string>) {
        const target = yield* Effect.try({
          try: () => new URL(route, base),
          catch: () => new ApiError({ operation: 'path', message: 'Invalid API path.' }),
        })
        if (!route.startsWith('/') || route.startsWith('//') || route.includes('\\') || target.origin !== base)
          return yield* new ApiError({
            operation: 'path',
            message: 'API path must stay on the selected server origin.',
          })
        let request = HttpClientRequest.make(method)(target, {
          headers: { Origin: base, 'Content-Type': 'application/json' },
        })
        if (cookie) request = HttpClientRequest.setHeader(request, 'Cookie', Redacted.value(cookie))
        if (body !== undefined) request = HttpClientRequest.bodyText(request, body, 'application/json')
        const response = yield* http.execute(request)
        if (response.status < 200 || response.status >= 300)
          return yield* new ApiError({
            operation: 'request',
            status: response.status,
            message: `Doop API returned HTTP ${response.status}.${response.status === 401 ? ' Run doop auth login.' : ''}`,
          })
        return { text: yield* response.text, cookie: Redacted.make(Cookies.toCookieHeader(response.cookies)) }
      },
      Effect.timeout(15_000),
      Effect.mapError((error) =>
        error instanceof ApiError
          ? error
          : new ApiError({ operation: 'request', message: 'Cannot reach the selected Doop server.' }),
      ),
    )
    const request = Effect.fn('Api.request')(function* (
      base: string,
      route: string,
      method: HttpMethod = 'GET',
      body?: string,
    ) {
      const session = yield* readSession
      return (yield* send(base, route, method, body, session?.origin === base ? session.cookie : undefined)).text
    })
    const login = Effect.fn('Api.login')(
      function* (base: string, options: Options) {
        const origin = new URL(base)
        if (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
          return yield* new ApiError({
            operation: 'login',
            message: 'Account login requires HTTPS except on loopback.',
          })
        let email: string
        let password: Redacted.Redacted<string>
        if (options['password-stdin']) {
          if (!options.email)
            return yield* new ApiError({ operation: 'login', message: '--password-stdin requires --email.' })
          email = options.email
          const text = yield* stdio.stdin.pipe(
            Stream.decodeText(),
            Stream.runFoldEffect(
              () => '',
              (text, chunk) =>
                text.length + chunk.length > 4096
                  ? Effect.fail(new ApiError({ operation: 'password', message: 'Password input is too long.' }))
                  : Effect.succeed(text + chunk),
            ),
          )
          password = Redacted.make(text.replace(/\r?\n$/, ''))
        } else {
          if (!(yield* stdio.stdinIsTerminal))
            return yield* new ApiError({
              operation: 'login',
              message: 'Use --email and --password-stdin for non-interactive login.',
            })
          email =
            options.email ||
            (yield* Prompt.run(Prompt.String({ message: 'Email:' })).pipe(Effect.provide(terminalContext)))
          password = yield* Prompt.run(Prompt.Hidden({ message: 'Password:' })).pipe(
            Effect.provide(terminalContext),
            Effect.timeout(120_000),
          )
        }
        const response = yield* send(
          base,
          '/api/auth/sign-in/email',
          'POST',
          JSON.stringify({ email, password: Redacted.value(password) }),
        )
        if (!Redacted.value(response.cookie))
          return yield* new ApiError({ operation: 'login', message: 'Server did not return a session cookie.' })
        yield* fs.makeDirectory(config.directory, { recursive: true, mode: 0o700 })
        yield* writeJson(file, Session, { origin: base, cookie: response.cookie }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        )
        return { authenticated: true as const, origin: base }
      },
      Effect.mapError((error) =>
        error instanceof ApiError || error instanceof StorageError
          ? error
          : new ApiError({ operation: 'login', message: 'Account login could not complete.' }),
      ),
    )
    const logout = Effect.fn('Api.logout')(function* (explicit?: string) {
      const revoke = Effect.gen(function* () {
        const base = yield* manager.endpoint(explicit)
        const session = yield* readSession
        if (!session || session.origin !== base) return false
        yield* send(base, '/api/auth/sign-out', 'POST', '{}', session.cookie)
        return true
      }).pipe(Effect.catch(() => Effect.succeed(false)))
      const revoked = yield* revoke.pipe(Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.orDie)))
      return { authenticated: false as const, revoked }
    })
    const body = Effect.fn('Api.body')(
      function* (value?: string) {
        if (value === undefined) return undefined
        const text = value.startsWith('@') ? yield* fs.readFileString(value.slice(1)) : value
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)
        return text
      },
      Effect.mapError(
        () => new ApiError({ operation: 'body', message: 'Request body must be valid JSON, or @path to a JSON file.' }),
      ),
    )
    return Api.of({ request, login, logout, body })
  }),
)
