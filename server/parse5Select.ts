import { is, type Options } from 'css-select'
import type { DefaultTreeAdapterTypes as Tree } from 'parse5'

/**
 * css-select over parse5's tree, for asking whether one element meets a selector: the whole of
 * CSS selector matching (`:not()`, escapes, attribute values and HTML's case rules for them,
 * combinators with backtracking) rather than a hand-made subset of it.
 */

type Node = Tree.Node
type Element = Tree.Element

const isTag = (node: Node): node is Element => 'tagName' in node
const kids = (node: Node): Node[] => ('childNodes' in node ? (node.childNodes as Node[]) : [])
const parentOf = (node: Node): Node | null => ('parentNode' in node ? ((node.parentNode as Node | null) ?? null) : null)

function findAll(test: (el: Element) => boolean, nodes: Node[]): Element[] {
  const found: Element[] = []
  const stack = [...nodes].reverse()
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!isTag(node)) continue
    if (test(node)) found.push(node)
    stack.push(...[...kids(node)].reverse())
  }
  return found
}

const adapter: Options<Node, Element>['adapter'] = {
  isTag,
  existsOne: (test, nodes) => findAll(test, nodes).length > 0,
  getAttributeValue: (el, name) => el.attrs.find((attr) => attr.name === name)?.value,
  getChildren: kids,
  getName: (el) => el.tagName,
  getParent: parentOf,
  getSiblings: (node) => {
    const parent = parentOf(node)
    return parent ? kids(parent) : [node]
  },
  getText: (node) => {
    if ('value' in node && typeof node.value === 'string') return node.value
    return kids(node)
      .map((kid) => adapter!.getText(kid))
      .join('')
  },
  hasAttrib: (el, name) => el.attrs.some((attr) => attr.name === name),
  removeSubsets: (nodes) =>
    nodes.filter((node) => {
      for (let up = parentOf(node); up; up = parentOf(up)) if (nodes.includes(up)) return false
      return true
    }),
  findAll,
  findOne: (test, nodes) => findAll(test, nodes)[0] ?? null,
}

/* selector lists inside a pseudo-class: a state in them is taken out the same way */
const GROUPS = new Set(['not', 'is', 'where', 'matches', '-webkit-any'])

const STATES = new Set(['hover', 'active', 'visited', 'focus', 'focus-within', 'focus-visible', 'target'])

/**
 * The selector with its interaction states taken out: the page is in them some of the time and
 * out of them the rest, so neither `:hover` nor `:not(:hover)` decides whether an ancestor can
 * hold. A `:not()`, `:is()` or `:where()` left empty goes too. Quoted values and escapes are read past, never changed.
 */
export function withoutStates(selector: string): string {
  return stripStates(selector).text
}

/** The selector without its states, and whether it named any. */
function stripStates(selector: string): { text: string; removed: boolean } {
  let out = ''
  let removed = false
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!
    if (char === '\\') {
      out += selector.slice(i, i + 2)
      i++
    } else if (char === '"' || char === "'") {
      const end = closingQuote(selector, i)
      out += selector.slice(i, end + 1)
      i = end
    } else if (char === ':' && selector[i + 1] !== ':') {
      const name = /^:([\w-]+)/.exec(selector.slice(i))?.[1] ?? ''
      const after = i + 1 + name.length
      if (STATES.has(name.toLowerCase()) && selector[after] !== '(') {
        removed = true
        i = after - 1
        continue
      }
      if (GROUPS.has(name.toLowerCase()) && selector[after] === '(') {
        const close = closingParen(selector, after)
        const options = splitList(selector.slice(after + 1, close)).map((option) => {
          const stripped = stripStates(option)
          return { text: stripped.text.trim(), removed: stripped.removed }
        })
        if (options.some((option) => option.removed)) removed = true
        /* an option naming a state holds only some of the time. :not() keeps the options that
           exclude for good (.disabled) and lets go of the rest (.disabled:hover, :focus); in
           :is() or :where() an option made only of states holds some of the time: no condition */
        const fixed = options.filter((option) => option.text && !option.removed)
        const kept = name.toLowerCase() === 'not' ? fixed : options.every((option) => option.text) ? options : []
        if (kept.length) out += `:${name}(${kept.map((option) => option.text).join(', ')})`
        i = close
        continue
      }
      out += char
    } else out += char
  }
  return { text: out, removed }
}

/** A selector list split at its top-level commas. */
function splitList(text: string): string[] {
  const options: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') i++
    else if (char === '"' || char === "'") i = closingQuote(text, i)
    else if (char === '(') i = closingParen(text, i)
    else if (char === ',') {
      options.push(text.slice(start, i))
      start = i + 1
    }
  }
  options.push(text.slice(start))
  return options
}

function closingQuote(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === text[open]) return i
  }
  return text.length - 1
}

function closingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') i++
    else if (char === '"' || char === "'") i = closingQuote(text, i)
    else if (char === '(') depth++
    else if (char === ')' && --depth === 0) return i
  }
  return text.length - 1
}

/** Does `el` meet `selector`, whatever state the page is in? False for one css-select cannot read. */
export function elementIs(el: Element, selector: string): boolean {
  try {
    return is(el, withoutStates(selector) || '*', { adapter, xmlMode: false })
  } catch {
    return false
  }
}
