import { serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { parse } from './workBudget.ts'
import { elementIs } from './parse5Select.ts'
import { CSS_ATTR, DETACHED_CSS_ATTR, HEAD_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
import { TOKEN_BLOCK_ATTR } from '../shared/designTokens.ts'
import { FONT_BLOCK_ATTR } from '../shared/fonts.ts'
import { WEB_FONT_LINK_ATTR } from '../shared/webFonts.ts'

/**
 * What a main element takes along from its frame: the rules it uses, scoped so
 * they cannot restyle anything else in a frame that uses the component. The
 * server has no CSSOM, so selectors are matched on what they name (classes,
 * ids, tags, attributes), which over-keeps a rule now and then; scoping makes
 * that harmless. `:where()` adds no specificity, so rules keep their order.
 */

type Element = Tree.Element

const INHERITED = new Set([
  'color',
  'cursor',
  'direction',
  'font',
  'font-family',
  'font-feature-settings',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-align',
  'text-rendering',
  'text-transform',
  'word-spacing',
  '-webkit-font-smoothing',
  '-moz-osx-font-smoothing',
])

const GROUP_AT_RULES = new Set(['media', 'supports', 'container', 'layer'])

type CssNode =
  | { kind: 'rule'; selector: string; body: string }
  | { kind: 'group'; prelude: string; nodes: CssNode[] }
  | { kind: 'atomic'; name: string; text: string; prelude: string; body: string }

/** The end of a block whose `{` sits at `open`, skipping strings and escapes. An escaped
 *  quote or brace (Tailwind's `\'` in `[class*='size-']`) is part of a name, not a string.
 *  -1 when the block never closes. */
function blockEnd(css: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < css.length; i++) {
    const char = css[i]
    if (char === '\\') i++
    else if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return i
  }
  return -1
}

interface ReadCss {
  nodes: CssNode[]
  /** The first place reading went wrong, to the end of the sheet: text outside any rule
   *  (skipped), or a block or string never closed (everything after it folded into it). */
  unread: string | null
}

function readCss(source: string): ReadCss {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const nodes: CssNode[] = []
  let unread: string | null = null
  const note = (from: number) => (unread ??= css.slice(from).trim() || null)
  let at = 0
  while (at < css.length) {
    let open = -1
    let semi = -1
    let quote = ''
    for (let i = at; i < css.length; i++) {
      const char = css[i]
      if (char === '\\') i++
      else if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '{') {
        open = i
        break
      } else if (char === ';') {
        semi = i
        break
      }
    }
    if (semi !== -1) {
      const text = css.slice(at, semi).trim()
      if (text.startsWith('@'))
        nodes.push({ kind: 'atomic', name: atName(text), text: `${text};`, prelude: '', body: '' })
      else if (text) note(at)
      at = semi + 1
      continue
    }
    if (open === -1) {
      note(at)
      break
    }
    const closed = blockEnd(css, open)
    /* never closed: like a browser, the block runs to the end, but whatever followed it
       (the rest of the sheet, behind an unclosed string) is read as part of it */
    const end = closed === -1 ? css.length : closed
    const prelude = css.slice(at, open).trim()
    const body = css.slice(open + 1, end)
    if (prelude.startsWith('@')) {
      const name = atName(prelude)
      if (GROUP_AT_RULES.has(name)) {
        const inner = readCss(body)
        nodes.push({ kind: 'group', prelude, nodes: inner.nodes })
        unread ??= inner.unread
      } else nodes.push({ kind: 'atomic', name, text: `${prelude}{${body}}`, prelude, body })
    } else if (prelude) {
      nodes.push({ kind: 'rule', selector: prelude, body })
    }
    if (closed === -1) note(at)
    at = end + 1
  }
  return { nodes, unread }
}

function parseCss(source: string): CssNode[] {
  return readCss(source).nodes
}

const UNREAD_EXCERPT = 120

/** Where a stylesheet stops reading as its author meant, as an excerpt, or null when it reads
 *  cleanly. What follows may be lost, so its author should hear about it. */
export function unreadCss(sheet: string): string | null {
  const { unread } = readCss(sheet)
  if (!unread) return null
  return unread.length > UNREAD_EXCERPT ? `${unread.slice(0, UNREAD_EXCERPT)}…` : unread
}

function atName(prelude: string): string {
  return (/^@(-[a-z]+-)?([a-z-]+)/i.exec(prelude)?.[2] ?? '').toLowerCase()
}

export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = ''
    } else if (char === '\\') i++
    else if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

/** A complex selector cut at its combinators: `.a > .b c` → `.a`, `.b`, `c`, keeping each combinator. */
function compoundsOf(selector: string): { compound: string; combinator: string }[] {
  const pieces: { compound: string; combinator: string }[] = []
  let current = ''
  let pending = ''
  let depth = 0
  const flush = () => {
    if (current) pieces.push({ compound: current, combinator: pending })
    current = ''
  }
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!
    if (char === '\\') {
      current += selector.slice(i, i + 2)
      i++
      continue
    }
    if (char === '(' || char === '[') depth++
    if (char === ')' || char === ']') depth--
    if (depth === 0 && (char === '>' || char === '+' || char === '~')) {
      flush()
      pending = char
    } else if (depth === 0 && /\s/.test(char)) {
      if (current) {
        flush()
        pending = ' '
      }
    } else current += char
  }
  flush()
  return pieces
}

interface Tokens {
  tags: Set<string>
  classes: Set<string>
  ids: Set<string>
  attrs: Set<string>
}

/** `.hover\\:bg-red` names the class `hover:bg-red`. */
function unescapeCss(text: string): string {
  return text.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_match, hex: string | undefined, char: string) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : char,
  )
}

/** Past a bracket or paren at `open`, skipping strings, escapes and whatever nests inside it. */
function pastGroup(text: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') i++
    else if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[') depth++
    else if ((char === ')' || char === ']') && --depth === 0) return i + 1
  }
  return text.length
}

/** What a compound selector requires of an element. Pseudo-classes require nothing we can check here. */
function compoundTokens(compound: string): Tokens {
  const tokens: Tokens = { tags: new Set(), classes: new Set(), ids: new Set(), attrs: new Set() }
  let i = 0
  const ident = () => {
    const start = i
    while (i < compound.length) {
      if (compound[i] === '\\') i += 2
      else if (/[\w\u0080-\uffff-]/.test(compound[i]!)) i++
      else break
    }
    return unescapeCss(compound.slice(start, i))
  }
  while (i < compound.length) {
    const char = compound[i]!
    if (char === '.' || char === '#') {
      i++
      ;(char === '.' ? tokens.classes : tokens.ids).add(ident())
    } else if (char === '[') {
      const name = /^\[\s*([\w:-]+)/.exec(compound.slice(i))?.[1]
      if (name) tokens.attrs.add(name.toLowerCase())
      i = pastGroup(compound, i)
    } else if (char === ':') {
      i += compound[i + 1] === ':' ? 2 : 1
      ident()
      if (compound[i] === '(') i = pastGroup(compound, i)
    } else {
      const start = i
      const tag = ident()
      if (tag) tokens.tags.add(tag.toLowerCase())
      if (i === start) i++
    }
  }
  return tokens
}

function compoundMatches(compound: string, tokens: Tokens): boolean {
  const wanted = compoundTokens(compound)
  const within = (names: Set<string>, available: Set<string>) => [...names].every((name) => available.has(name))
  return (
    within(wanted.tags, tokens.tags) &&
    within(wanted.classes, tokens.classes) &&
    within(wanted.ids, tokens.ids) &&
    within(wanted.attrs, tokens.attrs)
  )
}

/** What a main is made of: its own elements, and apart from them the components nested in it;
 *  and the elements it sits in, nearest first. */
interface SubtreeTokens {
  own: Tokens
  nested: Tokens
  ancestors: Element[]
}

/** A selected subtree: the selector as far as it concerns it, and a condition on the document
 *  it keeps (a theme), to be written before the scope. */
interface Relevant {
  selector: string
  prefix: string
}

/** The selector as far as it concerns the subtree: compounds naming ancestors outside it are cut off.
 *  Null when its subject is not in the subtree at all. A subject inside a nested component counts
 *  only when the selector reaches it from one of the main's own elements (`.plan .btn`): that is
 *  this component restyling what it holds, where a bare `.btn` is the nested component's business. */
function relevantSelector(selector: string, { own, nested, ancestors }: SubtreeTokens): Relevant | null {
  const compounds = compoundsOf(selector)
  if (!compounds.length) return null
  const isOwn = (index: number) => compoundMatches(compounds[index]!.compound, own)
  const isNested = (index: number) => compoundMatches(compounds[index]!.compound, nested)
  let first = compounds.length - 1
  if (!isOwn(first)) {
    if (!isNested(first)) return null
    while (first > 0 && !isOwn(first - 1) && isNested(first - 1)) first--
    if (first === 0 || !isOwn(first - 1)) return null
  }
  while (first > 0 && isOwn(first - 1)) first--
  const prefix = keptAncestors(compounds, first, ancestors)
  if (prefix === null) return null
  return { selector: joinCompounds(compounds.slice(first)), prefix }
}

function joinCompounds(pieces: { compound: string; combinator: string }[]): string {
  return pieces
    .map((piece, index) => {
      if (index === 0) return piece.compound
      return piece.combinator === ' ' ? ` ${piece.compound}` : ` ${piece.combinator} ${piece.compound}`
    })
    .join('')
}

/**
 * The compounds before `first` name what the main sits in: the rule is how the main looks
 * there, and they are cut, when its ancestors meet them (matched by css-select, values and all;
 * `>` asks it of the main's parent). When they do not (`.login__card h2` for a main outside any
 * card) the rule is someone else's: null. A theme condition that does not hold now, wherever
 * it sits (`html.dark .bar`, `.shell [data-doop-theme="dark"] .bar`), stays as the rule's
 * condition when the rest holds; the rest is cut: the prefix returned. A sibling (`+`, `~`) is
 * not checked, as it never was.
 */
function keptAncestors(
  compounds: { compound: string; combinator: string }[],
  first: number,
  ancestors: Element[],
): string | null {
  if (first === 0) return ''
  const joiner = compounds[first]!.combinator
  if (joiner === '+' || joiner === '~') return ''
  const candidates = joiner === '>' ? ancestors.slice(0, 1) : ancestors
  const meets = (pieces: { compound: string; combinator: string }[]) =>
    candidates.some((el) => elementIs(el, joinCompounds(pieces)))
  const named = compounds.slice(0, first)
  if (meets(named)) return ''
  const themeless = named.map((piece) => ({ ...piece, compound: withoutTheme(piece.compound) }))
  const themes = named.flatMap((piece, index) => (piece.compound !== themeless[index]!.compound ? [index] : []))
  if (!themes.length || !meets(themeless)) return null
  /* only the theme stays a condition: the wrappers around it are where the main sits, cut like
     any. Two themes side by side keep how they were joined (`>` stays `>`) */
  return themes
    .map((at, index) => {
      const compound = named[at]!.compound
      if (index === 0) return compound
      const joiner = themes[index - 1] === at - 1 ? named[at]!.combinator : ' '
      return joiner === ' ' ? ` ${compound}` : ` ${joiner} ${compound}`
    })
    .join('')
}

/* a theme is a state the document or a part of it switches into: what the main shows now is
   one of its themes, so a condition on another one is kept, not tested */
const THEME_ATTRIBUTE = /\[\s*data-doop-theme\b(?:[^\]"']|"[^"]*"|'[^']*')*\]/gi
const DOCUMENT_ROOT = /^(?::root|html|body)(?![\w-])/i

function withoutTheme(compound: string): string {
  const bare = compound.replace(THEME_ATTRIBUTE, '')
  const root = DOCUMENT_ROOT.exec(bare)?.[0]
  /* html.dark, :root[data-mode]: the document is always there, its classes are a theme too */
  if (root) return root
  return bare || '*'
}

/** A selector scoped to the instance root: at or below it, its pseudo-classes left in place. */
export function scopeSelector(selector: string, scope: string, prefix = ''): string {
  const where = `:where(${scope})`
  const lead = /^(\*|[a-zA-Z][\w-]*)?((?:[.#](?:[\w\u0080-\uffff-]|\\.)+|\[[^\]]*\])*)/.exec(selector)?.[0] ?? ''
  const before = prefix ? `${prefix} ` : ''
  return `${before}${where} ${selector}, ${before}${lead}${where}${selector.slice(lead.length)}`
}

function isDocumentSelector(selector: string): boolean {
  return /^(:root|html|body)$/i.test(selector.trim())
}

function declarationsOf(body: string): { name: string; value: string }[] {
  return splitTopLevel(body, ';').flatMap((piece) => {
    const colon = piece.indexOf(':')
    if (colon <= 0 || piece.includes('{')) return []
    return [{ name: piece.slice(0, colon).trim(), value: piece.slice(colon + 1).trim() }]
  })
}

function walkElements(node: Tree.ParentNode, visit: (el: Element) => void) {
  const stack = [...node.childNodes]
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (!('tagName' in next)) continue
    visit(next)
    stack.push(...next.childNodes)
  }
}

const noTokens = (): Tokens => ({ tags: new Set(), classes: new Set(), ids: new Set(), attrs: new Set() })

/** `isNested` marks the root of a nested instance: it and everything below it are that component's. */
function addTokens(el: Element, tokens: Tokens) {
  tokens.tags.add(el.tagName.toLowerCase())
  for (const attr of el.attrs) {
    tokens.attrs.add(attr.name.toLowerCase())
    if (attr.name === 'class') for (const name of attr.value.split(/\s+/)) if (name) tokens.classes.add(name)
    if (attr.name === 'id') tokens.ids.add(attr.value)
  }
}

function tokensOf(root: Element, isNested: (el: Element) => boolean): Omit<SubtreeTokens, 'ancestors'> {
  const own = noTokens()
  const nested = noTokens()
  const add = addTokens
  const stack: { el: Element; inside: boolean }[] = [{ el: root, inside: false }]
  for (let next = stack.pop(); next; next = stack.pop()) {
    const inside = next.inside || (next.el !== root && isNested(next.el))
    add(next.el, inside ? nested : own)
    for (const child of next.el.childNodes) if ('tagName' in child) stack.push({ el: child, inside })
  }
  return { own, nested }
}

const isInstanceRoot = (el: Element) => el.attrs.some((attr) => attr.name === INSTANCE_ATTR)

function mainTokens(root: Element, variantAttrs: string[]): SubtreeTokens {
  const tokens = tokensOf(root, isInstanceRoot)
  for (const name of variantAttrs) tokens.own.attrs.add(name)
  return { ...tokens, ancestors: ancestorsOf(root) }
}

/** Each element the main sits in, nearest first: what an ancestor compound may name. */
function ancestorsOf(root: Element): Element[] {
  const chain: Element[] = []
  for (let node = root.parentNode; node && 'tagName' in node; node = node.parentNode) chain.push(node)
  return chain
}

/** The selectors in a stylesheet written for one component that name nothing in it, so that
 *  `extractComponentCss` leaves their rules behind: what its author should hear about. */
export function unmatchedSelectors(sheet: string, root: Element, variantAttrs: string[] = []): string[] {
  const tokens = mainTokens(root, variantAttrs)
  const unmatched: string[] = []
  const visit = (list: CssNode[]) => {
    for (const node of list) {
      if (node.kind === 'group') visit(node.nodes)
      if (node.kind !== 'rule') continue
      for (const selector of splitTopLevel(node.selector, ',')) {
        if (selector && !isDocumentSelector(selector) && !relevantSelector(selector, tokens)) unmatched.push(selector)
      }
    }
  }
  visit(parseCss(sheet))
  return [...new Set(unmatched)]
}

const usedFonts = (css: string) =>
  new Set(
    [...css.matchAll(/font(?:-family)?\s*:([^;}]+)/gi)].flatMap((match) =>
      match[1]!.split(',').map((name) => name.replace(/["']/g, '').trim().toLowerCase()),
    ),
  )

function cssVarsIn(text: string): string[] {
  return [...text.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!)
}

/* blocks the server writes into every frame after the components pass: not a design's own rules,
   and reading them back would freeze a token's value into a component and bump it on the next save */
const MANAGED_STYLE_ATTRS = new Set([CSS_ATTR, DETACHED_CSS_ATTR, TOKEN_BLOCK_ATTR, FONT_BLOCK_ATTR])

/** Everything in a frame's own stylesheets (never another component's copy, nor a managed block). */
export function frameStylesheets(html: string): string {
  const doc = parse(html)
  const parts: string[] = []
  walkElements(doc, (el) => {
    if (el.tagName !== 'style') return
    if (el.attrs.some((attr) => MANAGED_STYLE_ATTRS.has(attr.name))) return
    const text = el.childNodes[0]
    if (text && 'value' in text) parts.push(text.value)
  })
  /* the walk runs last-to-first: put the sheets back in cascade order */
  return parts.reverse().join('\n')
}

/** Font and framework tags from a frame's head: a design can rely on them without any rule saying so.
 *  What another component brought, and the hosted-font link the server keeps, are not the design's own. */
export function frameHeadTags(html: string): string[] {
  const doc = parse(html)
  const tags: string[] = []
  walkElements(doc, (el) => {
    if (el.attrs.some((attr) => attr.name === HEAD_ATTR || attr.name === WEB_FONT_LINK_ATTR)) return
    const attrOf = (name: string) => el.attrs.find((attr) => attr.name === name)?.value
    if (el.tagName === 'link' && attrOf('rel')?.toLowerCase() === 'stylesheet' && attrOf('href'))
      tags.push(serializeOuter(el))
    if (el.tagName === 'script' && /tailwindcss/i.test(attrOf('src') ?? '')) tags.push(serializeOuter(el))
  })
  return tags.reverse()
}

export interface ExtractedCss {
  /** ready for the head of a frame using the component */
  css: string
  /** the same rules unscoped: what a regenerated main's own stylesheet holds */
  rawCss: string
}

/** `variantAttrs` are attributes instances wear and the main need not: `data-<enum prop>` on the root. */
export function extractComponentCss(
  sheet: string,
  root: Element,
  componentId: string,
  variantAttrs: string[] = [],
): ExtractedCss {
  const scope = `[${INSTANCE_ATTR}="${componentId}"]`
  const tokens = mainTokens(root, variantAttrs)
  const nodes = parseCss(sheet)
  const customProps = new Map<string, string>()
  const inherited: string[] = []

  const collectDocumentRules = (list: CssNode[]) => {
    for (const node of list) {
      if (node.kind !== 'rule' || !splitTopLevel(node.selector, ',').some(isDocumentSelector)) continue
      for (const { name, value } of declarationsOf(node.body)) {
        if (name.startsWith('--')) customProps.set(name, value)
        else if (INHERITED.has(name.toLowerCase())) inherited.push(`${name}: ${value}`)
      }
    }
  }
  collectDocumentRules(nodes)

  const keptRules = (list: CssNode[], write: (relevant: Relevant) => string): string[] =>
    list.flatMap((node) => {
      if (node.kind === 'group') {
        const inner = keptRules(node.nodes, write)
        return inner.length ? [`${node.prelude} {\n${inner.join('\n')}\n}`] : []
      }
      if (node.kind === 'atomic') return []
      const selectors = splitTopLevel(node.selector, ',').flatMap((selector) => {
        if (isDocumentSelector(selector)) return []
        const relevant = relevantSelector(selector, tokens)
        return relevant ? [write(relevant)] : []
      })
      return selectors.length ? [`${selectors.join(', ')} {${node.body}}`] : []
    })
  const rules = keptRules(nodes, ({ selector, prefix }) => scopeSelector(selector, scope, prefix))
  const rawRules = keptRules(nodes, ({ selector, prefix }) => (prefix ? `${prefix} ${selector}` : selector))
  const ruleText = rules.join('\n')

  /* inherited and custom properties land on the instance root, so its text
     looks the same wherever it is placed */
  const rootStyle = [...new Set(inherited)]
  /* the main's own style attributes travel with its markup, so what they name has to come along too */
  const inlineStyle = serializedAttrs(root)
  const wanted = new Set<string>()
  const queue = cssVarsIn(`${ruleText} ${rootStyle.join(';')} ${inlineStyle}`)
  for (let name = queue.pop(); name; name = queue.pop()) {
    if (wanted.has(name)) continue
    wanted.add(name)
    queue.push(...cssVarsIn(customProps.get(name) ?? ''))
  }
  const vars = [...wanted].flatMap((name) => {
    const value = customProps.get(name)
    return value === undefined ? [] : [`${name}: ${value}`]
  })
  const rootDeclarations = [...vars, ...rootStyle]

  /* @keyframes and @font-face the kept rules name, wherever they were declared */
  const fonts = usedFonts(`${ruleText} ${rootStyle.join(';')} ${inlineStyle}`)
  const atomics: string[] = []
  const scopedAtomics: string[] = []
  const keyframes: string[] = []
  const keep = (text: string, scoped = text) => {
    atomics.push(text)
    scopedAtomics.push(scoped)
  }
  const collectAtomics = (list: CssNode[]) => {
    for (const node of list) {
      if (node.kind === 'group') collectAtomics(node.nodes)
      if (node.kind !== 'atomic') continue
      if (node.name === 'import') {
        atomics.unshift(node.text)
        scopedAtomics.unshift(node.text)
      }
      if (node.name === 'keyframes') {
        const name = node.prelude.replace(/^@\S+\s*/, '').trim()
        const named = new RegExp(`(^|[\\s,:])${name.replace(/[^\w-]/g, '\\$&')}([\\s,;}]|$)`, 'm')
        if (named.test(ruleText)) {
          /* frames share one namespace for these: another component's `pulse` must not replace this one's */
          const own = /^[\w-]+$/.test(name)
          if (own) keyframes.push(name)
          keep(
            node.text,
            own ? `${node.prelude.replace(name, ownKeyframes(name, componentId))}{${node.body}}` : node.text,
          )
        }
        /* an inline animation keeps the name it was written with: the markup is not rewritten */
        if (named.test(inlineStyle)) {
          if (!atomics.includes(node.text)) atomics.push(node.text)
          if (!scopedAtomics.includes(node.text)) scopedAtomics.push(node.text)
        }
      }
      if (node.name === 'font-face') {
        const family = /font-family\s*:\s*([^;]+)/i.exec(node.body)?.[1]?.replace(/["']/g, '').trim().toLowerCase()
        if (family && fonts.has(family)) keep(node.text)
      }
    }
  }
  collectAtomics(nodes)

  const declarations = rootDeclarations.join('; ')
  return {
    css: [
      ...scopedAtomics,
      ...(declarations ? [`:where(${scope}) {${declarations}}`] : []),
      withOwnAnimations(ruleText, keyframes, componentId),
    ]
      .filter(Boolean)
      .join('\n'),
    rawCss: [...atomics, ...(declarations ? [`:root {${declarations}}`] : []), ...rawRules].join('\n'),
  }
}

const ownKeyframes = (name: string, componentId: string) => `${name}__${componentId}`

function withOwnAnimations(css: string, names: string[], componentId: string): string {
  if (!names.length) return css
  const pattern = new RegExp(`(?<![\\w-])(${names.join('|')})(?![\\w-])`, 'g')
  return css.replace(/animation(?:-name)?\s*:[^;}]*/gi, (declaration) =>
    declaration.replace(pattern, (name) => ownKeyframes(name, componentId)),
  )
}

function serializedAttrs(root: Element): string {
  const values: string[] = []
  const stack = [root]
  for (let next = stack.pop(); next; next = stack.pop()) {
    for (const attr of next.attrs) if (attr.name === 'style') values.push(attr.value)
    for (const child of next.childNodes) if ('tagName' in child) stack.push(child)
  }
  return values.join(';')
}
