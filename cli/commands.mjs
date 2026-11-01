import { accessSync, constants, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { CliError, metadata, packageRoot, parsePort, writeJson } from './runtime.mjs'
import { autostart } from './autostart.mjs'
import { control, endpoint, logs, serviceStatus, settings, startService, stopService } from './service.mjs'
import { apiRequest, authCommand, requestBody } from './client.mjs'
import { pair, skill } from './integrations.mjs'
import { upgrade } from './update.mjs'

function print(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}
function arity(args, maximum) {
  if (args.length > maximum) throw new CliError('Too many arguments. Run doop --help.')
}

/** Route each command to its application handler without loading the backend. */
export async function dispatch(command, args, values, directory) {
  if (command === 'service') {
    arity(args, 1)
    const action = args[0] || 'status'
    if (action === 'status') return print(await serviceStatus(directory))
    if (action === 'install') {
      const config = settings(directory)
      const next = {
        ...config,
        port: values.port === undefined ? config.port : parsePort(values.port),
        installed: true,
        autostart: values.autostart || config.autostart,
      }
      writeJson(path.join(directory, 'service.json'), next)
      if (values.autostart && !config.autostart) {
        try {
          autostart(directory, true)
        } catch (cause) {
          writeJson(path.join(directory, 'service.json'), config)
          throw cause
        }
      }
      return print(next)
    }
    if (action === 'start')
      return print(await startService(directory, values.port === undefined ? undefined : parsePort(values.port)))
    if (action === 'stop') return print(await stopService(directory))
    if (action === 'restart') {
      await stopService(directory)
      return print(await startService(directory, values.port === undefined ? undefined : parsePort(values.port)))
    }
    if (action === 'uninstall') {
      await stopService(directory)
      if (settings(directory).autostart) autostart(directory, false)
      rmSync(path.join(directory, 'service.json'), { force: true })
      return print({ uninstalled: true, dataRetained: true })
    }
    throw new CliError('Unknown service command. Run doop --help.')
  }
  if (command === 'reload') {
    arity(args, 0)
    const response = await control(directory, 'reload')
    if (!response?.reloaded)
      throw new CliError('No service could be reloaded. Run doop service start or inspect service.log.')
    return print(response)
  }
  if (command === 'api') {
    arity(args, 2)
    const method = args.length === 1 ? 'GET' : args[0]?.toUpperCase()
    const route = args.length === 1 ? args[0] : args[1]
    if (!route || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method))
      throw new CliError('Usage: doop api [METHOD] /path [--data JSON|@file]')
    const response = await apiRequest(
      directory,
      await endpoint(directory, values.server),
      route,
      method,
      requestBody(values.data),
    )
    return print(await response.text())
  }
  if (command === 'auth') {
    arity(args, 1)
    return print(await authCommand(args[0] || 'status', directory, await endpoint(directory, values.server), values))
  }
  if (command === 'pair') {
    arity(args, 0)
    return print(pair(await endpoint(directory, values.server), values))
  }
  if (command === 'skill') {
    arity(args, 1)
    return print(skill(args[0] || 'list', values))
  }
  if (command === 'update' || command === 'upgrade') {
    arity(args, 1)
    return print(await upgrade(directory, args[0], values))
  }
  if (command === 'debug') {
    arity(args, 1)
    if (args[0] === 'logs') return print(logs(directory))
    if (!args[0] || args[0] === 'paths')
      return print({
        package: packageRoot,
        data: directory,
        database: path.join(directory, 'data/pg'),
        assets: path.join(directory, 'data/assets'),
        logs: path.join(directory, 'service.log'),
      })
    if (args[0] === 'config')
      return print({
        version: metadata.version,
        service: settings(directory),
        host: '127.0.0.1',
        sessionKeyPresent: existsSync(path.join(directory, 'local-auth.json')),
      })
    throw new CliError('Unknown debug command. Use paths, config or logs.')
  }
  if (command === 'doctor') {
    arity(args, 0)
    const [major, minor] = process.versions.node.split('.').map(Number)
    const status = await serviceStatus(directory)
    let writable = false
    try {
      accessSync(existsSync(directory) ? directory : path.dirname(directory), constants.W_OK)
      writable = true
    } catch {
      /* diagnostic only */
    }
    let healthy = false
    if (status.running) {
      try {
        healthy = (await fetch(`${status.url}/healthz`, { signal: AbortSignal.timeout(3000) })).ok
      } catch {
        /* diagnostic only */
      }
    }
    const checks = {
      node: major > 22 || (major === 22 && minor >= 19),
      frontend: existsSync(path.join(packageRoot, 'dist/index.html')),
      migrations: existsSync(path.join(packageRoot, 'server/db/migrations/meta/_journal.json')),
      writable,
      service: !status.running || healthy,
    }
    const ok = Object.values(checks).every(Boolean)
    print({ ok, version: metadata.version, node: process.versions.node, checks, background: status })
    if (!ok) process.exitCode = 1
    return
  }
  throw new CliError('Unknown command. Run doop --help.')
}
