import { Config, Context, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from 'effect'
import * as Crypto from 'effect/Crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ConfigurationError, LocalAuth, PackageMetadata, type Options } from './model.ts'
import { readJson, writeJson } from './files.ts'

/** Runtime authority selected by the executable composition root. */
export class Configuration extends Context.Service<
  Configuration,
  {
    readonly directory: string
    readonly root: string
    readonly entry: string
    readonly executable: string
    readonly platform: NodeJS.Platform
    readonly environment: NodeJS.ProcessEnv
    readonly version: string
    readonly packageName: string
  }
>()('doop/Configuration') {}

/** Read environment recipes and installed metadata once, without loading the backend. */
export const configurationLayer = (options: Options) =>
  Layer.effect(
    Configuration,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const local = yield* Config.option(Config.String('LOCALAPPDATA'))
      const xdg = yield* Config.option(Config.String('XDG_DATA_HOME'))
      const platform = process.platform
      const home = homedir()
      const defaultDirectory =
        platform === 'win32'
          ? path.join(
              Option.getOrElse(local, () => path.join(home, 'AppData/Local')),
              'Doop',
            )
          : platform === 'darwin'
            ? path.join(home, 'Library/Application Support/Doop')
            : path.join(
                Option.getOrElse(xdg, () => path.join(home, '.local/share')),
                'doop',
              )
      const root = fileURLToPath(new URL('../', import.meta.url))
      const content = yield* fs.readFileString(path.join(root, 'package.json'))
      const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageMetadata))(content)
      return Configuration.of({
        directory: path.resolve(options['data-dir'] || defaultDirectory),
        root,
        entry: path.join(root, 'cli/doop.mjs'),
        executable: process.execPath,
        platform,
        environment: { ...process.env },
        version: metadata.version,
        packageName: metadata.name,
      })
    }).pipe(
      Effect.mapError(
        () =>
          new ConfigurationError({
            operation: 'configuration',
            message: 'Cannot load the CLI configuration or installed package metadata.',
          }),
      ),
    ),
  )

/** Generate cryptographic material through the injected secure-random service. */
export const secretHex = Effect.fn('Configuration.secretHex')(function* () {
  const random = yield* Crypto.Crypto
  return Buffer.from(yield* random.randomBytes(32)).toString('hex')
})

/** Load or initialize the stable signing key without exposing its raw value. */
export const localAuth = Effect.fn('Configuration.localAuth')(function* () {
  const config = yield* Configuration
  const fs = yield* FileSystem.FileSystem
  const file = `${config.directory}/local-auth.json`
  if (!(yield* fs.exists(file))) yield* writeJson(file, LocalAuth, { secret: Redacted.make(yield* secretHex()) })
  return yield* readJson(file, LocalAuth, { secret: Redacted.make('') })
})
