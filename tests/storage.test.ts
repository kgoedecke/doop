import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/* Disk mode with an isolated data dir: DISK_DIR is computed from
 * process.cwd() at module load, so pin cwd to a temp dir before importing. */
let tmp: string
let storage: typeof import('../server/storage.ts')

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doop-storage-'))
  vi.spyOn(process, 'cwd').mockReturnValue(tmp)
  storage = await import('../server/storage.ts')
})

afterAll(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('storage keys', () => {
  it('round-trips a plain asset key and a thumb/ key', async () => {
    await storage.putObject('abc123.png', Buffer.from('asset'), 'image/png')
    await storage.putObject('thumb/frame-1.jpg', Buffer.from('thumb'), 'image/jpeg')
    expect((await storage.getObject('abc123.png'))?.toString()).toBe('asset')
    expect((await storage.getObject('thumb/frame-1.jpg'))?.toString()).toBe('thumb')
  })

  it('deletes objects and tolerates deleting what is not there', async () => {
    await storage.putObject('thumb/gone.jpg', Buffer.from('x'), 'image/jpeg')
    await storage.deleteObject('thumb/gone.jpg')
    expect(await storage.getObject('thumb/gone.jpg')).toBeNull()
    await expect(storage.deleteObject('thumb/gone.jpg')).resolves.toBeUndefined()
  })

  it('returns null for a missing key', async () => {
    expect(await storage.getObject('never-written.png')).toBeNull()
  })

  it('bounds actual bytes even when an object is larger than its declared use', async () => {
    await storage.putObject('bounded.png', Buffer.alloc(9), 'image/png')
    await expect(storage.getObject('bounded.png', 8)).rejects.toThrow(/read budget/)
    expect((await storage.getObject('bounded.png', 9))?.length).toBe(9)
    await expect(storage.getObject('bounded.png', 10 * 1024 * 1024 + 1)).rejects.toThrow(/invalid/)
    const large = path.join(tmp, 'data', 'assets', 'large.png')
    await fs.writeFile(large, '')
    await fs.truncate(large, 10 * 1024 * 1024 + 1)
    await expect(storage.getObject('large.png')).rejects.toThrow(/read budget/)
  })

  it.each([
    '../escape.png',
    'thumb/../escape.png',
    'thumb/thumb/nested.jpg',
    'other/prefix.jpg',
    'thumb/.jpg',
    'no-extension',
    'thumb/dir/',
    'a b.png',
  ])('rejects malformed key %s everywhere', async (key) => {
    await expect(storage.putObject(key, Buffer.from('x'), 'image/png')).rejects.toThrow(/malformed storage key/)
    await expect(storage.getObject(key)).rejects.toThrow(/malformed storage key/)
    await expect(storage.deleteObject(key)).rejects.toThrow(/malformed storage key/)
  })

  it('keeps thumbs in their own folder on disk', async () => {
    await storage.putObject('thumb/frame-2.jpg', Buffer.from('t'), 'image/jpeg')
    const stat = await fs.stat(path.join(tmp, 'data', 'assets', 'thumb', 'frame-2.jpg'))
    expect(stat.isFile()).toBe(true)
  })
})
