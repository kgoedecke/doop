import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** User-facing failure whose message contains no credentials. */
export class CliError extends Error {}
/** Package root for both checkouts and installed npm packages. */
export const packageRoot = fileURLToPath(new URL('../', import.meta.url))
/** Installed CLI executable. */
export const entry = path.join(packageRoot, 'cli/doop.mjs')
/** Package version and installation metadata. */
export const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
/** Resolve the persistent data root. */
export function dataDirectory(value) {
  if (value) return path.resolve(value)
  if (process.platform === 'win32')
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local'), 'Doop')
  if (process.platform === 'darwin') return path.join(homedir(), 'Library/Application Support/Doop')
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), 'doop')
}
/** Read JSON without echoing sensitive contents on failure. */
export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    throw new CliError(`Cannot read ${path.basename(file)}. Restore a valid backup.`, { cause })
  }
}
/** Atomically replace private state/configuration. */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
}
/** Check process existence without terminating it. */
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
/** Parse a TCP port before performing effects. */
export function parsePort(input = '4400') {
  if (!/^\d+$/.test(input) || Number(input) > 65535) throw new CliError('--port must be an integer from 0 to 65535.')
  return Number(input)
}
