import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import { lockLocalDatabase } from '../server/db/localLock.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function databaseDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doop-lock-'))
  dirs.push(root)
  const dir = path.join(root, 'pg')
  fs.mkdirSync(dir)
  return dir
}

test('refuses another process and allows reopening after release', () => {
  const dir = databaseDir()
  const release = lockLocalDatabase(dir)
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { lockLocalDatabase } from './server/db/localLock.ts'; lockLocalDatabase(process.argv[1])`,
        dir,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
    expect(child.status).not.toBe(0)
    expect(child.stderr).toContain('Local database is locked')
    expect(fs.readFileSync(`${fs.realpathSync(dir)}.lock`, 'utf8')).toBe(`${process.pid}\n`)
  } finally {
    release()
  }
  const releaseAgain = lockLocalDatabase(dir)
  releaseAgain()
  releaseAgain()
})

test('does not silently steal a stale or incomplete lock', () => {
  const dir = databaseDir()
  fs.writeFileSync(`${dir}.lock`, '')
  expect(() => lockLocalDatabase(dir)).toThrow('confirm no Doop server is running')
  expect(fs.existsSync(`${dir}.lock`)).toBe(true)
})

test('normal process exit releases its lock', () => {
  const dir = databaseDir()
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { lockLocalDatabase } from './server/db/localLock.ts'; lockLocalDatabase(process.argv[1])`,
      dir,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
  expect(child.status).toBe(0)
  expect(fs.existsSync(`${dir}.lock`)).toBe(false)
})
