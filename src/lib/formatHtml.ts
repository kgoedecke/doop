/* The runtime hands back an element's outerHTML, and frame HTML is usually
   minified — so the element source popover would be one unreadable wall of
   tags. This re-indents it for display and copy; it is never written back to
   the frame, and it bails out (returning the input untouched) whenever the
   rewrite would not be byte-identical apart from whitespace. */

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/* elements whose text is significant — reindenting them changes what renders,
   and their bodies may contain '<', which is not markup there. They are matched
   whole by the tokenizer below and passed through verbatim. */
const RAW = 'script|style|pre|textarea'

/* a text-only element stays on one line while it fits: <h1 class="t">Hi</h1> */
const ONE_LINE_MAX = 100

export function formatHtml(html: string): string {
  const tokens = html.match(new RegExp(`<(${RAW})\\b[^>]*>[\\s\\S]*?</\\1>|<[^>]*>|[^<]+`, 'gi'))
  if (!tokens) return html

  const out: string[] = []
  let depth = 0
  const pad = () => '  '.repeat(depth)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]

    if (token.startsWith('</')) {
      depth = Math.max(0, depth - 1)
      out.push(pad() + token)
      continue
    }

    if (new RegExp(`^<(${RAW})\\b`, 'i').test(token)) {
      out.push(pad() + token)
      continue
    }

    if (token.startsWith('<')) {
      const name = /^<([a-zA-Z0-9-]+)/.exec(token)?.[1].toLowerCase() ?? ''
      if (name === '' || token.endsWith('/>') || VOID.has(name)) {
        out.push(pad() + token)
        continue
      }
      const text = tokens[i + 1]
      const close = tokens[i + 2]
      if (text !== undefined && !text.startsWith('<') && close === `</${name}>`) {
        const line = pad() + token + text.trim() + close
        if (line.length <= ONE_LINE_MAX) {
          out.push(line)
          i += 2
          continue
        }
      }
      out.push(pad() + token)
      depth += 1
      continue
    }

    const text = token.trim()
    if (text !== '') out.push(pad() + text)
  }

  const formatted = out.join('\n')
  const same = (s: string) => s.replace(/\s+/g, '')
  return same(formatted) === same(html) ? formatted : html
}
