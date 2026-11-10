import { beforeEach, expect, it, vi } from 'vitest'
import path from 'node:path'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), removed: vi.fn() }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) }
})
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    rm: async (...args: Parameters<typeof real.rm>) => {
      mocks.removed(...args)
      return real.rm(...args)
    },
  }
})
import { startPrivateStorageFixture } from './privateStorageFixture.ts'
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
beforeEach(() => {
  mocks.exec.mockReset()
  mocks.removed.mockReset()
})

it('never deletes a failed startup runtime when ownership publication is absent', async () => {
  let runtime = ''
  mocks.exec.mockImplementation(async (_command: string, args: string[]) => {
    runtime = args[args.indexOf('--runtime-dir') + 1]!
    await realFs.mkdir(runtime, { mode: 0o700 })
    throw new Error('controlled subprocess outcome lost before state publication')
  })
  try {
    await expect(startPrivateStorageFixture()).rejects.toThrow('ownership state is unavailable; runtime retained')
    expect(mocks.removed).not.toHaveBeenCalled()
    expect((await realFs.stat(path.dirname(runtime))).isDirectory()).toBe(true)
  } finally {
    if (runtime) await realFs.rm(path.dirname(runtime), { recursive: true, force: true })
  }
})
it('retains protected intent when the CLI cannot confirm cleanup', async () => {
  let runtime = ''
  mocks.exec.mockImplementation(async (_command: string, args: string[]) => {
    runtime = args[args.indexOf('--runtime-dir') + 1]!
    if (args[1] === 'start') {
      await realFs.mkdir(runtime, { mode: 0o700 })
      await realFs.writeFile(
        path.join(runtime, 'state.json'),
        JSON.stringify({ owner: 'owned-fixture', phase: 'pending' }),
        { mode: 0o600 },
      )
      throw new Error('controlled lost startup result')
    }
    throw new Error('controlled cleanup unavailable')
  })
  try {
    await expect(startPrivateStorageFixture()).rejects.toThrow('cleanup failed; runtime retained')
    expect(mocks.removed).not.toHaveBeenCalled()
    expect((await realFs.stat(path.join(runtime, 'state.json'))).mode & 0o777).toBe(0o600)
    expect(mocks.exec.mock.calls.map(([, args]) => args[1])).toEqual(['start', 'stop'])
  } finally {
    if (runtime) await realFs.rm(path.dirname(runtime), { recursive: true, force: true })
  }
})
it('removes only its new runtime after a failed startup receives confirmed owned cleanup', async () => {
  let runtime = ''
  mocks.exec.mockImplementation(async (_command: string, args: string[]) => {
    runtime = args[args.indexOf('--runtime-dir') + 1]!
    if (args[1] === 'start') {
      await realFs.mkdir(runtime, { mode: 0o700 })
      await realFs.writeFile(
        path.join(runtime, 'state.json'),
        JSON.stringify({ owner: 'owned-fixture', phase: 'pending' }),
        { mode: 0o600 },
      )
      throw new Error('controlled startup failed')
    }
    return { stdout: '{"stopped":true}', stderr: '' }
  })
  await expect(startPrivateStorageFixture()).rejects.toThrow('setup failed')
  expect(mocks.removed).toHaveBeenCalledExactlyOnceWith(path.dirname(runtime), { recursive: true, force: true })
  await expect(realFs.stat(path.dirname(runtime))).rejects.toMatchObject({ code: 'ENOENT' })
})
