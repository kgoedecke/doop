import { Effect, FileSystem, Schema, Scope } from 'effect'
import lockfile from 'proper-lockfile'
import { StorageError } from './model.ts'

/** Decode persisted JSON without putting malformed content into diagnostics. */
export const readJson = <A, I>(file: string, schema: Schema.Codec<A, I>, fallback: A) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(file))) return fallback
    const content = yield* fs.readFileString(file)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(content)
  }).pipe(
    Effect.mapError(
      () =>
        new StorageError({
          operation: 'readJson',
          message: 'Cannot read private configuration. Restore a valid backup.',
        }),
    ),
  )

/** Atomically write a schema-encoded private file and remove interrupted temporary files. */
export const writeJson = <A, I>(file: string, schema: Schema.Codec<A, I>, value: A) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value)
    const temporary = `${file}.${process.pid}.tmp`
    yield* Effect.acquireUseRelease(
      fs.writeFileString(temporary, content + '\n', { mode: 0o600 }).pipe(Effect.as(temporary)),
      (temporary) => fs.rename(temporary, file),
      (temporary) => fs.remove(temporary, { force: true }).pipe(Effect.ignore),
    )
  }).pipe(
    Effect.mapError(
      () =>
        new StorageError({
          operation: 'writeJson',
          message: 'Cannot save private configuration. Check directory permissions.',
        }),
    ),
  )

/** Hold a heartbeat lease until the owning Effect scope closes. */
export const claimLock = Effect.fn('Files.claimLock')(
  function* (directory: string, name: string) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    const lock = `${directory}/${name}`
    if ((yield* fs.exists(`${lock}/pid`)) || (yield* fs.exists(`${lock}/owner.json`)))
      return yield* new StorageError({
        operation: 'claimLock',
        message:
          'Legacy data directory lock found. Stop the old CLI before upgrading; remove legacy locks only after verifying it has stopped.',
      })
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => lockfile.lockSync(directory, { lockfilePath: lock, stale: 10_000, update: 2000 }),
        catch: () =>
          new StorageError({
            operation: 'claimLock',
            message:
              'Data directory is locked. Stop the other instance, or retry after the 10-second crash lease expires.',
          }),
      }),
      (release) => Effect.sync(release).pipe(Effect.catchDefect(() => Effect.void)),
    )
  },
  Effect.mapError((error) =>
    error instanceof StorageError
      ? error
      : new StorageError({ operation: 'claimLock', message: 'Cannot acquire the data directory lock.' }),
  ),
)

/** Read a bounded byte tail; scoped file handles close on failure and interruption. */
export const logTail = Effect.fn('Files.logTail')(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(file))) return 'No service logs yet.'
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file)
        const info = yield* handle.stat
        const length = Number(info.size > 32768n ? 32768n : info.size)
        const buffer = new Uint8Array(length)
        const count = yield* handle.read(buffer, { position: info.size - BigInt(length) })
        return new TextDecoder().decode(buffer.subarray(0, count))
      }),
    )
  },
  Effect.mapError(() => new StorageError({ operation: 'logTail', message: 'Cannot read service logs.' })),
)

/** Filesystem services required by persisted state helpers. */
export type FilesContext = FileSystem.FileSystem | Scope.Scope
