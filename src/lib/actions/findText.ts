/* Find and replace over frame HTML: the text a person reads, never markup,
   scripts or styles. A match lives inside one text node (as a browser's own
   find does it across a styled run, it is two matches here, which is what a
   replace can change safely). Pure: HTML in, matches or HTML out. */

import { elementPath } from '../layers'

const SKIPPED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'TEXTAREA'])

export interface FindOptions {
  matchCase?: boolean
}

export interface TextMatch {
  /** the element whose text holds the match, as the Layers panel paths it */
  selector: string
  /** the text around the match, for the results list */
  before: string
  text: string
  after: string
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function textNodes(doc: Document): Text[] {
  const out: Text[] = []
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      for (let el = node.parentElement; el; el = el.parentElement) {
        if (SKIPPED.has(el.tagName)) return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/** Every offset of `query` in `text`, left to right, never overlapping. */
function offsetsIn(text: string, query: string, matchCase: boolean): number[] {
  if (!query) return []
  const hay = matchCase ? text : text.toLowerCase()
  const needle = matchCase ? query : query.toLowerCase()
  const out: number[] = []
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) out.push(at)
  return out
}

const CONTEXT = 24

/** Every match of `query` in the frame's text, in reading order. */
export function findInHtml(html: string, query: string, { matchCase = false }: FindOptions = {}): TextMatch[] {
  if (!query.trim()) return []
  const out: TextMatch[] = []
  for (const node of textNodes(parse(html))) {
    const text = node.data
    const parent = node.parentElement
    if (!parent) continue
    for (const at of offsetsIn(text, query, matchCase)) {
      out.push({
        selector: elementPath(parent),
        before: text.slice(Math.max(0, at - CONTEXT), at).trimStart(),
        text: text.slice(at, at + query.length),
        after: text.slice(at + query.length, at + query.length + CONTEXT).trimEnd(),
      })
    }
  }
  return out
}

/** The frame's HTML with `query` replaced: every match, or only the
 *  `only`-th (0-based, in the order `findInHtml` lists them). Null when
 *  nothing was replaced. */
export function replaceInHtml(
  html: string,
  query: string,
  replacement: string,
  { matchCase = false, only }: FindOptions & { only?: number } = {},
): { html: string; count: number } | null {
  if (!query.trim()) return null
  const doc = parse(html)
  let seen = 0
  let count = 0
  for (const node of textNodes(doc)) {
    const offsets = offsetsIn(node.data, query, matchCase)
    if (!offsets.length) continue
    /* right to left, so the earlier offsets still hold after each swap */
    const picked = offsets
      .map((at, i) => ({ at, n: seen + i }))
      .filter(({ n }) => only === undefined || n === only)
      .reverse()
    seen += offsets.length
    for (const { at } of picked) {
      node.replaceData(at, query.length, replacement)
      count++
    }
    if (only !== undefined && seen > only) break
  }
  if (!count) return null
  return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, count }
}
