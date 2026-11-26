import { parseArgs } from 'node:util'
import { OPTIONS, type Flags } from './context.ts'

/*
 * Canvas and frame ids are nanoid's ten characters, whose alphabet has `-`: about one id in 64
 * starts with a dash, and `parseArgs` takes such an id for an option (`doop link -AbCdEfGhI`
 * failed as "Unknown option '-A'"). An id-shaped word that is no option's spelling is read as
 * the argument it is, and one given to an option that takes a value is that option's value.
 */

/** a dash, then nine more id characters: the shape of a canvas or frame id */
const ID_SHAPED = /^-[\w-]{9}$/

const LONG = new Set(Object.keys(OPTIONS))
const SHORT = new Map<string, string>(
  Object.entries(OPTIONS).flatMap(([name, option]) => ('short' in option ? [[option.short, name]] : [])),
)

function takesValue(name: string | undefined): boolean {
  return name !== undefined && OPTIONS[name as keyof typeof OPTIONS]?.type === 'string'
}

/** The option a word spells, if it spells one: `--name` or `--name=…`, or `-x` alone. */
function optionOf(word: string): { name: string; inline: boolean } | undefined {
  if (word.startsWith('--')) {
    const [name = '', ...rest] = word.slice(2).split('=')
    return LONG.has(name) ? { name, inline: rest.length > 0 } : undefined
  }
  const name = word.length === 2 ? SHORT.get(word[1] ?? '') : undefined
  return name ? { name, inline: false } : undefined
}

/** The command line as `parseArgs` reads it, but with an id that starts with a dash taken as an id. */
export function parseCommandLine(argv: string[]): { flags: Flags; positionals: string[] } {
  const ids = new Map<string, string>()
  const words: string[] = []
  let ended = false
  for (const word of argv) {
    const previous = words.at(-1)
    const wanting = !ended && previous !== undefined ? optionOf(previous) : undefined
    if (word === '--') ended = true
    else if (!ended && ID_SHAPED.test(word) && !optionOf(word)) {
      if (wanting && !wanting.inline && takesValue(wanting.name)) {
        words[words.length - 1] = `--${wanting.name}=${word}`
        continue
      }
      const placeholder = `\u0000${ids.size}`
      ids.set(placeholder, word)
      words.push(placeholder)
      continue
    }
    words.push(word)
  }
  const { values, positionals } = parseArgs({ args: words, options: OPTIONS, allowPositionals: true, strict: true })
  return { flags: values, positionals: positionals.map((word) => ids.get(word) ?? word) }
}
