import { CSS_ATTR, HEAD_ATTR, INSTANCE_ATTR, isHollow, type ComponentDef } from './components.ts'
import {
  TOKEN_BLOCK_ATTR,
  referencedTokens,
  tokensCss,
  placeTokenBlock,
  tokensUsedBy,
  type DesignToken,
} from './designTokens.ts'

/**
 * A frame's stored HTML is its source: the design, the font faces it loads and
 * nothing the canvas supplies to every frame. What the canvas supplies is
 * composed in wherever a document is rendered or handed on as self-contained:
 *
 *  - the stylesheet of every component the document uses, `<style data-doop-component-css>`
 *  - the links and scripts those components brought, marked `data-doop-component-head`
 *  - the values of the design tokens it names, `<style data-doop-tokens>`
 *
 * `composeFrameHtml` puts them in and `stripSharedBlocks` takes them out, both at
 * string level (no parser), so the server and the browser run the same code. A
 * frame stored before this (its blocks written into it) composes to the same
 * document: stale blocks are replaced, never doubled.
 */

/** The request header by which a client says it composes frames itself: REST answers
 *  then carry frames' source. Without it they carry composed documents, as the
 *  native apps and older browser bundles expect. */
export const COMPOSES_HEADER = 'x-doop-composes-frames'

/** What a component contributes to the frames using it. */
export type SharedComponent = Pick<ComponentDef, 'id' | 'name' | 'template' | 'css' | 'head'>

/** What a canvas supplies to every one of its frames. */
export interface FrameResources {
  tokens: readonly DesignToken[]
  themes: readonly string[]
  components: readonly SharedComponent[]
}

export interface ComposeOptions {
  /** the document is still streaming in: nothing is added until its top has settled */
  partial?: boolean
}

/** A complete `<head>` or `<body>` tag: before one has arrived, the place a block
 *  would go can still be a half-written tag (`<!doctype html><ht`). */
const SETTLED_TOP = /<(?:head|body)\b[^>]*>/i

export function topSettled(html: string): boolean {
  return SETTLED_TOP.test(html)
}

/** Every component an instance in this document uses, nested ones included. */
export function usedComponentIds(html: string): Set<string> {
  const ids = new Set<string>()
  /* the leading space: an element's attribute, not a selector in a stylesheet */
  for (const match of html.matchAll(new RegExp(`\\s${INSTANCE_ATTR}="([^"]+)"`, 'g'))) ids.add(match[1]!)
  return ids
}

/** These components and every one their templates are built from, deleted ones
 *  included (their instances still wear their styles), dependencies first. */
export function componentClosure<T extends SharedComponent>(ids: Iterable<string>, defs: readonly T[]): T[] {
  const seen = new Map<string, T>()
  const stack = [...ids]
  for (let id = stack.pop(); id; id = stack.pop()) {
    if (seen.has(id)) continue
    const def = defs.find((candidate) => candidate.id === id)
    if (!def) continue
    seen.set(id, def)
    for (const match of def.template.matchAll(/component="([^"]+)"/g)) {
      const nested = defs.find((candidate) => candidate.id === match[1] || candidate.name === match[1])
      if (nested) stack.push(nested.id)
    }
  }
  /* dependencies first, so a nested component's rules come before the ones built on them */
  return [...seen.values()].reverse()
}

/** The components whose blocks this document carries when composed. */
export function componentsUsedBy<T extends SharedComponent>(html: string, defs: readonly T[]): T[] {
  if (!defs.length || !html.includes(INSTANCE_ATTR)) return []
  return componentClosure(usedComponentIds(html), defs)
}

/** Everything a component put in the head: its stylesheet, and the links and scripts it brought.
 *  The stylesheets of the components in `keep` stay. */
export function stripComponentHead(html: string, keep: ReadonlySet<string> = new Set()): string {
  if (!html.includes(CSS_ATTR) && !html.includes(HEAD_ATTR)) return html
  return html
    .replace(
      new RegExp(`<style[^>]*\\b${CSS_ATTR}="([^"]*)"[^>]*>[\\s\\S]*?</style>\\n?`, 'gi'),
      (block, id: string) => (keep.has(id) ? block : ''),
    )
    .replace(new RegExp(`<script[^>]*\\s${HEAD_ATTR}(?:="[^"]*")?[\\s>][^>]*>[\\s\\S]*?</script>\\n?`, 'gi'), '')
    .replace(new RegExp(`<link[^>]*\\s${HEAD_ATTR}(?:="[^"]*")?[\\s>/][^>]*>\\n?`, 'gi'), '')
}

/** A head tag with the mark that says a component brought it, so `frameHeadTags` and the next
 *  `syncComponentHead` can tell it from the frame's own. */
function markedHeadTag(tag: string): string {
  return tag.replace(/^<(link|script)\b/i, `<$1 ${HEAD_ATTR}`)
}

/** Put exactly the component stylesheets this document needs into its head. */
export function syncComponentHead(html: string, defs: readonly SharedComponent[]): string {
  /* a hollow component has no stylesheet to put back: its instances keep the one they have */
  const stripped = stripComponentHead(html, new Set(defs.filter(isHollow).map((def) => def.id)))
  const blocks: string[] = []
  for (const def of defs) {
    /* a tag the frame has of its own, or one another component already brought, is not repeated */
    for (const tag of def.head) {
      const marked = markedHeadTag(tag)
      if (!stripped.includes(tag) && !blocks.includes(marked)) blocks.push(marked)
    }
    if (def.css.trim()) blocks.push(`<style ${CSS_ATTR}="${def.id}">\n${def.css}\n</style>`)
  }
  if (!blocks.length) return stripped === html ? html : stripped
  return insertIntoHead(stripped, blocks.join('\n'))
}

export function insertIntoHead(html: string, block: string): string {
  const close = /<\/head\s*>/i.exec(html)
  if (close) return `${html.slice(0, close.index)}${block}\n${html.slice(close.index)}`
  const open = /<head\b[^>]*>/i.exec(html)
  if (open) return `${html.slice(0, open.index + open[0].length)}\n${block}${html.slice(open.index + open[0].length)}`
  const body = /<body\b[^>]*>/i.exec(html)
  if (body) return `${html.slice(0, body.index)}<head>\n${block}\n</head>${html.slice(body.index)}`
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  const at = doctype ? doctype[0].length : 0
  return `${html.slice(0, at)}${block}\n${html.slice(at)}`
}

const TOKEN_BLOCKS = new RegExp(`<style\\b[^>]*\\b${TOKEN_BLOCK_ATTR}\\b[^>]*>[\\s\\S]*?</style>`, 'gi')

/** The hollow components this document has instances of: their stylesheets are the
 *  only copy left, so they stay in the frame (shared/components.ts `isHollow`). */
export function hollowIdsIn(html: string, defs: readonly SharedComponent[]): Set<string> {
  return new Set(
    componentsUsedBy(html, defs)
      .filter(isHollow)
      .map((def) => def.id),
  )
}

/**
 * The source of a document: without the component stylesheets, the head tags components
 * brought and the token block. The stylesheets of the components in `keep` stay (the
 * hollow ones, see `hollowIdsIn`). Returns the input itself when it carries none.
 */
export function stripSharedBlocks(html: string, keep: ReadonlySet<string> = new Set()): string {
  return stripTokenBlocks(stripComponentHead(html, keep))
}

function stripTokenBlocks(html: string): string {
  return html.includes(TOKEN_BLOCK_ATTR) ? html.replace(TOKEN_BLOCKS, '') : html
}

/** The source of a document on a canvas with these components. */
export function sourceOf(html: string, components: readonly SharedComponent[]): string {
  return stripSharedBlocks(html, hollowIdsIn(html, components))
}

export interface ComposedFrame {
  html: string
  /** what the canvas supplied to it: equal for two compositions exactly when the same
   *  stylesheets, head tags and token values went in, whatever the source was */
  shared: string
}

/**
 * The self-contained document, with what was put into it as a value to compare: the source
 * with the stylesheets and head tags of the components it uses at the end of its head, and
 * the values of the tokens it names (its components' rules included) first in it.
 * Idempotent, and the same for a source and for a document that already carries blocks,
 * whatever they held. `html` is the input itself when nothing changed.
 */
export function composeFrame(source: string, resources: FrameResources, options: ComposeOptions = {}): ComposedFrame {
  if (options.partial && !topSettled(source)) return { html: source, shared: '' }
  /* from the source every time: a token block the document already carries would
     otherwise keep the place it has, and the result depend on what was there */
  const design = stripTokenBlocks(source)
  const defs = componentsUsedBy(design, resources.components)
  const withComponents = syncComponentHead(design, defs)
  const tokens = tokensCss(tokensUsedBy(withComponents, resources.tokens), resources.themes)
  const html = placeTokenBlock(withComponents, tokens)
  const shared = [tokens, ...defs.map((def) => `${def.id}\n${def.css}\n${def.head.join('\n')}`)].join('\u0000')
  return { html: html === source ? source : html, shared }
}

/** The self-contained document alone (`composeFrame`). */
export function composeFrameHtml(source: string, resources: FrameResources, options: ComposeOptions = {}): string {
  return composeFrame(source, resources, options).html
}

/** What a document's composition depends on: every token it names (its components' rules
 *  included, and one the canvas does not have yet, so creating it counts), the tokens
 *  those read, and the components it uses. A change to anything else on the canvas leaves
 *  the composed document as it is. */
export function sharedDependencies(
  source: string,
  resources: FrameResources,
): { tokens: string[]; components: string[] } {
  const design = stripTokenBlocks(source)
  const defs = componentsUsedBy(design, resources.components)
  const withComponents = syncComponentHead(design, defs)
  const tokens = new Set(tokensUsedBy(withComponents, resources.tokens).map((token) => token.name))
  for (const name of referencedTokens(withComponents)) tokens.add(name)
  return { tokens: [...tokens], components: defs.map((def) => def.id) }
}
