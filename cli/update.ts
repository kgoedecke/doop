import { Effect, FileSystem, Path } from 'effect'
import { Configuration } from './config.ts'
import { ConfigurationError, type Options, ProcessError } from './model.ts'
import { Processes } from './process.ts'
import { ServiceManager } from './service.ts'

/** Resolve npm from the active runtime, including version-manager layouts. */
const npmCli = Effect.fn('Updater.npmCli')(function* () {
  const config = yield* Configuration
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const candidates = [
    config.environment.npm_execpath,
    path.resolve(path.dirname(config.executable), '../lib/node_modules/npm/bin/npm-cli.js'),
  ]
  for (let directory = path.dirname(config.executable); ; directory = path.dirname(directory)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'), path.join(directory, 'npm/bin/npm-cli.js'))
    if (directory === path.dirname(directory)) break
  }
  for (const candidate of candidates)
    if (candidate && /\.[cm]?js$/.test(candidate) && (yield* fs.exists(candidate))) return candidate
  return yield* new ConfigurationError({
    operation: 'npm',
    message: 'Cannot locate npm. Run through npm exec or set npm_execpath to npm-cli.js.',
  })
})

/** Install through npm with an explicit installation target and preserved data. */
export const upgrade = Effect.fn('Updater.upgrade')(
  function* (target: string | undefined, options: Options) {
    const config = yield* Configuration
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const processes = yield* Processes
    const manager = yield* ServiceManager
    let spec = '@killzonegaming/doop-cli@latest'
    if (target) {
      if (target.endsWith('.tgz') && (yield* fs.exists(target))) spec = path.resolve(target)
      else if (/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target))
        spec = `@killzonegaming/doop-cli@${target.replace(/^v/, '')}`
      else
        return yield* new ConfigurationError({
          operation: 'upgrade',
          message: 'Upgrade target must be a local .tgz archive or an explicit semantic version.',
        })
    }
    const args = [
      'install',
      '--global',
      '--no-audit',
      '--no-fund',
      ...(options.prefix ? ['--prefix', path.resolve(options.prefix)] : []),
      spec,
    ]
    if (options['dry-run']) return { version: config.version, command: 'npm', args, registryPublished: false }
    if (
      !options.prefix &&
      (!config.root.includes(`${path.sep}node_modules${path.sep}`) || config.packageName !== '@killzonegaming/doop-cli')
    )
      return yield* new ConfigurationError({
        operation: 'upgrade',
        message: 'A source checkout cannot upgrade itself. Install a tarball or specify --prefix.',
      })
    if (!target)
      return yield* new ConfigurationError({
        operation: 'upgrade',
        message: 'This private preview is not published to npm. Pass a newer CLI tarball.',
      })
    const npm = yield* npmCli()
    if (!options.prefix) {
      let prefix = path.resolve(config.root, '../../..')
      if (config.platform !== 'win32' && path.basename(prefix) === 'lib') prefix = path.dirname(prefix)
      if (!(yield* fs.exists(path.join(prefix, config.platform === 'win32' ? 'doop.cmd' : 'bin/doop'))))
        return yield* new ConfigurationError({
          operation: 'upgrade',
          message: 'This is a local dependency. Use --prefix for a separate installation, or npm install to update it.',
        })
      args.splice(args.length - 1, 0, '--prefix', prefix)
    }
    if ((yield* manager.status).running) yield* manager.stop
    const result = yield* processes.run(config.executable, [npm, ...args])
    if (result.code !== 0)
      return yield* new ProcessError({
        operation: 'upgrade',
        message: 'npm upgrade failed. Data was kept; inspect npm logs before restarting the service.',
      })
    return { upgraded: true, target: spec, next: 'Run doop service start with the upgraded executable.' }
  },
  Effect.mapError((error) =>
    error instanceof ConfigurationError || error instanceof ProcessError
      ? error
      : new ProcessError({ operation: 'upgrade', message: 'Could not complete the npm upgrade.' }),
  ),
)
