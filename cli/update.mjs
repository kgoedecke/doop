import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { CliError, metadata, packageRoot } from './runtime.mjs'
import { serviceStatus, stopService } from './service.mjs'

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ]
  // Node version managers may put node.exe inside a platform package while npm
  // is a sibling package several directories above it.
  for (let directory = path.dirname(process.execPath); ; directory = path.dirname(directory)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'), path.join(directory, 'npm/bin/npm-cli.js'))
    if (directory === path.dirname(directory)) break
  }
  const found = candidates.find((file) => file && existsSync(file) && /\.[cm]?js$/.test(file))
  if (!found)
    throw new CliError('Cannot locate npm. Run the upgrade through npm exec or set npm_execpath to npm-cli.js.')
  return found
}

/** Upgrade with the installation's npm package manager; update is an exact alias. */
export async function upgrade(directory, target, values) {
  let spec = '@killzonegaming/doop-cli@latest'
  if (target) {
    if (existsSync(target) && target.endsWith('.tgz')) spec = path.resolve(target)
    else if (/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target))
      spec = `@killzonegaming/doop-cli@${target.replace(/^v/, '')}`
    else throw new CliError('Upgrade target must be a local .tgz archive or an explicit semantic version.')
  }
  const args = [
    'install',
    '--global',
    '--no-audit',
    '--no-fund',
    ...(values.prefix ? ['--prefix', path.resolve(values.prefix)] : []),
    spec,
  ]
  if (values['dry-run']) return { version: metadata.version, command: 'npm', args, registryPublished: false }
  if (
    !values.prefix &&
    (!packageRoot.includes(`${path.sep}node_modules${path.sep}`) || metadata.name !== '@killzonegaming/doop-cli')
  )
    throw new CliError(
      'A source checkout cannot upgrade itself. Install a tarball with npm, or specify --prefix for a separate installation.',
    )
  if (!target) throw new CliError('This private preview is not published to npm. Pass the path to a newer CLI tarball.')
  const npm = npmCli()
  if (!values.prefix) {
    let prefix = path.resolve(packageRoot, '../../..')
    if (process.platform !== 'win32' && path.basename(prefix) === 'lib') prefix = path.dirname(prefix)
    const shim = path.join(prefix, process.platform === 'win32' ? 'doop.cmd' : 'bin/doop')
    if (!existsSync(shim))
      throw new CliError(
        'This is a local dependency. Use --prefix for a separate installation, or update it with npm install.',
      )
    args.splice(args.length - 1, 0, '--prefix', prefix)
  }
  if ((await serviceStatus(directory)).running) await stopService(directory)
  const result = spawnSync(process.execPath, [npm, ...args], { stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0)
    throw new CliError('npm upgrade failed. Data was kept; inspect npm output before restarting the service.')
  return { upgraded: true, target: spec, next: 'Run doop service start with the upgraded executable.' }
}
