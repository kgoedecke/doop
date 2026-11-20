import { createHash } from 'node:crypto'
import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import type { ComponentCode, ComponentProp } from './components.ts'
import type { DesignTokenInput } from './designTokens.ts'
import type { ComponentCapture, CapturedProp } from './storybookAcquire.ts'
import type { StoryCapture } from './storybookCapture.ts'

/**
 * Captures of a Storybook component made into what Doop's component and token tools take.
 * Pure: no store, no browser. Spec: .context/specs/storybook-import.md, "Building a component".
 */

export interface KitComponent {
  title: string
  name: string
  description: string
  code?: ComponentCode
  props: ComponentProp[]
  html: string
  css: string
  width: number
  height: number
  /** what it was built to, for sync: unchanged means nothing to send */
  hash: string
  /** `@font-face` rules for the families it names */
  fontFaces: string[]
  notes: string[]
  screenshot?: string
}

export interface Kit {
  components: KitComponent[]
  tokens: DesignTokenInput[]
  /** components that could not be built, and why */
  skipped: { title: string; reason: string }[]
}

export const ROOT_CLASS = 'sb-root'
export const MAX_COMPONENT_CSS = 400_000
const DARK = '[data-doop-theme="dark"]'

/* ------------------------------------------------------------------ */
/* Markup                                                              */

type Element = Tree.Element
const isElement = (node: Tree.Node): node is Element => 'tagName' in node

function rootOf(html: string): Element {
  const fragment = parseFragment(html)
  const root = fragment.childNodes.find(isElement)
  if (!root) throw new Error('the story drew no element')
  return root
}

/** Every element, root first, in document order. */
function elementsOf(root: Element): Element[] {
  const out: Element[] = []
  const visit = (el: Element) => {
    out.push(el)
    for (const child of el.childNodes) if (isElement(child)) visit(child)
    if (el.tagName === 'template' && 'content' in el)
      for (const child of (el as Tree.Template).content.childNodes) if (isElement(child)) visit(child)
  }
  visit(root)
  return out
}

const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value
function setAttr(el: Element, name: string, value: string | undefined) {
  const at = el.attrs.findIndex((a) => a.name === name)
  if (value === undefined) {
    if (at >= 0) el.attrs.splice(at, 1)
  } else if (at >= 0) el.attrs[at]!.value = value
  else el.attrs.push({ name, value })
}
const classesOf = (el: Element) => (attr(el, 'class') ?? '').split(/\s+/).filter(Boolean)
const setClasses = (el: Element, classes: string[]) =>
  setAttr(el, 'class', classes.length ? classes.join(' ') : undefined)
const shapeOf = (els: Element[]) =>
  JSON.stringify(
    els.map((el) => [
      el.tagName,
      el.childNodes.map((child) => child.nodeName),
      el.attrs
        .filter((a) => a.name !== 'class')
        .map((a) => [a.name, a.value])
        .sort(),
      el.childNodes.filter((child): child is Tree.TextNode => child.nodeName === '#text').map((child) => child.value),
    ]),
  )

/* ------------------------------------------------------------------ */
/* CSS text                                                            */

/** CSSOM's serialization of a class name (`hover:bg-x` → `hover\:bg-x`, a leading digit as `\32 `). */
export function cssEscape(ident: string): string {
  let out = ''
  for (let i = 0; i < ident.length; i++) {
    const char = ident[i]!
    const code = char.charCodeAt(0)
    if (code === 0) out += '�'
    else if (
      (code >= 1 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && /[0-9]/.test(char)) ||
      (i === 1 && /[0-9]/.test(char) && ident[0] === '-')
    )
      out += `\\${code.toString(16)} `
    else if (i === 0 && char === '-' && ident.length === 1) out += '\\-'
    else if (/[A-Za-z0-9_-]/.test(char) || code >= 0x80) out += char
    else out += `\\${char}`
  }
  return out
}

const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** `.name` as a whole class in selector text, not the start of a longer one. */
const classPattern = (name: string) =>
  new RegExp(`\\.${regexEscape(cssEscape(name))}(?![\\w\\u0080-\\uffff-]|\\\\)`, 'g')

/** Top-level blocks of a stylesheet text, escapes and strings respected. */
export function topLevelRules(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') i++
    else if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      out.push(text.slice(start, i + 1).trim())
      start = i + 1
    }
  }
  return out.filter(Boolean)
}

/** The first `{` outside strings and escapes. */
function openBrace(text: string): number {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') i++
    else if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '{') return i
  }
  return -1
}

interface Peeled {
  wrappers: string[]
  selector: string
  body: string
}

/** `@media x{@supports y{sel{body}}}` → its wrappers, selector and body; null for an at-rule
 *  that is not a style rule (keyframes, font-face). */
function peel(rule: string): Peeled | null {
  const wrappers: string[] = []
  let text = rule.trim()
  for (;;) {
    const open = openBrace(text)
    if (open < 0 || !text.endsWith('}')) return null
    const prelude = text.slice(0, open).trim()
    const inner = text.slice(open + 1, -1).trim()
    if (!prelude.startsWith('@')) return { wrappers, selector: prelude, body: inner }
    if (!/^@(media|supports|container|layer)\b/i.test(prelude)) return null
    const blocks = topLevelRules(inner)
    if (blocks.length !== 1) return null
    wrappers.push(prelude)
    text = blocks[0]!
  }
}

const wrap = ({ wrappers, selector, body }: Peeled) =>
  wrappers.reduceRight((inner, at) => `${at}{${inner}}`, `${selector} { ${body} }`)

/** A selector list split at its top-level commas. */
export function selectorList(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') i++
    else if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (char === ',' && depth === 0) {
      out.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(text.slice(start).trim())
  return out.filter(Boolean)
}

/* `.dark`, not `.dark\:bg-x` (Tailwind's escaped `dark:` class) nor `.dark-blue` */
const DARK_MARKER = String.raw`(?:\.dark|\.theme-dark|\[data-(?:theme|mode|color-scheme)=["']?dark["']?\])(?![\w\\-])`
const DARK_GROUP = new RegExp(
  String.raw`:(?:is|where)\((?:[^()]|\([^()]*\))*${DARK_MARKER}(?:[^()]|\([^()]*\))*\)`,
  'g',
)
const DARK_COMPOUND = new RegExp(String.raw`(^|[\s>+~])(?:html|:root|body)?${DARK_MARKER}\s*([>+~]\s*)?`, 'g')
const DARK_ANY = new RegExp(DARK_MARKER)

/** A selector conditioned on the app's dark switch, conditioned on Doop's instead:
 *  `.x:is(.dark *)`, `.dark .x`, `html.dark .x` → `[data-doop-theme="dark"] .x`. */
export function darkSelector(selector: string): string {
  if (!DARK_ANY.test(selector)) return selector
  let rest = selector.replace(DARK_GROUP, '').replace(DARK_COMPOUND, '$1')
  rest = rest.replace(new RegExp(DARK_MARKER, 'g'), '').replace(/\s+/g, ' ').trim()
  return rest ? `${DARK} ${rest}` : DARK
}

const JUNK =
  /scrollbar-color|::-webkit-search|-webkit-date|calendar-picker|spin-button|::-webkit-scrollbar|#storybook|\.sb-show|\.sb-main/

/** The captured rules as a component's stylesheet: one rule a block, desktop pointer, Doop's
 *  dark, Tailwind's defaults trimmed, duplicates out. */
export function cleanRules(rules: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (rule: string) => {
    if (!seen.has(rule)) {
      seen.add(rule)
      out.push(rule)
    }
  }
  for (const block of rules.flatMap(topLevelRules)) {
    if (JUNK.test(block)) continue
    let text = block
    /* the canvas is a desktop with a mouse: hover-only rules always, the touch layout never */
    if (
      /^@media\s*\(\s*(?:any-)?hover\s*:\s*none\s*\)\s*\{/i.test(text) ||
      /^@media\s*\(\s*(?:any-)?pointer\s*:\s*coarse\s*\)\s*\{/i.test(text)
    )
      continue
    while (
      /^@media\s*\(\s*(?:any-)?hover\s*:\s*hover\s*\)\s*\{/i.test(text) ||
      /^@media\s*\(\s*(?:any-)?pointer\s*:\s*fine\s*\)\s*\{/i.test(text)
    ) {
      const open = openBrace(text)
      text = text.slice(open + 1, text.lastIndexOf('}')).trim()
      if (topLevelRules(text).length !== 1) break
    }
    /* Tailwind's --tw-* defaults sit behind an @supports only some browsers pass: always here */
    if (/^@supports\s*\(\(-webkit-hyphens/.test(text) || /^@layer\s+properties\b/.test(text)) {
      const open = openBrace(text)
      for (const inner of topLevelRules(text.slice(open + 1, text.lastIndexOf('}')))) push(inner)
      continue
    }
    const peeled = peel(text)
    if (peeled) {
      const selectors = selectorList(peeled.selector).map(darkSelector)
      push(wrap({ ...peeled, selector: [...new Set(selectors)].join(', ') }))
    } else push(text)
  }
  /* Tailwind's universal --tw-* defaults: only the ones something reads */
  const used = new Set([...out.join('\n').matchAll(/var\(\s*(--tw-[\w-]+)/g)].map((match) => match[1]!))
  return out
    .map((rule) => {
      const peeled = peel(rule)
      if (!peeled || !/^\*\s*,|^\*$/.test(peeled.selector) || !/--tw-/.test(peeled.body)) return rule
      const declarations = peeled.body
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && (!d.startsWith('--tw-') || used.has(d.split(':')[0]!.trim())))
      return declarations.length ? wrap({ ...peeled, body: `${declarations.join('; ')};` }) : ''
    })
    .filter(Boolean)
}

/* ------------------------------------------------------------------ */
/* Variants                                                            */

interface Render {
  /** the value each prop shows in this render */
  shows: Record<string, string>
  elements: Element[]
  capture: StoryCapture
}

const attrSelector = (prop: string, values: string[]) =>
  values.length === 1
    ? `[data-${prop}="${values[0]!.replace(/"/g, '\\"')}"]`
    : `:is(${values.map((value) => `[data-${prop}="${value.replace(/"/g, '\\"')}"]`).join(', ')})`

/** For a class some renders have and others not, the prop whose values say where: present in
 *  exactly the renders showing some of its values. Fewest values first (an outline button's
 *  colours, not every size). */
function ownerOf(has: boolean[], renders: Render[], props: CapturedProp[]): { prop: string; values: string[] } | null {
  const fits: { prop: string; values: string[] }[] = []
  for (const prop of props) {
    const yes = new Set<string>()
    const no = new Set<string>()
    renders.forEach((render, i) => (has[i] ? yes : no).add(render.shows[prop.name]!))
    if (!yes.size || [...yes].some((value) => no.has(value))) continue
    fits.push({ prop: prop.name, values: [...yes] })
  }
  fits.sort((a, b) => a.values.length - b.values.length)
  return fits[0] ?? null
}

interface VariantPlan {
  /** class → the selectors it is rewritten to */
  owned: Map<string, string[]>
  /** classes still worn somewhere in the base markup, whose rules stay as they are too */
  stillWorn: Set<string>
  notes: string[]
}

function planVariants(baseRoot: Element, capture: ComponentCapture): VariantPlan {
  const defaults = Object.fromEntries(capture.props.map((prop) => [prop.name, prop.default]))
  const base: Render = { shows: defaults, elements: elementsOf(baseRoot), capture: capture.base }
  const notes: string[] = []
  const renders: Render[] = [base]
  for (const variant of capture.variants) {
    if (!variant.capture) {
      notes.push(`${variant.prop}=${variant.value} could not be rendered${variant.error ? `: ${variant.error}` : ''}`)
      continue
    }
    renders.push({
      shows: { ...defaults, [variant.prop]: variant.value },
      elements: elementsOf(rootOf(variant.capture.html)),
      capture: variant.capture,
    })
  }
  const baseShape = shapeOf(base.elements)
  const sameShape = renders.filter((render) => shapeOf(render.elements) === baseShape)
  for (const render of renders)
    if (render !== base && shapeOf(render.elements) !== baseShape) {
      const [prop, value] = Object.entries(render.shows).find(([name, shown]) => shown !== defaults[name]) ?? ['', '']
      notes.push(
        `${prop}=${value} changes the markup, not only classes: Doop variants are CSS, so only its root's classes were kept`,
      )
    }

  const owned = new Map<string, string[]>()
  const ownedAt = new Map<Element, Set<string>>()
  const own = (cls: string, selector: string, el: Element) => {
    owned.set(cls, [...new Set([...(owned.get(cls) ?? []), selector])])
    ownedAt.set(el, new Set([...(ownedAt.get(el) ?? []), cls]))
  }
  /* a descendant's marker is its class's, not its place's: a story drawing twelve tags marks
     each with the one marker of the class, so a rule reads one selector, not twelve */
  const markers = new Map<string, string>()
  const markerOf = (cls: string) => {
    if (!markers.has(cls)) markers.set(cls, `sb-v${markers.size + 1}`)
    return markers.get(cls)!
  }
  base.elements.forEach((el, index) => {
    /* the root in every render; a descendant only where the tree is the same */
    const group = index === 0 ? renders : sameShape
    if (group.length < 2) return
    const classSets = group.map((render) => new Set(classesOf(render.elements[index]!)))
    const all = new Set(classSets.flatMap((set) => [...set]))
    const marks = new Set<string>()
    for (const cls of all) {
      /* the import's own marks are not the story's */
      if (cls === ROOT_CLASS || /^sb-v\d+$/.test(cls)) continue
      const has = classSets.map((set) => set.has(cls))
      if (has.every(Boolean)) continue
      const owner = ownerOf(has, group, capture.props)
      if (!owner) {
        notes.push(`class “${cls}” follows no single prop, so it was left as the default render has it`)
        continue
      }
      if (index === 0) own(cls, `.${ROOT_CLASS}${attrSelector(owner.prop, owner.values)}`, el)
      else {
        const marker = markerOf(JSON.stringify([cls, owner.prop, owner.values]))
        marks.add(marker)
        own(cls, `.${marker}:is(.${ROOT_CLASS}${attrSelector(owner.prop, owner.values)} *)`, el)
      }
    }
    if (marks.size) setClasses(el, [...classesOf(el), ...marks])
  })
  /* owned classes leave the elements they were worked out on; one still worn elsewhere stays */
  for (const [el, classes] of ownedAt)
    setClasses(
      el,
      classesOf(el).filter((cls) => !classes.has(cls)),
    )
  const stillWorn = new Set(base.elements.flatMap(classesOf))
  return { owned, stillWorn, notes }
}

/* a rule naming several variant classes, each decided more than one way, multiplies: past this
   the rest are cut (a prop decided in many ways is rare; what is left still draws the defaults) */
const MAX_SELECTORS_A_RULE = 48

/** Rules naming an owned class, rewritten to the selectors it now goes by. */
function rewriteRules(rules: string[], plan: VariantPlan): string[] {
  if (!plan.owned.size) return rules
  const out: string[] = []
  for (const rule of rules) {
    const peeled = peel(rule)
    if (!peeled) {
      out.push(rule)
      continue
    }
    let selectors = selectorList(peeled.selector)
    for (const [cls, targets] of plan.owned) {
      const pattern = classPattern(cls)
      const next: string[] = []
      for (const selector of selectors) {
        if (!selector.match(pattern)) next.push(selector)
        else {
          if (plan.stillWorn.has(cls)) next.push(selector)
          for (const target of targets.slice(0, MAX_SELECTORS_A_RULE - next.length))
            next.push(selector.replace(pattern, () => target))
        }
        if (next.length >= MAX_SELECTORS_A_RULE) break
      }
      selectors = next
    }
    if (selectors.length > MAX_SELECTORS_A_RULE) selectors = selectors.slice(0, MAX_SELECTORS_A_RULE)
    out.push(wrap({ ...peeled, selector: [...new Set(selectors)].join(', ') }))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Text props                                                          */

function bindTexts(root: Element, texts: ComponentCapture['texts']): string[] {
  const bound: string[] = []
  const marks = new Map<Element, string[]>()
  for (const text of texts) {
    const wanted = text.value.trim()
    let found: Element | null = null
    for (const el of elementsOf(root).reverse()) {
      const node = el.childNodes.find(
        (child): child is Tree.TextNode =>
          child.nodeName === '#text' && (child as Tree.TextNode).value.trim() === wanted,
      )
      if (!node) continue
      if (
        el.childNodes.filter(
          (child) => isElement(child) || (child.nodeName === '#text' && (child as Tree.TextNode).value.trim()),
        ).length === 1
      )
        found = el
      else {
        const span = parseFragment('<span></span>').childNodes[0] as Element
        const at = el.childNodes.indexOf(node)
        span.parentNode = el
        node.parentNode = span
        span.childNodes = [node]
        el.childNodes.splice(at, 1, span)
        found = span
      }
      break
    }
    if (!found) continue
    marks.set(found, [...(marks.get(found) ?? []), text.name])
    bound.push(text.name)
  }
  for (const [el, names] of marks) setAttr(el, 'data-doop-prop', names.join(','))
  return bound
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */

const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^;{}]*\)|transparent)$/i
const LENGTH = /^-?(?:\d*\.)?\d+(?:px|rem|em)$|^0$/

export function tokenType(name: string, value: string): DesignTokenInput['type'] | null {
  if (name.startsWith('--tw-')) return null
  if (COLOR.test(value)) return 'color'
  if (/radius/i.test(name) && LENGTH.test(value)) return 'radius'
  if (/^--font(?!-(?:weight|size))/i.test(name) && /[,"']|^[a-z][\w -]*$/i.test(value) && !/^\d/.test(value))
    return 'fontFamily'
  return null
}

function capturedVars(capture: ComponentCapture) {
  const vars = { ...capture.base.vars }
  for (const variant of capture.variants)
    for (const [name, value] of Object.entries(variant.capture?.vars ?? {})) vars[name] ??= value
  return vars
}

function rootRule(capture: ComponentCapture, tokenNames: Set<string>): string {
  const own = Object.entries(capturedVars(capture)).filter(
    ([name]) => !tokenNames.has(name) && !name.startsWith('--tw-'),
  )
  const { 'font-family': family, ...otherText } = capture.base.text
  const text = Object.entries(otherText).filter(([, value]) => value)
  const declarations = [
    ...own.map(([name, value]) => `${name}: ${value}`),
    ...text.map(([name, value]) => `${name}: ${value}`),
  ]
  /* no specificity: it stands in for what the page and the browser gave the root, so any rule of
     the component's own (a variant's font size) wins over it, as it did in the story */
  let css = `:where(.${ROOT_CLASS}) { ${declarations.join('; ')}${declarations.length ? ';' : ''} }`
  /* A tag reset such as div { font-family: inherit } used to inherit from the story page.
     Give the captured family class specificity. Component classes and variant rules follow. */
  if (family) css += `\n.${ROOT_CLASS} { font-family: ${family}; }`
  const dark = own.filter(([name]) => capture.darkVars?.[name]).map(([name]) => `${name}: ${capture.darkVars![name]}`)
  if (dark.length) css += `\n${DARK} :where(.${ROOT_CLASS}) { ${dark.join('; ')}; }`
  return css
}

/* ------------------------------------------------------------------ */
/* The kit                                                             */

const clampSize = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)))
/** the width the server and the CLI render stories at */
export const STORY_VIEWPORT_WIDTH = 1280
const RESPONSIVE = /^@media[^{]*(?:(?:min|max)-width|width\s*[<>=])/i

export function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

function buildComponent(capture: ComponentCapture, tokenNames: Set<string>): KitComponent {
  const root = rootOf(capture.base.html)
  setClasses(root, [ROOT_CLASS, ...classesOf(root).filter((cls) => cls !== ROOT_CLASS)])
  const plan = planVariants(root, capture)
  /* instances wear their values (the engine sets them); the main is the template as written,
     so it wears the defaults its variant rules read */
  for (const prop of capture.props) setAttr(root, `data-${prop.name}`, prop.default)
  const bound = bindTexts(root, capture.texts)
  const allRules = [...capture.base.rules, ...capture.variants.flatMap((variant) => variant.capture?.rules ?? [])]
  const rules = rewriteRules(cleanRules(allRules), plan)
  const css = [rootRule(capture, tokenNames), ...rules].join('\n')
  const props: ComponentProp[] = [
    ...capture.props.map((prop) => ({
      name: prop.name,
      type: 'enum' as const,
      options: prop.options,
      default: prop.default,
      ...(prop.description ? { description: prop.description } : {}),
    })),
    ...capture.texts
      .filter((text) => bound.includes(text.name))
      .map((text) => ({
        name: text.name,
        type: 'text' as const,
        ...(text.description ? { description: text.description } : {}),
      })),
  ]
  const html = serializeOuter(root)
  const notes = [...capture.warnings, ...plan.notes]
  const unbound = capture.texts.filter((text) => !bound.includes(text.name)).map((text) => text.arg)
  if (unbound.length) notes.push(`text args not found in what it drew: ${unbound.join(', ')}`)
  const code: ComponentCode = {
    ...(capture.codePath ? { path: capture.codePath } : {}),
    name: capture.name.replace(/\s+/g, ''),
    snippet: `Storybook: ${capture.title} (${capture.storyId})`,
  }
  const built = {
    title: capture.title,
    name: capture.name,
    description: capture.description ?? `${capture.title}, from Storybook.`,
    code,
    props,
    html,
    css,
    /* media queries on width read the frame: a main narrower than the story's viewport would
       draw another breakpoint than the story did */
    width: rules.some((rule) => RESPONSIVE.test(rule))
      ? Math.max(STORY_VIEWPORT_WIDTH, clampSize(capture.base.width + 48, 160, 1600))
      : clampSize(capture.base.width + 48, 160, 1600),
    height: clampSize(capture.base.height + 48, 80, 1200),
  }
  const fontFaces = [
    ...new Set(
      [capture.base, ...capture.variants.flatMap((v) => (v.capture ? [v.capture] : []))].flatMap(
        (story) => story.fontFaces,
      ),
    ),
  ]
  return {
    ...built,
    hash: hashOf({ ...built, fontFaces }),
    fontFaces,
    notes,
    ...(capture.screenshot ? { screenshot: capture.screenshot } : {}),
  }
}

/** Every capture's theme values as tokens: the first value a name shows wins, dark as a theme. */
export function kitTokens(captures: ComponentCapture[]): DesignTokenInput[] {
  const tokens = new Map<string, DesignTokenInput>()
  for (const capture of captures) {
    for (const [name, value] of Object.entries(capturedVars(capture))) {
      if (tokens.has(name)) continue
      const type = tokenType(name, value)
      if (!type) continue
      const dark = capture.darkVars?.[name]
      tokens.set(name, { name, type, value, ...(dark && dark !== value ? { themes: { dark } } : {}) })
    }
  }
  /* semantic before palette, as create_tokens asks: names without a step number first */
  return [...tokens.values()].sort((a, b) => Number(/\d/.test(a.name)) - Number(/\d/.test(b.name)))
}

export function buildKit(captures: ComponentCapture[]): Kit {
  const tokens = kitTokens(captures)
  const tokenNames = new Set(tokens.map((token) => token.name))
  const components: KitComponent[] = []
  const skipped: Kit['skipped'] = []
  for (const capture of captures) {
    try {
      const component = buildComponent(capture, tokenNames)
      if (component.css.length > MAX_COMPONENT_CSS) {
        skipped.push({
          title: capture.title,
          reason: `its CSS is ${Math.round(component.css.length / 1024)} KB, past the ${MAX_COMPONENT_CSS / 1000} KB a component may hold`,
        })
        continue
      }
      components.push(component)
    } catch (error) {
      skipped.push({ title: capture.title, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { components, tokens, skipped }
}
