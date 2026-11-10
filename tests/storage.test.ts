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
  it('round-trips asset, thumbnail and icon cache keys', async () => {
    await storage.putObject('abc123.png', Buffer.from('asset'), 'image/png')
    await storage.putObject('thumb/frame-1.jpg', Buffer.from('thumb'), 'image/jpeg')
    await storage.putObject('icons/abc123.svg', Buffer.from('<svg/>'), 'image/svg+xml')
    expect((await storage.getObject('abc123.png'))?.toString()).toBe('asset')
    expect((await storage.getObject('thumb/frame-1.jpg'))?.toString()).toBe('thumb')
    expect((await storage.getObject('icons/abc123.svg'))?.toString()).toBe('<svg/>')
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
