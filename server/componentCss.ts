import { parse, serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
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

/** The end of a block whose `{` sits at `open`, skipping strings. */
function blockEnd(css: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let i = open; i < css.length; i++) {
    const char = css[i]
    if (quote) {
      if (char === '\\') i++
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return i
  }
  return css.length
}

function parseCss(source: string): CssNode[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const nodes: CssNode[] = []
  let at = 0
  while (at < css.length) {
    let open = -1
    let semi = -1
    let quote = ''
    for (let i = at; i < css.length; i++) {
      const char = css[i]
      if (quote) {
        if (char === '\\') i++
        else if (char === quote) quote = ''
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
      at = semi + 1
      continue
    }
    if (open === -1) break
    const end = blockEnd(css, open)
    const prelude = css.slice(at, open).trim()
    const body = css.slice(open + 1, end)
    if (prelude.startsWith('@')) {
      const name = atName(prelude)
      if (GROUP_AT_RULES.has(name)) nodes.push({ kind: 'group', prelude, nodes: parseCss(body) })
      else nodes.push({ kind: 'atomic', name, text: `${prelude}{${body}}`, prelude, body })
    } else if (prelude) {
      nodes.push({ kind: 'rule', selector: prelude, body })
    }
    at = end + 1
  }
  return nodes
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

/** The selector as far as it concerns the subtree: compounds naming ancestors outside it are cut off.
 *  Null when its subject is not in the subtree at all. */
function relevantSelector(selector: string, tokens: Tokens): string | null {
  const compounds = compoundsOf(selector)
  const last = compounds[compounds.length - 1]
  if (!last || !compoundMatches(last.compound, tokens)) return null
  let first = compounds.length - 1
  while (first > 0 && compoundMatches(compounds[first - 1]!.compound, tokens)) first--
  return compounds
    .slice(first)
    .map((piece, index) => {
      if (index === 0) return piece.compound
      return piece.combinator === ' ' ? ` ${piece.compound}` : ` ${piece.combinator} ${piece.compound}`
    })
    .join('')
}

/** A selector scoped to the instance root: at or below it, its pseudo-classes left in place. */
export function scopeSelector(selector: string, scope: string): string {
  const where = `:where(${scope})`
  const lead = /^(\*|[a-zA-Z][\w-]*)?((?:[.#](?:[\w\u0080-\uffff-]|\\.)+|\[[^\]]*\])*)/.exec(selector)?.[0] ?? ''
  return `${where} ${selector}, ${lead}${where}${selector.slice(lead.length)}`
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

function tokensOf(root: Element, skip: (el: Element) => boolean): Tokens {
  const tokens: Tokens = { tags: new Set(), classes: new Set(), ids: new Set(), attrs: new Set() }
  const add = (el: Element) => {
    tokens.tags.add(el.tagName.toLowerCase())
    for (const attr of el.attrs) {
      tokens.attrs.add(attr.name.toLowerCase())
      if (attr.name === 'class') for (const name of attr.value.split(/\s+/)) if (name) tokens.classes.add(name)
      if (attr.name === 'id') tokens.ids.add(attr.value)
    }
  }
  const stack: Element[] = [root]
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (next !== root && skip(next)) continue
    add(next)
    for (const child of next.childNodes) if ('tagName' in child) stack.push(child)
  }
  return tokens
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
  const nested = (el: Element) => el.attrs.some((attr) => attr.name === INSTANCE_ATTR)
  const tokens = tokensOf(root, nested)
  for (const name of variantAttrs) tokens.attrs.add(name)
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

  const keptRules = (list: CssNode[], write: (selector: string) => string): string[] =>
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
  const rules = keptRules(nodes, (selector) => scopeSelector(selector, scope))
  const rawRules = keptRules(nodes, (selector) => selector)
  const ruleText = rules.join('\n')

  /* inherited and custom properties land on the instance root, so its text
     looks the same wherever it is placed */
  const rootStyle = [...new Set(inherited)]
  const wanted = new Set<string>()
  const queue = cssVarsIn(`${ruleText} ${rootStyle.join(';')} ${serializedAttrs(root)}`)
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
  const fonts = usedFonts(`${ruleText} ${rootStyle.join(';')}`)
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
        if (new RegExp(`(^|[\\s,:])${name.replace(/[^\w-]/g, '\\$&')}([\\s,;}]|$)`, 'm').test(ruleText)) {
          /* frames share one namespace for these: another component's `pulse` must not replace this one's */
          const own = /^[\w-]+$/.test(name)
          if (own) keyframes.push(name)
          keep(
            node.text,
            own ? `${node.prelude.replace(name, ownKeyframes(name, componentId))}{${node.body}}` : node.text,
          )
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
