import { describe, expect, it } from 'vitest'
import { parseCommandLine } from '../cli/doop/args.ts'

/* nanoid ids may start with a dash (about one in 64): the CLI reads them as ids, not options */
describe('the doop command line', () => {
  it('takes an id that starts with a dash as an argument', () => {
    expect(parseCommandLine(['link', '-AbCdEfGhI']).positionals).toEqual(['link', '-AbCdEfGhI'])
    expect(parseCommandLine(['expand', 'x1x2x3x4x5', '--AbCdEfGh', '--json']).positionals).toEqual([
      'expand',
      'x1x2x3x4x5',
      '--AbCdEfGh',
    ])
  })

  it('gives such an id to an option that takes a value', () => {
    expect(parseCommandLine(['frames', '--canvas', '-AbCdEfGhI']).flags.canvas).toBe('-AbCdEfGhI')
    expect(parseCommandLine(['screenshot', 'card', '-o', '-shot_1234']).flags.out).toBe('-shot_1234')
    expect(parseCommandLine(['frames', '--json', '-AbCdEfGhI']).positionals).toEqual(['frames', '-AbCdEfGhI'])
  })

  it('still reads options, and still refuses one it does not know', () => {
    expect(parseCommandLine(['pull', '--force', '-h']).flags).toMatchObject({ force: true, help: true })
    expect(parseCommandLine(['pull', '--', '-x']).positionals).toEqual(['pull', '-x'])
    expect(() => parseCommandLine(['pull', '--frobnicate'])).toThrow(/Unknown option/)
    expect(() => parseCommandLine(['pull', '-x'])).toThrow(/Unknown option/)
  })
})
