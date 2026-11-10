/**
 * Design tokens: a canvas's named design values (colours, spacing, radii,
 * type), each a CSS custom property a frame uses by writing `var(--name)`.
 * The vocabulary is Paper's eleven token types, so an agent that knows
 * Paper's tools can call ours with the same payload, and the names follow
 * Tailwind v4's `@theme` namespaces, so the Tailwind export is a pass-through.
 *
 * A frame stays self-contained: the values of the tokens it names live in its
 * own HTML, in one managed `<style data-doop-tokens>` block, so every renderer
 * that reads frame HTML (the canvas, screenshots, PDF export, the iOS app)
 * resolves them without knowing about the canvas. `withTokenBlock` writes
 * that block; the browser runs it on its saves, the server on every frame
 * write and again on every frame that names a token whose value changes.
 */

export const TOKEN_BLOCK_ATTR = 'data-doop-tokens'

export const TOKEN_TYPES = [
  'color',
  'opacity',
  'radius',
  'spacing',
  'container',
  'breakpoint',
  'fontFamily',
  'fontWeight',
  'fontSize',
  'lineHeight',
  'letterSpacing',
] as const
export type TokenType = (typeof TOKEN_TYPES)[number]

export function isTokenType(value: unknown): value is TokenType {
  return typeof value === 'string' && (TOKEN_TYPES as readonly string[]).includes(value)
}

/** The add menu's three groups, in its order: surface, layout, type. */
export const TOKEN_GROUPS: readonly (readonly TokenType[])[] = [
  ['color', 'opacity', 'radius'],
  ['spacing', 'container', 'breakpoint'],
  ['fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing'],
]

/** The Tailwind v4 `@theme` namespace each type lives under. */
export const TOKEN_NAMESPACE: Record<TokenType, string> = {
  color: '--color-',
  opacity: '--opacity-',
  radius: '--radius-',
  spacing: '--spacing-',
  container: '--container-',
  breakpoint: '--breakpoint-',
  fontFamily: '--font-',
  fontWeight: '--font-weight-',
  fontSize: '--text-',
  lineHeight: '--leading-',
  letterSpacing: '--tracking-',
}

/** The CSS properties the Design panel edits that may take each type. */
export const TOKEN_PROPERTIES: Record<TokenType, readonly string[]> = {
  color: ['color', 'background-color', 'border-color'],
  opacity: ['opacity'],
  radius: ['border-radius'],
  spacing: ['gap', 'padding', 'row-gap', 'column-gap', 'width', 'height'],
  container: ['width', 'max-width'],
  breakpoint: [],
  fontFamily: ['font-family'],
  fontWeight: ['font-weight'],
  fontSize: ['font-size'],
  lineHeight: ['line-height'],
  letterSpacing: ['letter-spacing'],
}

export interface DesignToken {
  /** the CSS custom property name, `--color-primary`; unique per canvas */
  name: string
  type: TokenType
  /** a CSS value, or `var(--other)` to alias another token */
  value: string
  /** the value under a canvas theme (light, dark, …) where it differs from `value` */
  themes?: Record<string, string>
  description?: string
  /** display order within the canvas, lowest first */
  order: number
  updatedAt: number
  updatedBy: string
}

export type DesignTokenInput = Pick<DesignToken, 'name' | 'type' | 'value'> & {
  description?: string
  themes?: Record<string, string>
}

/** The attribute that switches a frame (or a subtree) to a token theme:
 *  `<html data-doop-theme="dark">`. */
export const THEME_ATTR = 'data-doop-theme'
export const MAX_TOKEN_THEMES = 8
/** The theme a token's `value` belongs to: always there, never renamed or removed. */
export const DEFAULT_THEME = 'default'
const THEME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export function isThemeName(value: unknown): value is string {
  return typeof value === 'string' && value !== DEFAULT_THEME && THEME_RE.test(value)
}

/** One rename of a theme: every token's value under `from` moves to `to`. */
export interface ThemeRename {
  from: string
  to: string
}

/** The themes a token list defines values for, in the canvas's order first. */
export function themesOf(tokens: readonly DesignToken[], order: readonly string[] = []): string[] {
  const seen = new Set<string>()
  for (const token of tokens) for (const theme of Object.keys(token.themes ?? {})) seen.add(theme)
  return [...order.filter((theme) => seen.has(theme)), ...[...seen].filter((theme) => !order.includes(theme)).sort()]
}

/** One entry of a set_tokens batch: change, rename or delete a token by name. */
export interface TokenEdit {
  name: string
  newName?: string
  type?: TokenType
  value?: string | number
  /** merged into the token's theme values; null removes that theme's value */
  themes?: Record<string, string | number | null>
  description?: string
  order?: number
  delete?: boolean
}

/** What one entry of a create or set batch came to; errors ride in-band. */
export type TokenResult =
  { name: string; result: 'created' | 'updated' | 'deleted' } | { name: string; result: 'error'; message: string }

export const MAX_TOKENS = 500
export const MAX_TOKEN_VALUE = 512
export const MAX_TOKEN_DESCRIPTION = 1024

const NAME_RE = /^--[a-zA-Z0-9_-]+$/

export function isTokenName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && NAME_RE.test(value)
}

/** The stored name for what someone typed: trimmed, spaces to hyphens, the
 *  `--` added when it is missing. `color primary` and `--color-primary` are
 *  the same token. The result still has to pass `isTokenName`. */
export function normalizeTokenName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim().replace(/\s+/g, '-')
  return text && !text.startsWith('--') ? `--${text.replace(/^-+/, '')}` : text
}

/** How a name reads in the UI: without the `--` CSS needs. */
export function tokenLabel(name: string): string {
  return name.replace(/^--/, '')
}

/** The token another's value aliases, or null for a literal. */
export function aliasOf(value: string): string | null {
  const m = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*\)$/.exec(value.trim())
  return m?.[1] ?? null
}

/** A value fit to sit inside a style block: one line, no delimiters that
 *  would end the declaration or the block early. Numbers are taken as given,
 *  since every type has a unitless reading (an opacity, a weight, a ratio). */
export function normalizeTokenValue(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_TOKEN_VALUE) return null
  if (/[;{}<>\n\r\\]/.test(trimmed)) return null
  return trimmed
}

/** A token's value under a theme: its override there, else its default. */
export function effectiveValue(token: Pick<DesignToken, 'value' | 'themes'>, theme?: string): string {
  const override = theme ? token.themes?.[theme] : undefined
  return override === undefined ? token.value : override
}

/** Resolve a value through its aliases, under a theme when given; null when
 *  a link is missing or circular. */
export function resolveToken(tokens: readonly DesignToken[], name: string, theme?: string): string | null {
  const seen = new Set<string>()
  let current = name
  for (;;) {
    if (seen.has(current)) return null
    seen.add(current)
    const token = tokens.find((t) => t.name === current)
    if (!token) return null
    const value = effectiveValue(token, theme)
    const next = aliasOf(value)
    if (next === null) return value
    current = next
  }
}

/** Order for the panel and the exports: by group, then by `order`. */
export function sortTokens(tokens: readonly DesignToken[]): DesignToken[] {
  const rank = new Map<TokenType, number>()
  TOKEN_GROUPS.flat().forEach((type, i) => rank.set(type, i))
  return [...tokens].sort(
    (a, b) => (rank.get(a.type) ?? 0) - (rank.get(b.type) ?? 0) || a.order - b.order || a.name.localeCompare(b.name),
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const BLOCK_RE = new RegExp(`<style\\b[^>]*\\b${TOKEN_BLOCK_ATTR}\\b[^>]*>[\\s\\S]*?</style>`, 'i')

/** Whether the design names a token, through `var(--name)` or `var(--name,`. */
export function usesToken(html: string, name: string): boolean {
  return new RegExp(`var\\(\\s*${escapeRegExp(name)}\\s*[,)]`).test(html)
}

/** The tokens a design names, directly or through an alias chain. */
export function tokensUsedBy(html: string, tokens: readonly DesignToken[]): DesignToken[] {
  const design = html.replace(BLOCK_RE, '')
  const wanted = new Set<string>()
  const queue = tokens.filter((t) => usesToken(design, t.name)).map((t) => t.name)
  while (queue.length) {
    const name = queue.pop()!
    if (wanted.has(name)) continue
    wanted.add(name)
    const token = tokens.find((t) => t.name === name)
    /* every var() inside a value counts, not only a whole-value alias: a
       colour such as color-mix(in srgb, var(--ink) 50%, white) needs --ink */
    for (const value of [token?.value ?? '', ...Object.values(token?.themes ?? {})]) {
      for (const ref of referencedTokens(value)) queue.push(ref)
    }
  }
  return sortTokens(tokens.filter((t) => wanted.has(t.name)))
}

/** The custom properties a value reads through `var()`, anywhere in it. */
export function referencedTokens(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]!)
}

function declarations(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([name, value]) => `${name}:${value}`).join(';')
}

/** `:root{--a:1px;--b:var(--a)}` for a token list in display order, then
 *  one block per theme with the values that differ there, scoped to the
 *  `data-doop-theme` attribute on the root or on any subtree. */
export function tokensCss(tokens: readonly DesignToken[], themeOrder: readonly string[] = []): string {
  if (!tokens.length) return ''
  const sorted = sortTokens(tokens)
  const blocks = [`:root{${declarations(sorted.map((t) => [t.name, t.value]))}}`]
  for (const theme of allThemes(sorted, themeOrder)) {
    /* a theme block carries every token's value under that theme, so a
       themed subtree starts from the theme, not from whatever the outer
       theme set, and an alias (substituted where it is declared) resolves
       there; a theme with no overrides still gets its block for the same reason */
    const pairs = sorted.map((t) => [t.name, effectiveValue(t, theme)] as const)
    blocks.push(`:root[${THEME_ATTR}="${theme}"],[${THEME_ATTR}="${theme}"]{${declarations(pairs)}}`)
  }
  return blocks.join('\n')
}

/** The canvas's themes in order, then any a token names that the list lacks. */
function allThemes(tokens: readonly DesignToken[], order: readonly string[]): string[] {
  return [...order, ...themesOf(tokens).filter((theme) => !order.includes(theme))]
}

/** The HTML with the values of the tokens it names in its own
 *  `<style data-doop-tokens>` block, replaced when they differ and removed
 *  when it names none. Returns the input itself when nothing changes, so
 *  callers can compare by identity. */
export function withTokenBlock(
  html: string,
  tokens: readonly DesignToken[],
  themeOrder: readonly string[] = [],
): string {
  const existing = BLOCK_RE.exec(html)
  const used = tokensUsedBy(html, tokens)
  if (!used.length) return existing ? html.replace(BLOCK_RE, '') : html
  const tag = `<style ${TOKEN_BLOCK_ATTR}>${tokensCss(used, themeOrder)}</style>`
  if (existing) {
    if (existing[0] === tag) return html
    return `${html.slice(0, existing.index)}${tag}${html.slice(existing.index + existing[0].length)}`
  }
  const headOpen = /<head\b[^>]*>/i.exec(html)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return `${html.slice(0, at)}${tag}${html.slice(at)}`
  }
  /* no <head>: the parser hoists a leading <style> into the one it makes */
  const htmlOpen = /<html\b[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html)
  const at = htmlOpen ? htmlOpen.index + htmlOpen[0].length : 0
  return `${html.slice(0, at)}${tag}${html.slice(at)}`
}

/** The stem a new token of each type is named from: `radius-1`, `color-2`. */
export const TOKEN_NAME_STEM: Record<TokenType, string> = {
  color: 'color',
  opacity: 'opacity',
  radius: 'radius',
  spacing: 'spacing',
  container: 'container',
  breakpoint: 'breakpoint',
  fontFamily: 'font',
  fontWeight: 'weight',
  fontSize: 'size',
  lineHeight: 'line-height',
  letterSpacing: 'letter-spacing',
}

/** The next free `stem-N` name for a type, counting from 1. */
export function nextTokenName(tokens: readonly Pick<DesignToken, 'name'>[], type: TokenType): string {
  const taken = new Set(tokens.map((t) => t.name))
  for (let i = 1; ; i++) {
    const name = `--${TOKEN_NAME_STEM[type]}-${i}`
    if (!taken.has(name)) return name
  }
}

/** The HTML with every `data-doop-theme="from"` switched to `to`. */
export function renameThemeAttrs(html: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html
    .replace(new RegExp(`(${THEME_ATTR}\\s*=\\s*)(["'])${escaped}\\2`, 'g'), `$1$2${to}$2`)
    .replace(new RegExp(`(${THEME_ATTR}\\s*=\\s*)${escaped}(?=[\\s/>])`, 'g'), `$1"${to}"`)
}

const ROOT_TAG_RE = /<(html|body)\b([^>]*)>/i
/* a quoted value, or an unquoted one up to the next space or tag end */
const THEME_ATTR_RE = new RegExp(`\\s*${THEME_ATTR}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i')

/** The theme a frame's root switches to, or null for the default. */
export function frameTheme(html: string): string | null {
  const root = ROOT_TAG_RE.exec(html)
  const m = root ? THEME_ATTR_RE.exec(root[2]!) : null
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null
}

/** The HTML with its root switched to a theme (null: the default). The
 *  attribute goes on `<html>`, else `<body>`; a document with neither is
 *  returned as is. */
export function withFrameTheme(html: string, theme: string | null): string {
  const root = ROOT_TAG_RE.exec(html)
  if (!root) return html
  const attrs = root[2]!.replace(THEME_ATTR_RE, '')
  const tag = `<${root[1]}${attrs}${theme ? ` ${THEME_ATTR}="${theme}"` : ''}>`
  return `${html.slice(0, root.index)}${tag}${html.slice(root.index + root[0].length)}`
}

/** A name under its type's Tailwind namespace: `--primary` as a colour is
 *  `--color-primary`; a name already there is kept. */
export function tailwindName(token: Pick<DesignToken, 'name' | 'type'>): string {
  const prefix = TOKEN_NAMESPACE[token.type]
  return token.name.startsWith(prefix) ? token.name : `${prefix}${token.name.slice(2)}`
}

/** A Tailwind v4 `@theme { }` block, aliases rewritten to their namespaced names. */
/** Each token's exported name: its type's Tailwind namespace, unless that
 *  collides with another token (`--primary` beside `--color-primary`), in
 *  which case the token keeps its own name so no property is written twice. */
export function tailwindNames(tokens: readonly DesignToken[]): Map<string, string> {
  const raw = new Set(tokens.map((t) => t.name))
  const counts = new Map<string, number>()
  for (const t of tokens) counts.set(tailwindName(t), (counts.get(tailwindName(t)) ?? 0) + 1)
  return new Map(
    tokens.map((t) => {
      const name = tailwindName(t)
      const collides = (counts.get(name) ?? 0) > 1 || (name !== t.name && raw.has(name))
      return [t.name, collides ? t.name : name]
    }),
  )
}

export function tokensTailwind(tokens: readonly DesignToken[], themeOrder: readonly string[] = []): string {
  if (!tokens.length) return ''
  const renamed = tailwindNames(tokens)
  /* every var() naming a token follows the token's new name: an alias, and
     a reference inside a calc() or a color-mix() alike; what sits between
     the name and the comma or paren (space, a comment) is kept as written */
  const rewrite = (value: string) =>
    value.replace(/var\(\s*(--[a-zA-Z0-9_-]+)((?:\s|\/\*[\s\S]*?\*\/)*[,)])/g, (whole, name: string, end: string) =>
      renamed.has(name) ? `var(${renamed.get(name)}${end}` : whole,
    )
  const sorted = sortTokens(tokens)
  const lines = sorted.map((t) => `  ${renamed.get(t.name)}: ${rewrite(t.value)};`)
  const blocks = [`@theme {\n${lines.join('\n')}\n}`]
  for (const theme of allThemes(sorted, themeOrder)) {
    const lines = sorted.map((t) => `  ${renamed.get(t.name)}: ${rewrite(effectiveValue(t, theme))};`)
    blocks.push(`[${THEME_ATTR}="${theme}"] {\n${lines.join('\n')}\n}`)
  }
  return blocks.join('\n\n')
}

const TYPE_LABEL: Record<TokenType, string> = {
  color: 'Colour',
  opacity: 'Opacity',
  radius: 'Radius',
  spacing: 'Spacing',
  container: 'Container',
  breakpoint: 'Breakpoint',
  fontFamily: 'Font family',
  fontWeight: 'Font weight',
  fontSize: 'Font size',
  lineHeight: 'Line height',
  letterSpacing: 'Letter spacing',
}

export function tokenTypeLabel(type: TokenType): string {
  return TYPE_LABEL[type]
}

/** A markdown table per type: the styleguide's token section. */
export function tokensMarkdown(tokens: readonly DesignToken[], themeOrder: readonly string[] = []): string {
  if (!tokens.length) return ''
  const sorted = sortTokens(tokens)
  const themes = themesOf(sorted, themeOrder)
  const head = `| Token | Value |${themes.map((m) => ` ${m} |`).join('')} Use |\n| --- | --- |${themes.map(() => ' --- |').join('')} --- |`
  const sections: string[] = []
  for (const group of TOKEN_GROUPS) {
    for (const type of group) {
      const rows = sorted.filter((t) => t.type === type)
      if (!rows.length) continue
      const lines = rows.map((t) => {
        const cells = themes.map((m) => (t.themes?.[m] === undefined ? ' |' : ` \`${t.themes[m]}\` |`)).join('')
        return `| \`${t.name}\` | \`${t.value}\` |${cells} ${t.description ?? ''} |`
      })
      sections.push(`### ${TYPE_LABEL[type]}\n\n${head}\n${lines.join('\n')}`)
    }
  }
  return sections.join('\n\n')
}

/** The tokens as agents see them in get_canvas: compact, one entry each. */
export function describeTokens(tokens: readonly DesignToken[]): {
  name: string
  type: TokenType
  value: string
  themes?: Record<string, string>
  description?: string
}[] {
  return sortTokens(tokens).map((t) => ({
    name: t.name,
    type: t.type,
    value: t.value,
    ...(t.themes && Object.keys(t.themes).length ? { themes: t.themes } : {}),
    ...(t.description ? { description: t.description } : {}),
  }))
}

/** What an agent needs to know about a canvas's tokens — one paragraph. */
export function tokensBrief(tokens: readonly DesignToken[], themeOrder: readonly string[] = []): string {
  const names = sortTokens(tokens)
    .map((t) => `${t.name} (${t.type}: ${t.value})`)
    .join(', ')
  const themes = themesOf(tokens, themeOrder)
  return (
    `Design tokens (${names}): use one by writing var(--name) in CSS — background: var(--color-primary) — ` +
    `never the literal value, so a token change restyles every frame at once. Doop writes the values into ` +
    `each frame's <style ${TOKEN_BLOCK_ATTR}> block by itself; do not define them yourself and keep that block. ` +
    (themes.length
      ? `Themes (${themes.join(', ')}) give some tokens a different value: put ${THEME_ATTR}="${themes[0]}" on a frame's <html> (or on one subtree) to switch it there. `
      : '') +
    `Breakpoint tokens describe responsive variants, which on a canvas are separate frames. ` +
    `Add tokens with create_tokens when a brief names a palette, scale or type ramp.`
  )
}
