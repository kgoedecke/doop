import { afterEach, expect, it, vi } from 'vitest'
import {
  addToCodex,
  canAddToCodex,
  codexDesktopLink,
  codexSetupTarget,
  parseCodexSetup,
} from '../src/lib/codexConnection'

afterEach(() => vi.unstubAllGlobals())

it.each(['https://doop.design', 'https://design.example.com:8443', 'http://localhost:4301'])(
  'hands off %s with canvas context, without embedding commands or credentials',
  (origin) => {
    const link = codexDesktopLink(origin, 'canvas-123')
    const target = codexSetupTarget(link)!
    expect(target.startsWith('/desktop/connect/codex?')).toBe(true)
    expect(parseCodexSetup(new URL(target, origin).search, origin)).toEqual({ canvasId: 'canvas-123' })
    expect(parseCodexSetup(new URL(target, origin).search, 'https://other.example')).toBeNull()
  },
)

it('accepts the production www alias and strips unsupported handoff parameters', () => {
  const target = codexSetupTarget(
    `${codexDesktopLink('https://www.doop.design')}\u0026command=evil\u0026canvas=../auth`,
  )!
  expect(target).not.toContain('command')
  expect(target).not.toContain('canvas')
  expect(parseCodexSetup(new URL(target, 'https://doop.design').search, 'https://doop.design')).toEqual({
    canvasId: undefined,
  })
})

it.each([
  'https://connect/codex?origin=https://doop.design',
  'doop://connect/other?origin=https://doop.design',
  'doop://auth?origin=https://doop.design',
  'doop://connect:123/codex?origin=https://doop.design',
  'doop://user@connect/codex?origin=https://doop.design',
  'doop://connect/codex?origin=https://doop.design#fragment',
  'doop://connect/codex',
  'doop://connect/codex?origin=file:///tmp',
  'doop://connect/codex?origin=https://doop.design/mcp',
  'doop://connect/codex?origin=https://user:secret@doop.design',
  'doop://connect/codex?origin=https://doop.design?token=secret',
  'not a url',
])('ignores malformed or unrelated deep links: %s', (link) => {
  expect(codexSetupTarget(link)).toBeNull()
})

it('only calls the native installer with no externally selected server or command', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('__DOOP_CODEX_SETUP__', true)
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  expect(canAddToCodex()).toBe(true)
  await addToCodex()
  expect(invoke).toHaveBeenCalledExactlyOnceWith('codex_add_mcp')
})

it('does not call unknown IPC commands in older shells', async () => {
  const invoke = vi.fn()
  vi.stubGlobal('__TAURI__', { core: { invoke } })
  expect(canAddToCodex()).toBe(false)
  await expect(addToCodex()).rejects.toThrow('Update Doop Desktop')
  expect(invoke).not.toHaveBeenCalled()
})
