import fs from 'node:fs'
import path from 'node:path'

/** PGlite's NodeFS storage must only be opened by one process at a time. */
export function lockLocalDatabase(dir: string): () => void {
  const lock = `${fs.realpathSync(dir)}.lock`
  let fd: number
  try {
    fd = fs.openSync(lock, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new Error(
      `Local database is locked (${lock}). Stop the other Doop server first. ` +
        `If a server was killed, confirm no Doop server is running before removing ${path.basename(lock)} from ${path.dirname(lock)}.`,
      { cause: error },
    )
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`)
  } finally {
    fs.closeSync(fd)
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    fs.unlinkSync(lock)
    process.off('exit', release)
  }
  process.once('exit', release)
  return release
}
