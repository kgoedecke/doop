/** A layer leaving its frame takes the CSS it relies on along: a frame's
 *  classes are styled by its own <style> blocks, and markup alone would land
 *  unstyled in the destination. The carried sheet holds what the subtree
 *  uses — rules whose selector matches something in it, the @keyframes and
 *  @font-face those name, the custom properties they read — and every rule
 *  is scoped to the moved markup through a `data-doop-carried-scope` mark on
 *  its root, so a `.card` rule carried in cannot restyle the destination's
 *  own cards. Group rules (@media and the like) stay around what they
 *  enclosed. It travels as one `<style data-doop-carried>` in the
 *  destination head, deduplicated by content. External stylesheets are not
 *  carried: nothing can say which of their rules the layer needs. */

export const CARRIED_ATTR = 'data-doop-carried'
export const SCOPE_ATTR = 'data-doop-carried-scope'

const GENERIC_FONTS = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'inherit',
  'initial',
  'unset',
])

/* states the subtree cannot be in while parsed: a rule for them is kept
   when the selector matches without them */
const STATE_PSEUDO =
  /::?(hover|focus|focus-within|focus-visible|active|visited|link|target|checked|disabled|enabled|placeholder-shown|empty|before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?/g
/* a pseudo-element has to stay at the end of the scoped selector */
const TRAILING_PSEUDO_ELEMENT =
  /(::?(before|after|first-line|first-letter|placeholder|selection|marker|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?)$/
/* animation shorthand tokens that are not the name */
const ANIMATION_KEYWORD =
  /^(none|infinite|ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|steps\(|cubic-bezier\(|normal|reverse|alternate|alternate-reverse|forwards|backwards|both|running|paused|[\d.])/

/** A fresh scope mark for one move or copy. */
export function newScope(): string {
  return Math.random().toString(36).slice(2, 8)
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function serialize(doc: Document): string {
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

/* top-level selector list split, leaving commas inside parens, brackets and quotes alone */
function splitSelectors(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

const STATE = new RegExp(STATE_PSEUDO.source)

/* The selector as it would read in any state: state pseudo-classes and
   pseudo-elements taken out, so the parsed subtree (never hovered, never
   focused) can be asked whether the rule could apply to it. The static
   checks inside a functional pseudo-class stay: `:is(.special:hover)` reads
   `:is(.special)`, `:has(.flag:hover)` reads `:has(.flag)`. An argument that
   was nothing but state is satisfiable: it leaves `:is(…)` / `:where(…)`
   whole, and it drops out of `:not(…)`, as does any argument a state could
   make false. */
function withoutStates(selector: string): string {
  return splitSelectors(selector)
    .map((part) => {
      const lead = /^\s*[>+~]\s*/.exec(part)?.[0] ?? ''
      const { items, joins } = compounds(part.slice(lead.length))
      /* a compound that was nothing but state still names an element when
         it stands next to a combinator: `> :hover` reads `> *` */
      const alone = items.length === 1 && !lead.trim()
      const body = items
        .map(
          (item, i) =>
            `${i ? (joins[i - 1] === ' ' ? ' ' : ` ${joins[i - 1]} `) : ''}${stripStates(item) || (alone ? '' : '*')}`,
        )
        .join('')
      return `${lead.trim() ? `${lead.trim()} ` : ''}${body}`
    })
    .join(', ')
}

function stripStates(compound: string): string {
  let out = compound
  for (const pseudo of pseudoClasses(compound)) {
    const m = /^:(not|is|where|has)\((.*)\)$/s.exec(pseudo)
    let replacement = pseudo
    if (m) {
      const [, name, inner] = m
      const args = splitSelectors(inner!)
      if (name === 'not') {
        const rest = args.filter((arg) => !STATE.test(arg))
        replacement = rest.length ? `:not(${rest.join(', ')})` : ''
      } else {
        const stripped = args.map((arg) => withoutStates(arg).trim())
        if (name !== 'has' && stripped.some((arg) => !arg)) replacement = ''
        else {
          const kept = stripped.filter(Boolean)
          replacement = kept.length ? `:${name}(${kept.join(', ')})` : ''
        }
      }
    } else if (STATE.test(pseudo)) replacement = ''
    if (replacement !== pseudo) out = out.replace(pseudo, replacement)
  }
  return out.replace(TRAILING_PSEUDO_ELEMENT, '')
}

/* which of `els` the selector matches, as indexes; states the parsed
   subtree cannot be in are tried without */
function matchIndexes(els: Element[], selector: string): Set<number> {
  /* the union over both readings: whatever the rule could reach in any
     state (a detached clone's root is also, by accident, a first child) */
  const hits = new Set<number>()
  for (const candidate of [selector, withoutStates(selector)]) {
    const sel = candidate.trim()
    if (!sel) continue
    try {
      els.forEach((el, i) => {
        if (el.matches(sel)) hits.add(i)
      })
    } catch {
      /* a selector the engine cannot parse styles nothing here */
    }
  }
  return hits
}

function matchesAny(els: Element[], selector: string): boolean {
  return matchIndexes(els, selector).size > 0
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && [...a].every((i) => b.has(i))
}

/* `[mark] > :nth-child(a) > :nth-child(b)`: the element at `index` of the
   subtree's element list, named by its place under the moved root */
function pathSelector(els: Element[], index: number, scope: string): string {
  const steps: string[] = []
  for (let el = els[index]!; el !== els[0]; el = el.parentElement!) {
    const parent = el.parentElement!
    steps.unshift(`:nth-child(${[...parent.children].indexOf(el) + 1})`)
  }
  return [`[${SCOPE_ATTR}="${scope}"]`, ...steps].join(' > ')
}

/* the pseudo-classes of one compound, at its top level and whole:
   `.card:not(:hover):nth-child(2)` gives `:not(:hover)` and `:nth-child(2)`,
   never the `:hover` inside the `:not()`; pseudo-elements are left out */
function pseudoClasses(compound: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < compound.length; i++) {
    const ch = compound[i]!
    /* an escaped character is part of a name (`.sm\:block`), never syntax */
    if (ch === '\\') {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ':' && depth === 0) {
      const element = compound[i + 1] === ':'
      let j = i + (element ? 2 : 1)
      while (j < compound.length && /[\w-]/.test(compound[j]!)) j++
      if (compound[j] === '(') {
        let d = 0
        let q: string | null = null
        do {
          const c = compound[j]!
          if (c === '\\') j++
          else if (q) {
            if (c === q) q = null
          } else if (c === '"' || c === "'") q = c
          else if (c === '(') d++
          else if (c === ')') d--
          j++
        } while (j < compound.length && d > 0)
      }
      if (!element) out.push(compound.slice(i, j))
      i = j - 1
    }
  }
  return out
}

/* a pseudo-class about where an element sits among its siblings: settled
   for the moved root in its source, and not something its new place can
   be asked again */
const POSITIONAL = /^:(nth-|first-|last-|only-)/

/* The pseudo-class with the root's old sibling position resolved out of
   it, as it stood in the source. A bare positional check held, so it goes.
   Inside `:not(…)` the positional arguments were false, so they go and the
   rest stays (`:not(:first-child, :hover)` becomes `:not(:hover)`). Inside
   `:is(…)` / `:where(…)` a positional argument the root matched satisfied
   the whole condition, so it all goes; otherwise only those arguments do. */
function resolvePositional(pseudo: string, root: Element): string {
  if (POSITIONAL.test(pseudo)) return ''
  const m = /^:(not|is|where)\((.*)\)$/s.exec(pseudo)
  if (!m) return pseudo
  const [, name, inner] = m
  const args = splitSelectors(inner!)
  const rest = args.filter((arg) => !POSITIONAL.test(arg))
  if (name !== 'not') {
    const satisfied = args.some((arg) => {
      if (!POSITIONAL.test(arg)) return false
      try {
        return root.matches(arg)
      } catch {
        return false
      }
    })
    if (satisfied || !rest.length) return ''
  }
  return rest.length ? `:${name}(${rest.join(', ')})` : ''
}

/* a selector scoped by an earlier move: the wrapper comes off before the
   rule is judged and scoped again, or the new wrapper would demand both marks */
const SCOPED =
  /^:is\(\[data-doop-carried-scope="[^"]*"\], \[data-doop-carried-scope="[^"]*"\] \*\):is\((.*)\)((?:::?[\w-]+(?:\([^)]*\))?)?)$/
/* the root block of an earlier move's custom properties */
const SCOPE_MARK = /^\[data-doop-carried-scope="[^"]*"\]$/

/* the selector's parts with an earlier move's wrapper taken off — only
   where that move's mark is on the subtree or above it; a part scoped to
   some other layer in the frame is not this layer's rule and is dropped */
function unscope(selector: string, marks: Set<string>): string[] {
  const parts: string[] = []
  for (const part of splitSelectors(selector)) {
    const m = SCOPED.exec(part)
    if (!m) parts.push(part)
    else if (marks.has(/data-doop-carried-scope="([^"]*)"/.exec(part)?.[1] ?? '')) parts.push(`${m[1]}${m[2]}`)
  }
  return parts
}

/* (ids, classes and the like, types) of one compound selector; a functional
   pseudo-class counts as one class, close to the spec's "most specific
   argument" for the simple arguments seen here */
type Specificity = [number, number, number]

const add = (a: Specificity, b: Specificity): Specificity => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const higher = (a: Specificity, b: Specificity): Specificity =>
  a[0] !== b[0] ? (a[0] > b[0] ? a : b) : a[1] !== b[1] ? (a[1] > b[1] ? a : b) : a[2] >= b[2] ? a : b

/* a selector list's specificity: that of its most specific selector */
function listSpecificity(list: string): Specificity {
  return splitSelectors(list)
    .map((part) => compounds(part).items.reduce<Specificity>((sum, item) => add(sum, specificity(item)), [0, 0, 0]))
    .reduce<Specificity>(higher, [0, 0, 0])
}

/* one compound's specificity, as the cascade counts it: `:is()`, `:not()`
   and `:has()` weigh as their most specific argument, `:where()` weighs
   nothing, `:nth-child(… of S)` adds S's weight to its own */
function specificity(compound: string): Specificity {
  let total: Specificity = [0, 0, 0]
  let rest = compound
  for (const pseudo of pseudoClasses(compound)) {
    rest = rest.replace(pseudo, '')
    const m = /^:(not|is|has|where|nth-child|nth-last-child)\((.*)\)$/s.exec(pseudo)
    if (!m) {
      total = add(total, [0, 1, 0])
      continue
    }
    const [, name, inner] = m
    if (name === 'where') continue
    if (name === 'nth-child' || name === 'nth-last-child') {
      total = add(total, [0, 1, 0])
      const of = /\sof\s+(.*)$/s.exec(inner!)
      if (of) total = add(total, listSpecificity(of[1]!))
      continue
    }
    total = add(total, listSpecificity(inner!))
  }
  /* an escaped character is part of a name: `.sm\:block` is one class */
  const bare = rest.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, '[]')
  const ids = (bare.match(/#[\w-]+/g) ?? []).length
  const classes = (bare.match(/\.[\w-]+/g) ?? []).length + (bare.match(/\[\]/g) ?? []).length
  const types = (bare.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length + (bare.match(/::[\w-]+/g) ?? []).length
  return add(total, [ids, classes, types])
}

/* inert steps that add the given specificity: nothing has an id, class or
   tag of these names, and :not() of a selector that matches nothing matches
   everything */
function padding([ids, classes, types]: [number, number, number]): string {
  return ':not(#\\0)'.repeat(ids) + ':not(.\\0)'.repeat(classes) + ':not(doop-nil)'.repeat(types)
}

/* a complex selector's compounds and the combinators between them, split
   at the top level only */
function compounds(part: string): { items: string[]; joins: string[] } {
  const items: string[] = []
  const joins: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < part.length; i++) {
    const ch = part[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (depth === 0 && /[\s>+~]/.test(ch)) {
      let j = i
      while (j < part.length && /[\s>+~]/.test(part[j]!)) j++
      const join = part.slice(i, j).trim() || ' '
      if (i > start) {
        items.push(part.slice(start, i))
        joins.push(join)
      }
      start = j
      i = j - 1
    }
  }
  items.push(part.slice(start))
  return { items, joins }
}

/* The selector with the ancestors the subtree leaves behind cut off:
   `.wrapper .card` still styled `.card` in the source through a wrapper that
   is not coming along, so the rule becomes `.card`, the longest suffix the
   subtree matches on its own (a clone of it, detached, stands in for the
   destination) — provided it matches the same elements the rule matched in
   the source. Where a suffix would reach more (an outer `.card` holding
   another), the matched elements are named by their place under the moved
   root instead. A selector the subtree matches whole stays whole, and a
   cut-down one keeps the weight of what was cut. */
function localize(part: string, els: Element[], localEls: Element[], scope: string): string {
  const matched = matchIndexes(els, part)
  const pseudo = TRAILING_PSEUDO_ELEMENT.exec(part)?.[1] ?? ''
  /* the pseudo-element rides along at the end and carries its own weight */
  const { items, joins } = compounds(pseudo ? part.slice(0, -pseudo.length) : part)
  for (let k = 0; k < items.length; k++) {
    const suffix = items
      .slice(k)
      .map((item, i) => (i === 0 ? item : `${joins[k + i - 1] === ' ' ? ' ' : ` ${joins[k + i - 1]} `}${item}`))
      .join('')
    const local = matchIndexes(localEls, `${suffix}${pseudo}`)
    if (!local.size) continue
    if (k === 0) return part
    if (!sameSet(local, matched)) break
    /* a condition on what is cut off (`.wrapper:hover > .card`) cannot be
       asked in the destination, where that ancestor is not: the rule is
       left behind rather than carried as always-on */
    if (items.slice(0, k).some(stateful)) return ''
    /* the compounds cut off carried weight in the cascade: `.wrapper .card`
       beat a later `.card`, and still has to once it is `.card` itself */
    const lost = items.slice(0, k).reduce<[number, number, number]>(
      (sum, item) => {
        const [a, b, c] = specificity(item)
        return [sum[0] + a, sum[1] + b, sum[2] + c]
      },
      [0, 0, 0],
    )
    return `${suffix}${padding(lost)}${pseudo}`
  }
  if (!matched.size) return part
  /* the first compound that lands inside the subtree (on the root or
     below it): everything before it is an ancestor left behind, and a
     condition on one of those cannot be asked in the destination */
  let inside = items.length - 1
  for (let j = 0; j < items.length; j++) {
    const prefix = items
      .slice(0, j + 1)
      .map((item, i) => (i === 0 ? item : `${joins[i - 1] === ' ' ? ' ' : ` ${joins[i - 1]} `}${item}`))
      .join('')
    if (matchesAny(els, prefix)) {
      inside = j
      break
    }
  }
  if (items.slice(0, inside).some(stateful)) return ''
  const lost = items.slice(0, inside).reduce<[number, number, number]>(
    (sum, item) => {
      const [a, b, c] = specificity(item)
      return [sum[0] + a, sum[1] + b, sum[2] + c]
    },
    [0, 0, 0],
  )
  /* the compounds inside the subtree stay, their states with them (a
     hovered root above a nested title); the subject is then pinned to each
     element it matched by its place under the root, through a `:where()`
     that weighs nothing, and the padding restores the ancestors' weight */
  const kept = items.slice(inside)
  /* the first kept compound may sit on the root itself (a descendant is
     the subject): its old sibling position goes the same way */
  const firstOnRoot =
    kept.length > 1 &&
    matchesAny(
      [els[0]!],
      items
        .slice(0, inside + 1)
        .map((item, i) => (i === 0 ? item : `${joins[i - 1] === ' ' ? ' ' : ` ${joins[i - 1]} `}${item}`))
        .join(''),
    )
  const first = firstOnRoot ? resolveOnRoot(kept[0]!, els[0]!) : { text: kept[0] ?? '', lost: [0, 0, 0] as Specificity }
  const head = kept
    .slice(0, -1)
    .map(
      (item, i) =>
        `${i === 0 && firstOnRoot ? first.text : item}${joins[inside + i] === ' ' ? ' ' : ` ${joins[inside + i]} `}`,
    )
    .join('')
  const subject = kept[kept.length - 1] ?? ''
  return [...matched]
    .map((i) => {
      /* the root's place among its old siblings is gone; what is inside the
         subtree keeps its structure, so a descendant keeps every check */
      const own =
        i === 0 && kept.length === 1
          ? resolveOnRoot(subject, els[0]!)
          : { text: subject, lost: [0, 0, 0] as Specificity }
      const pad = padding(add(add(lost, first.lost), own.lost))
      return `${head}${own.text}:where(${pathSelector(localEls, i, scope)})${pad}${pseudo}`
    })
    .join(', ')
}

/* the compound with the root's old sibling position resolved out of its
   pseudo-classes, and the weight that went with it, to be restored */
function resolveOnRoot(compound: string, root: Element): { text: string; lost: Specificity } {
  const all = pseudoClasses(compound)
  const base = all.reduce((rest, p) => rest.replace(p, ''), compound)
  const states = all.map((p) => resolvePositional(p, root)).join('')
  /* what is left of the checks weighs nothing (`:where()`), and the checks'
     whole original weight is restored, so the rule's priority is exactly
     what it was however the resolution changed their shape */
  return { text: `${base}${states ? `:where(${states})` : ''}`, lost: specificity(all.join('')) }
}

/* a compound that asks for a state (`:hover`, `:focus-within`, `:checked`) */
function stateful(compound: string): boolean {
  return pseudoClasses(compound).some((p) => STATE.test(p))
}

/* the selector, limited to the moved root and what is inside it */
function scopeSelector(selector: string, scope: string): string {
  const mark = `[${SCOPE_ATTR}="${scope}"]`
  return splitSelectors(selector)
    .map((part) => {
      const pseudo = TRAILING_PSEUDO_ELEMENT.exec(part)?.[1] ?? ''
      const base = pseudo ? part.slice(0, -pseudo.length) : part
      return `:is(${mark}, ${mark} *):is(${base})${pseudo}`
    })
    .join(', ')
}

function fontNames(value: string): string[] {
  return value
    .split(',')
    .map((f) =>
      f
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase(),
    )
    .filter((f) => f && !GENERIC_FONTS.has(f) && !/^(normal|bold|italic|oblique|\d)/.test(f))
}

/* every value of `property` in the declarations, in order */
function declarations(cssText: string, property: string): string[] {
  const re = new RegExp(`(?:^|[;{\\s])${property.replace(/-/g, '\\-')}\\s*:\\s*([^;}]+)`, 'gi')
  return [...cssText.matchAll(re)].map((m) => m[1]!.trim())
}

function block(cssText: string): string {
  const open = cssText.indexOf('{')
  const close = cssText.lastIndexOf('}')
  return open >= 0 && close > open ? cssText.slice(open + 1, close).trim() : ''
}

function head(cssText: string): string {
  const open = cssText.indexOf('{')
  return (open >= 0 ? cssText.slice(0, open) : cssText).trim()
}

/* text inside its enclosing group rules, innermost last */
function wrap(wrappers: string[], text: string): string {
  return wrappers.reduceRight((inner, outer) => `${outer} {\n${inner}\n}`, text)
}

type Uses = {
  fonts: Set<string>
  animations: Set<string>
  vars: Set<string>
  /* custom properties read where a font family or an animation name goes:
     their values name fonts and animations too, once resolved */
  fontVars: Set<string>
  animationVars: Set<string>
}

const VAR = /var\(\s*(--[\w-]+)/g

/* fonts, animations and custom properties the declarations read, the
   shorthands included: `font: 16px/1.4 Inter, serif` names Inter after its
   size, `animation: 1s ease pop` names pop among its keywords */
function noteUses(uses: Uses, cssText: string) {
  const fontValues = [
    ...declarations(cssText, 'font-family'),
    ...declarations(cssText, 'font').map(
      (font) => /(?:^|\s)[\d.]+[a-z%]*(?:\s*\/\s*[\w.%-]+)?\s+(.+)$/i.exec(font)?.[1] ?? '',
    ),
  ]
  for (const value of fontValues) {
    for (const f of fontNames(value)) uses.fonts.add(f)
    for (const m of value.matchAll(VAR)) uses.fontVars.add(m[1]!)
  }
  const animationValues = [...declarations(cssText, 'animation-name'), ...declarations(cssText, 'animation')]
  for (const value of animationValues) {
    for (const n of animationNames(value)) uses.animations.add(n)
    for (const m of value.matchAll(VAR)) uses.animationVars.add(m[1]!)
  }
  for (const m of cssText.matchAll(VAR)) uses.vars.add(m[1]!)
}

function animationNames(value: string): string[] {
  return value.split(',').flatMap((part) =>
    part
      .trim()
      .split(/\s+/)
      .filter((t) => t && !ANIMATION_KEYWORD.test(t) && !t.startsWith('var(')),
  )
}

type Deferred = {
  keyframes: { rule: CSSRule; wrappers: string[] }[]
  fonts: { rule: CSSRule; wrappers: string[] }[]
  /* declaration blocks that may define custom properties the subtree
     inherits: root rules, `*` resets and rules matching an ancestor */
  roots: { body: string; wrappers: string[]; rank: number }[]
}

/* A nested style rule read flat: `&` stands for the parent, a child with no
   `&` is a descendant of it; a parent that is a list reads as `:is(list)`. */
function nestedSelector(parent: string, child: string): string {
  const base = splitSelectors(parent).length > 1 ? `:is(${parent})` : parent
  return splitSelectors(child)
    .map((part) => (part.includes('&') ? part.replace(/&/g, base) : `${base} ${part}`))
    .join(', ')
}

/* a style rule's own declarations, without any rule nested inside it */
function ownDeclarations(rule: CSSRule): string {
  const style = (rule as { style?: { cssText?: string } }).style
  return typeof style?.cssText === 'string' && style.cssText ? style.cssText : block(rule.cssText)
}

/** The rules the subtree needs, scoped, in order, as CSS text; groups
 *  (@media, @supports, @layer, @container) stay around their kept children.
 *  @keyframes, @font-face and custom-property sources are collected with
 *  their groups for a second pass. */
function keepRules(
  rules: CSSRuleList,
  els: Element[],
  localEls: Element[],
  ancestors: Element[],
  marks: Set<string>,
  scope: string,
  uses: Uses,
  deferred: Deferred,
  wrappers: string[],
  parent?: string,
): string[] {
  const out: string[] = []
  const rootMark = els[0]?.getAttribute(SCOPE_ATTR)
  for (const rule of [...rules]) {
    const text = rule.cssText
    if (text.startsWith('@font-face')) deferred.fonts.push({ rule, wrappers })
    else if (/^@(-webkit-)?keyframes/.test(text)) deferred.keyframes.push({ rule, wrappers })
    else if ('selectorText' in rule && typeof rule.selectorText === 'string') {
      const selectorText = parent ? nestedSelector(parent, rule.selectorText) : rule.selectorText
      const selectors = unscope(selectorText, marks)
      const body = ownDeclarations(rule)
      /* root rules, `*` resets, an earlier move's own root block (where its
         mark is this layer's or above it) and the moved root's ancestors
         are where the custom properties it inherits live; they are not
         carried whole (that would restyle the destination), only the
         properties read. The nearest source of a property wins, as it did
         in the source: the root's own `*` first, then each ancestor by
         distance, the document's root rules last */
      const global = selectors.filter(
        (s) => /^(:root|html|body|\*)$/i.test(s) || (SCOPE_MARK.test(s) && marks.has(/"([^"]*)"/.exec(s)?.[1] ?? '')),
      )
      const own = selectors.filter((s) => !global.includes(s))
      const nearest = own.length ? ancestors.findIndex((el) => matchesAny([el], own.join(', '))) : -1
      if (global.length || nearest >= 0) {
        const rank = global.some((s) => s === '*' || SCOPE_MARK.test(s))
          ? -1
          : nearest >= 0
            ? nearest
            : ancestors.length + 1
        deferred.roots.push({ body, wrappers, rank })
      }
      const matching = own.filter((part) => matchesAny(els, part))
      if (matching.length) {
        const local = matching
          .map((part) => localize(part, els, localEls, scope))
          .filter(Boolean)
          /* a rule an earlier move pinned to the root's mark is pinned to
             the new one, which replaces it; marks deeper in the subtree stay */
          .map((part) =>
            rootMark ? part.split(`[${SCOPE_ATTR}="${rootMark}"]`).join(`[${SCOPE_ATTR}="${scope}"]`) : part,
          )
          .join(', ')
        if (local) {
          out.push(`${scopeSelector(local, scope)} { ${body} }`)
          noteUses(uses, `{${body}}`)
        }
      }
      /* rules nested inside this one read with it as their parent */
      const nested = (rule as { cssRules?: CSSRuleList }).cssRules
      if (nested && nested.length)
        out.push(...keepRules(nested, els, localEls, ancestors, marks, scope, uses, deferred, wrappers, selectorText))
    } else if ('cssRules' in rule && rule.cssRules && typeof rule.cssRules === 'object') {
      const inner = keepRules(
        rule.cssRules as CSSRuleList,
        els,
        localEls,
        ancestors,
        marks,
        scope,
        uses,
        deferred,
        [...wrappers, head(text)],
        parent,
      )
      if (inner.length) out.push(`${head(text)} {\n${inner.join('\n')}\n}`)
    }
  }
  return out
}

/** `outerHtml` with the scope mark on each of its top-level elements, so
 *  the carried sheet for `scope` applies to them and nothing else. */
export function scopeMarkup(outerHtml: string, scope: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = outerHtml
  for (const el of tpl.content.children) el.setAttribute(SCOPE_ATTR, scope)
  return tpl.innerHTML
}

/** The carried sheet with every `#id` selector and `url(#id)` reference
 *  following the ids the destination renamed on insertion. A `#abc` inside
 *  a declaration is a colour, not an id, and stays. */
export function renameInCss(css: string, renamed: Record<string, string> | undefined): string {
  if (!renamed || !Object.keys(renamed).length) return css
  const rename = (id: string) => renamed[id] ?? id
  /* text up to a `{` is a selector or prelude, text up to a `}` or `;` is a
     declaration: ids are renamed in the former, only url(#…) in the latter */
  return css.replace(/[^{};]*([{};]|$)/g, (chunk, end: string) =>
    end === '{'
      ? chunk.replace(/#([\w-]+)/g, (_, id: string) => `#${rename(id)}`)
      : chunk.replace(
          /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g,
          (_, q: string, id: string) => `url(${q}#${rename(id)}${q})`,
        ),
  )
}

/** The CSS a subtree of `sourceHtml` relies on, scoped to `scope`; empty
 *  when the frame's own sheets style nothing in it. */
export function carriedCss(sourceHtml: string, selector: string, scope: string): string {
  const doc = parse(sourceHtml)
  let root: Element | null
  try {
    root = doc.querySelector(selector)
  } catch {
    root = null
  }
  if (!root || typeof CSSStyleSheet === 'undefined' || !('replaceSync' in CSSStyleSheet.prototype)) return ''
  const els = [root, ...root.querySelectorAll('*')]
  /* the subtree on its own, as the destination will hold it */
  const detached = document.createElement('template')
  detached.content.append(root.cloneNode(true))
  const localRoot = detached.content.firstElementChild!
  const localEls = [localRoot, ...localRoot.querySelectorAll('*')]
  const ancestors: Element[] = []
  for (let el = root.parentElement; el && el !== doc.documentElement; el = el.parentElement) ancestors.push(el)
  /* the marks of earlier moves this subtree is under: their rules are its */
  const marks = new Set([...els, ...ancestors].map((el) => el.getAttribute(SCOPE_ATTR)).filter((m): m is string => !!m))
  const uses: Uses = {
    fonts: new Set(),
    animations: new Set(),
    vars: new Set(),
    fontVars: new Set(),
    animationVars: new Set(),
  }
  /* inline styles read fonts, animations and variables too */
  for (const el of els) {
    const inline = el.getAttribute('style')
    if (inline) noteUses(uses, `{${inline}}`)
  }
  const deferred: Deferred = { keyframes: [], fonts: [], roots: [] }
  const out: string[] = []
  /* every sheet of the frame, sheets carried in earlier included (they are
     scoped again for this subtree); one inside the subtree travels with the
     markup already */
  for (const style of doc.querySelectorAll('style')) {
    if (root.contains(style)) continue
    const sheet = new CSSStyleSheet()
    try {
      sheet.replaceSync(style.textContent ?? '')
    } catch {
      continue
    }
    out.push(...keepRules(sheet.cssRules, els, localEls, ancestors, marks, scope, uses, deferred, []))
  }
  /* custom properties: what the kept rules and inline styles read, plus
     what those values read in turn; every definition is kept in its own
     group (a dark-mode @media keeps its override), on the moved root */
  const defined = new Map<string, { value: string; wrappers: string[] }[]>()
  /* farthest source first, nearest last, so the nearest wins as it did */
  const sources = deferred.roots.map((root, order) => ({ ...root, order }))
  sources.sort((a, b) => b.rank - a.rank || a.order - b.order)
  for (const { body, wrappers } of sources)
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      const list = defined.get(m[1]!) ?? []
      list.push({ value: m[2]!.trim(), wrappers })
      defined.set(m[1]!, list)
    }
  const vars = new Map<string, { value: string; wrappers: string[] }[]>()
  const queue = [...uses.vars]
  while (queue.length) {
    const name = queue.pop()!
    if (vars.has(name)) continue
    const definitions = defined.get(name)
    if (!definitions) continue
    vars.set(name, definitions)
    for (const { value } of definitions) {
      for (const m of value.matchAll(VAR)) {
        queue.push(m[1]!)
        /* a property read where a font or animation goes passes that on */
        if (uses.fontVars.has(name)) uses.fontVars.add(m[1]!)
        if (uses.animationVars.has(name)) uses.animationVars.add(m[1]!)
      }
      noteUses(uses, `{x:${value}}`)
      if (uses.fontVars.has(name)) for (const f of fontNames(value)) uses.fonts.add(f)
      if (uses.animationVars.has(name)) for (const n of animationNames(value)) uses.animations.add(n)
    }
  }
  const byGroup = new Map<string, { wrappers: string[]; lines: string[] }>()
  for (const [name, definitions] of vars)
    for (const { value, wrappers } of definitions) {
      const key = wrappers.join('|')
      const group = byGroup.get(key) ?? { wrappers, lines: [] }
      group.lines.push(`  ${name}: ${value};`)
      byGroup.set(key, group)
    }
  const varBlocks = [...byGroup.values()].map(({ wrappers, lines }) =>
    wrap(wrappers, `[${SCOPE_ATTR}="${scope}"] {\n${lines.join('\n')}\n}`),
  )
  out.unshift(...varBlocks)
  for (const { rule, wrappers } of deferred.keyframes) {
    const name = 'name' in rule && typeof rule.name === 'string' ? rule.name : head(rule.cssText).split(/\s+/)[1]
    if (name && uses.animations.has(name)) out.push(wrap(wrappers, rule.cssText))
  }
  for (const { rule, wrappers } of deferred.fonts) {
    const [family] = declarations(rule.cssText, 'font-family')
    if (family && fontNames(family).some((f) => uses.fonts.has(f))) out.push(wrap(wrappers, rule.cssText))
  }
  return out.join('\n')
}

const KEYFRAMES = /@(-webkit-)?keyframes\s+([\w-]+)/g

/* `text` with the animation names in `renamed` replaced, inside animation
   declarations and @keyframes heads only */
function renameAnimations(text: string, renamed: Map<string, string>): string {
  const swap = (value: string) => value.replace(/[\w-]+/g, (token) => renamed.get(token) ?? token)
  return text
    .replace(KEYFRAMES, (hit, prefix: string, name: string) =>
      renamed.has(name) ? `@${prefix ?? ''}keyframes ${renamed.get(name)}` : hit,
    )
    .replace(/(animation(?:-name)?\s*:\s*)([^;}]*)/g, (_, head: string, value: string) => `${head}${swap(value)}`)
}

/* the families the @font-face rules of `css` define */
function fontFaceFamilies(css: string): string[] {
  const out: string[] = []
  for (const face of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
    const m = /font-family\s*:\s*(["']?)([^;"']+)\1/i.exec(face[0])
    if (m) out.push(m[2]!.trim())
  }
  return out
}

/* `text` with the families in `renamed` replaced wherever a family is
   named: @font-face heads, font-family and font declarations */
/* the custom properties a text reads where a font family goes, chains
   (`--type: var(--brand-type)`) followed */
function fontVariables(text: string): Set<string> {
  const vars = new Set<string>()
  for (const m of text.matchAll(/font(?:-family)?\s*:\s*([^;}]*)/gi))
    for (const v of m[1]!.matchAll(VAR)) vars.add(v[1]!)
  let grew = true
  while (grew) {
    grew = false
    for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;}]*)/g))
      if (vars.has(m[1]!))
        for (const v of m[2]!.matchAll(VAR))
          if (!vars.has(v[1]!)) {
            vars.add(v[1]!)
            grew = true
          }
  }
  return vars
}

function renameFamilies(text: string, renamed: Map<string, string>, fontVars: Set<string>): string {
  const lower = new Map([...renamed].map(([k, v]) => [k.toLowerCase(), v]))
  const swapList = (value: string) =>
    value
      .split(',')
      .map((item) => {
        const bare = item.trim().replace(/^["']|["']$/g, '')
        const next = lower.get(bare.toLowerCase())
        return next ? item.replace(bare, next) : item
      })
      .join(',')
  return (
    text
      .replace(/(font-family\s*:\s*)([^;}]*)/gi, (_, head: string, value: string) => `${head}${swapList(value)}`)
      /* a family kept in a custom property a font reads (`--type: Inter`)
         is renamed there too; one that names something else is not */
      .replace(/((--[\w-]+)\s*:\s*)([^;}]*)/g, (hit, head: string, name: string, value: string) =>
        fontVars.has(name) ? `${head}${swapList(value)}` : hit,
      )
      .replace(/(\bfont\s*:\s*)([^;}]*)/gi, (_, head: string, value: string) => {
        const m = /^(.*?[\d.]+[a-z%]*(?:\s*\/\s*[\w.%-]+)?\s+)(.+)$/i.exec(value)
        return m ? `${head}${m[1]}${swapList(m[2]!)}` : `${head}${value}`
      })
  )
}

/** `destHtml` with `css` in its head as a carried sheet; unchanged when
 *  empty or when the same sheet is already there. A carried @keyframes or
 *  @font-face whose name the destination already defines is renamed, in
 *  the sheet and in the inline styles of the markup under `scopes`, so the
 *  destination's own animations and fonts keep their meaning. One sheet
 *  serves every scope given. */
export function withCarriedCss(destHtml: string, css: string, scopes?: string | string[]): string {
  if (!css.trim()) return destHtml
  const doc = parse(destHtml)
  for (const style of doc.querySelectorAll(`style[${CARRIED_ATTR}]`)) if (style.textContent === css) return destHtml
  const marks = scopes === undefined ? [] : Array.isArray(scopes) ? scopes : [scopes]
  const suffix = marks[0] ?? 'carried'
  const existing = [...doc.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n')
  const fresh = (name: string, taken: Set<string>) => {
    let next = `${name}-${suffix}`
    for (let n = 2; taken.has(next); n++) next = `${name}-${suffix}-${n}`
    taken.add(next)
    return next
  }
  const animations = new Set([...existing.matchAll(KEYFRAMES)].map((m) => m[2]!))
  const renamedAnimations = new Map<string, string>()
  for (const m of css.matchAll(KEYFRAMES)) {
    const name = m[2]!
    if (animations.has(name) && !renamedAnimations.has(name)) renamedAnimations.set(name, fresh(name, animations))
  }
  const families = new Set(fontFaceFamilies(existing).map((f) => f.toLowerCase()))
  const renamedFamilies = new Map<string, string>()
  for (const family of fontFaceFamilies(css))
    if (families.has(family.toLowerCase()) && !renamedFamilies.has(family))
      renamedFamilies.set(family, fresh(family, families))
  let sheet = css
  if (renamedAnimations.size) sheet = renameAnimations(sheet, renamedAnimations)
  const inlineStyles = marks
    .flatMap((mark) => [...doc.querySelectorAll(`[${SCOPE_ATTR}="${mark}"] [style], [${SCOPE_ATTR}="${mark}"][style]`)])
    .map((el) => `{${el.getAttribute('style') ?? ''}}`)
    .join('\n')
  const fontVars = fontVariables(`${css}\n${inlineStyles}`)
  if (renamedFamilies.size) sheet = renameFamilies(sheet, renamedFamilies, fontVars)
  if (renamedAnimations.size || renamedFamilies.size)
    for (const mark of marks)
      /* every root wearing a scope: a paste of several layers marks each */
      for (const root of doc.querySelectorAll(`[${SCOPE_ATTR}="${mark}"]`))
        for (const el of [root, ...root.querySelectorAll('[style]')]) {
          const inline = el.getAttribute('style')
          if (!inline || !/animation|font/.test(inline)) continue
          let next = `{${inline}}`
          if (renamedAnimations.size) next = renameAnimations(next, renamedAnimations)
          if (renamedFamilies.size) next = renameFamilies(next, renamedFamilies, fontVars)
          el.setAttribute('style', next.slice(1, -1))
        }
  const style = doc.createElement('style')
  style.setAttribute(CARRIED_ATTR, '')
  style.textContent = sheet
  doc.head.append(style)
  return serialize(doc)
}
