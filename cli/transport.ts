import { Effect, FileSystem, Option, Redacted, Schema, Scope } from 'effect'
import * as NodeSocket from '@effect/platform-node/NodeSocket'
import * as NodeSocketServer from '@effect/platform-node/NodeSocketServer'
import { Socket } from 'effect/socket'
import { Configuration } from './config.ts'
import { type CliError, ControlError, ControlRequest, type Registration, ServiceStatus } from './model.ts'

/** Safe protocol reply; post-send effects permit a flushed stop acknowledgement. */
export interface ControlReply {
  readonly value: ServiceStatus
  readonly after?: Effect.Effect<void>
}

/** Keep the reader in the connection scope until the response has been flushed. */
const readLine = (reader: Socket.Reader, limit: number) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('\n')) {
      const chunks = yield* reader.pull
      for (const chunk of chunks) text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      if (text.length > limit)
        return yield* new ControlError({
          operation: 'read',
          message: 'Service control message exceeded its size limit.',
        })
    }
    return text
  })

/** Exchange one bounded request without half-closing Windows named pipes. */
export const requestControl = Effect.fn('Transport.request')(function* (
  state: Registration,
  command: 'status' | 'stop' | 'reload',
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* NodeSocket.makeNet({ path: state.socket, openTimeout: '3 seconds' })
      const reader = yield* socket.reader
      const writer = yield* socket.writer
      yield* writer.write(JSON.stringify({ token: Redacted.value(state.token), command }) + '\n')
      const text = yield* readLine(reader, 16_384)
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ServiceStatus))(text)
    }),
  ).pipe(Effect.timeout(command === 'reload' ? 90_000 : 5000), Effect.option)
})

/** Bind a scoped authenticated control server and handle each connection in scope. */
export const serveControl = <R>(
  socketPath: string,
  token: Redacted.Redacted<string>,
  handler: (command: 'status' | 'stop' | 'reload') => Effect.Effect<ControlReply, CliError, R>,
) =>
  Effect.gen(function* () {
    const config = yield* Configuration
    const fs = yield* FileSystem.FileSystem
    const server = yield* NodeSocketServer.make({ path: socketPath, allowHalfOpen: true })
    if (config.platform !== 'win32') yield* fs.chmod(socketPath, 0o600)
    yield* Effect.addFinalizer(() =>
      config.platform === 'win32' ? Effect.void : fs.remove(socketPath, { force: true }).pipe(Effect.ignore),
    )
    yield* server
      .run((socket) =>
        Effect.scoped(
          Effect.gen(function* () {
            const writer = yield* socket.writer
            const reader = yield* socket.reader
            const text = yield* readLine(reader, 4096).pipe(Effect.timeout(5000))
            const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ControlRequest))(text).pipe(
              Effect.option,
            )
            if (Option.isNone(parsed) || Redacted.value(parsed.value.token) !== Redacted.value(token)) {
              yield* writer.write('{}\n')
              yield* writer.write(new Socket.CloseEvent())
              return
            }
            const response = yield* handler(parsed.value.command)
            yield* writer.write(JSON.stringify(response.value) + '\n')
            yield* writer.write(new Socket.CloseEvent())
            if (response.after) yield* response.after
          }),
        ).pipe(Effect.catch(() => Effect.void)),
      )
      .pipe(Effect.forkScoped)
  }).pipe(
    Effect.mapError(
      () => new ControlError({ operation: 'listen', message: 'Cannot open the private service control channel.' }),
    ),
  )

/** Requirements owned by the listening transport scope. */
export type ControlContext = Configuration | FileSystem.FileSystem | Scope.Scope
