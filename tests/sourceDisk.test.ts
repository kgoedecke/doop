import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceLocalSource, SOURCE_RECOVERY_DIR } from '../server/sourceDisk.ts'

vi.mock(import('node:fs/promises'), async (load) => {
  const actual = await load()
  const link = vi.fn(actual.link)
  const rename = vi.fn(actual.rename)
  return { ...actual, link, rename, default: { ...actual.default, link, rename } }
})

describe('local source compare and replace', () => {
  let root: string
  let file: string

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'doop-source-')))
    file = path.join(root, 'Demo.tsx')
    await fs.writeFile(file, 'original')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('publishes the new content and retains the displaced file', async () => {
    expect(await replaceLocalSource(root, file, 'original', 'visual edit')).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe('visual edit')
    const recovery = path.join(root, SOURCE_RECOVERY_DIR)
    const [name] = await fs.readdir(recovery)
    expect(await fs.readFile(path.join(recovery, name!), 'utf8')).toBe('original')
  })

  it('restores an external save that lands immediately before displacement', async () => {
    const { rename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      await fs.writeFile(file, 'external save')
      await rename(from, to)
    })

    expect(await replaceLocalSource(root, file, 'original', 'visual edit')).toBe(false)
    expect(await fs.readFile(file, 'utf8')).toBe('external save')
  })

  it('does not overwrite a file recreated just before publication', async () => {
    const { link } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.link).mockImplementationOnce(async (from, to) => {
      await fs.writeFile(file, 'external save', { flag: 'wx' })
      await link(from, to)
    })

    expect(await replaceLocalSource(root, file, 'original', 'visual edit')).toBe(false)
    expect(await fs.readFile(file, 'utf8')).toBe('external save')
    const recovery = path.join(root, SOURCE_RECOVERY_DIR)
    const [name] = await fs.readdir(recovery)
    expect(await fs.readFile(path.join(recovery, name!), 'utf8')).toBe('original')
  })
})
