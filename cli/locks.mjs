import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import lockfile from 'proper-lockfile'
import { CliError } from './runtime.mjs'

/** Claim an atomic directory lock with a heartbeat and a bounded stale lease. */
export function claimLock(directory, name) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = path.join(directory, name)
  // Old previews put PID metadata inside the lock directory. Do not remove an
  // old process's lock while upgrading; let that version release it on exit.
  if (existsSync(path.join(lock, 'pid')) || existsSync(path.join(lock, 'owner.json')))
    throw new CliError(
      'Legacy data directory lock found. Stop the old CLI instance before upgrading; remove stale legacy locks only after verifying it has stopped.',
    )
  try {
    return lockfile.lockSync(directory, { lockfilePath: lock, stale: 10_000, update: 2000 })
  } catch (cause) {
    throw new CliError(
      'Data directory is locked. Stop the other instance, or retry after the 10-second lease expires following a crash.',
      { cause },
    )
  }
}
