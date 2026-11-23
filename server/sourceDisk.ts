import { chmod, link, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export const SOURCE_RECOVERY_DIR = '.doop-source-recovery'

function exists(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

async function restoreSource(backup: string, file: string) {
  try {
    await link(backup, file)
  } catch (error) {
    if (exists(error)) return
    throw error
  }
  await unlink(backup)
}

export async function replaceLocalSource(root: string, file: string, expected: string, updated: string) {
  const folder = path.join(root, SOURCE_RECOVERY_DIR)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  if ((await realpath(folder)) !== folder) throw new Error('Source recovery directory must not be redirected')
  const id = randomUUID()
  const temp = path.join(path.dirname(file), '.doop-' + id)
  const backup = path.join(folder, path.basename(file) + '.' + id + '.bak')
  try {
    await writeFile(temp, updated, { flag: 'wx', mode: 0o600 })
    await chmod(temp, (await stat(file)).mode & 0o777)
    await rename(file, backup)
    try {
      if ((await readFile(backup, 'utf8')) === expected) {
        await link(temp, file)
        return true
      }
    } catch (error) {
      if (!exists(error)) {
        await restoreSource(backup, file)
        throw error
      }
    }
    await restoreSource(backup, file)
    return false
  } finally {
    await unlink(temp).catch(() => {})
  }
}
