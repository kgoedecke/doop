/* The little markdown agents write in a chat answer, parsed into blocks and
   inline spans the chat renders as React elements (never as HTML, so nothing
   an agent writes can inject markup). Covers what replies actually use:
   paragraphs, headings, bullet and numbered lists, fenced code, bold,
   italic, inline code and http(s) links. Anything else stays literal text. */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'code'; text: string }

const FENCE = /^\s*```/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []

  const closeParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', lines: paragraph.map(parseInline) })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    /* a fence that never closes (a stray one, or a reply cut short) stays text */
    const close = FENCE.test(line) ? lines.findIndex((l, j) => j > i && FENCE.test(l)) : -1
    if (close > i) {
      closeParagraph()
      blocks.push({ kind: 'code', text: lines.slice(i + 1, close).join('\n') })
      i = close
      continue
    }
    if (!line.trim()) {
      closeParagraph()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      closeParagraph()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, children: parseInline(heading[2] ?? '') })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      closeParagraph()
      const ordered = !bullet
      const item = (bullet?.[1] ?? numbered?.[2] ?? '').trim()
      const last = blocks.at(-1)
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(parseInline(item))
      else blocks.push({ kind: 'list', ordered, start: Number(numbered?.[1] ?? 1), items: [parseInline(item)] })
      continue
    }
    /* an indented line right under a list item continues it */
    const last = blocks.at(-1)
    if (!paragraph.length && last?.kind === 'list' && /^\s+\S/.test(line) && !blankBefore(lines, i)) {
      const items = last.items
      items[items.length - 1] = [...(items.at(-1) ?? []), { kind: 'text', text: ' ' }, ...parseInline(line.trim())]
      continue
    }
    paragraph.push(line)
  }
  closeParagraph()
  return blocks
}

function blankBefore(lines: string[], i: number): boolean {
  return i > 0 && !(lines[i - 1] ?? '').trim()
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i

/** Bold, italic, inline code and links in one line; unmatched markers stay text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let plain = ''
  const flush = () => {
    if (plain) out.push({ kind: 'text', text: plain })
    plain = ''
  }

  let i = 0
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ kind: 'code', text: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    const ch = text[i]
    if (ch === '*' || ch === '_') {
      const span = emphasisAt(text, i)
      if (span) {
        flush()
        out.push(span.node)
        i = span.end
        continue
      }
    }

    if (ch === '[') {
      const link = linkAt(text, i)
      if (link) {
        flush()
        out.push(link.node)
        i = link.end
        continue
      }
    }

    plain += ch
    i++
  }
  flush()
  return out
}

type Span = { node: Inline; end: number }

/* `***x***` is bold italic, `**x**` bold, `*x*` italic. `_x_` is italic only at
   a word edge, and `__` is never bold, so snake_case and __init__ stay as written. */
function emphasisAt(text: string, i: number): Span | null {
  const marker = text[i] ?? ''
  let run = 0
  while (text[i + run] === marker && run < 3) run++
  if (marker === '_') run = 1
  if (marker === '_' && /\w/.test(text[i - 1] ?? '')) return null
  for (let size = run; size >= 1; size--) {
    const close = findClose(text, i + size, marker, size)
    if (close < 0) continue
    const after = close + size
    if (marker === '_' && /\w/.test(text[after] ?? '')) continue
    const inner = parseInline(text.slice(i + size, close))
    const node: Inline =
      size === 3
        ? { kind: 'strong', children: [{ kind: 'em', children: inner }] }
        : { kind: size === 2 ? 'strong' : 'em', children: inner }
    return { node, end: after }
  }
  return null
}

/* The closing run of `size` markers for content starting at `from`: the
   content may not start or end with a space, and a longer run inside it
   (bold inside italics) is skipped as a whole. */
function findClose(text: string, from: number, marker: string, size: number): number {
  if (!text[from] || /\s/.test(text[from])) return -1
  let j = from
  while (j < text.length) {
    if (text[j] === '`') {
      const end = text.indexOf('`', j + 1)
      if (end > j) {
        j = end + 1
        continue
      }
    }
    if (text[j] !== marker) {
      j++
      continue
    }
    let run = 0
    while (text[j + run] === marker) run++
    if (run === size && j > from && !/\s/.test(text[j - 1] ?? '')) return j
    j += run
  }
  return -1
}

/* `[label](href)`, the href allowed balanced parentheses as Wikipedia's use */
function linkAt(text: string, i: number): Span | null {
  const labelEnd = text.indexOf('](', i + 1)
  if (labelEnd <= i + 1 || text.slice(i + 1, labelEnd).includes(']')) return null
  let depth = 0
  let j = labelEnd + 2
  for (; j < text.length; j++) {
    const c = text[j] ?? ''
    if (/\s/.test(c)) return null
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) break
      depth--
    }
  }
  const href = text.slice(labelEnd + 2, j)
  if (j >= text.length || !SAFE_HREF.test(href)) return null
  return { node: { kind: 'link', href, children: parseInline(text.slice(i + 1, labelEnd)) }, end: j + 1 }
}
