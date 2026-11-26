/** Bare web addresses in plain text (a comment, a chat line), cut out so they
 *  can be drawn as links. An address runs from `http://`, `https://` or `www.`
 *  to the next whitespace, less the punctuation that ends the sentence around
 *  it: a trailing `.`, `,`, `!`, a closing quote, or a `)` / `]` it never opened. */

export type LinkSegment = { text: string; href?: undefined } | { text: string; href: string }

const ADDRESS = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi
const SCHEME = /^(?:https?:\/\/|www\.)/i
const TRAILING = /[.,;:!?'"’”*_]$/
const PAIRS: Record<string, string> = { ')': '(', ']': '[' }

export function linkSegments(text: string): LinkSegment[] {
  const out: LinkSegment[] = []
  let at = 0
  for (const match of text.matchAll(ADDRESS)) {
    const start = match.index
    const address = trimAddress(match[0])
    if (!/\w/.test(address.replace(SCHEME, ''))) continue
    if (start > at) out.push({ text: text.slice(at, start) })
    out.push({ text: address, href: /^www\./i.test(address) ? `https://${address}` : address })
    at = start + address.length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

function trimAddress(address: string): string {
  let end = address.length
  for (;;) {
    const last = address[end - 1] ?? ''
    const opener = PAIRS[last]
    if (TRAILING.test(last)) end--
    else if (opener && count(address.slice(0, end), opener) < count(address.slice(0, end), last)) end--
    else return address.slice(0, end)
  }
}

function count(text: string, ch: string): number {
  return text.split(ch).length - 1
}
