/* Just enough TOML to replace one table of a config file the person also
   edits by hand (Codex's ~/.codex/config.toml) without a parser: which line
   opens which table. */

const KEY = String.raw`(?:[\w-]+|"(?:[^"\\]|\\.)*"|'[^']*')`
const HEADER = new RegExp(String.raw`^\[\[?\s*(${KEY}(?:\s*\.\s*${KEY})*)\s*\]\]?\s*(?:#.*)?$`)
const PART = new RegExp(KEY, 'g')

/** The dotted name of a table header line (`[a."b".c]  # note` → `a.b.c`), or null for any other line. */
export function tableName(line: string): string | null {
  const dotted = line.trim().match(HEADER)?.[1]
  if (!dotted) return null
  return (dotted.match(PART) ?? []).map((part) => (/^["']/.test(part) ? part.slice(1, -1) : part)).join('.')
}

/** `text` without the table `name` and its sub-tables, ending in no blank lines. */
export function withoutTable(text: string, name: string): string {
  const kept: string[] = []
  let skipping = false
  for (const line of text.split('\n')) {
    const header = tableName(line)
    if (header !== null) skipping = header === name || header.startsWith(`${name}.`)
    if (!skipping) kept.push(line)
  }
  return kept.join('\n').replace(/\n*$/, '')
}
