import { afterEach, describe, expect, it, vi } from 'vitest'
import { canAddLocalFonts, localFontFile, pickLocalFonts, readLocalFont } from '../src/lib/localFonts.ts'

type Bridge = { __DOOP_LOCAL_FONTS__?: boolean; __TAURI__?: unknown }
const g = globalThis as Bridge

afterEach(() => {
  delete g.__DOOP_LOCAL_FONTS__
  delete g.__TAURI__
})

describe('fonts from this computer', () => {
  it('is offered only in a shell that advertises it and carries the Tauri bridge', async () => {
    expect(canAddLocalFonts()).toBe(false)
    g.__DOOP_LOCAL_FONTS__ = true
    expect(canAddLocalFonts()).toBe(false)
    await expect(pickLocalFonts()).rejects.toThrow(/desktop app/)
    g.__TAURI__ = { core: { invoke: vi.fn() } }
    expect(canAddLocalFonts()).toBe(true)
  })

  it('reads a pick through the shell by the path the panel returned, as an upload-ready File', async () => {
    const bytes = new Uint8Array([0, 1, 0, 0, 7]).buffer
    const invoke = vi.fn(async (command: string) => (command === 'fonts_read_local' ? bytes : null))
    g.__DOOP_LOCAL_FONTS__ = true
    g.__TAURI__ = { core: { invoke } }
    const file = await readLocalFont({ path: '/Users/me/Library/Fonts/Brand.ttf', name: 'Brand.ttf', size: 5 })
    expect(invoke).toHaveBeenCalledWith('fonts_read_local', { path: '/Users/me/Library/Fonts/Brand.ttf' })
    expect(file.name).toBe('Brand.ttf')
    expect(file.type).toBe('font/ttf')
    expect(file.size).toBe(5)
  })

  it('types the file by its extension and leaves unknown ones untyped', () => {
    expect(localFontFile('a.WOFF2', new ArrayBuffer(1)).type).toBe('font/woff2')
    expect(localFontFile('b.otf', new ArrayBuffer(1)).type).toBe('font/otf')
    expect(localFontFile('c', new ArrayBuffer(1)).type).toBe('')
  })
})
