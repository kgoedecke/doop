import { tokensCss, type DesignToken, type TokenType } from '../shared/designTokens.ts'

/**
 * shadcn components are styled through a fixed set of CSS variables
 * (`--primary`, `--radius`, `--font-sans`…). Pointing those at the canvas's own
 * design tokens makes an imported component arrive in the design's colours,
 * corners and type, and follow every later token change, instead of carrying
 * the registry's preset as literals.
 */

interface Slot {
  type: TokenType
  /** canvas token names that mean this slot, most specific first, without the
   *  `--` and the type's namespace (`--color-brand` is `brand`) */
  names: string[]
}

const SLOTS: Record<string, Slot> = {
  background: { type: 'color', names: ['background', 'bg', 'surface', 'paper', 'page', 'canvas', 'base'] },
  foreground: { type: 'color', names: ['foreground', 'fg', 'text', 'ink', 'body', 'on-background', 'on-surface'] },
  card: { type: 'color', names: ['card', 'surface-raised', 'panel', 'surface'] },
  'card-foreground': { type: 'color', names: ['card-foreground', 'on-card', 'foreground', 'text', 'ink'] },
  popover: { type: 'color', names: ['popover', 'overlay', 'surface-raised', 'surface'] },
  'popover-foreground': { type: 'color', names: ['popover-foreground', 'foreground', 'text', 'ink'] },
  primary: { type: 'color', names: ['primary', 'brand', 'action', 'cta'] },
  'primary-foreground': {
    type: 'color',
    names: ['primary-foreground', 'on-primary', 'primary-contrast', 'primary-ink', 'brand-foreground', 'on-brand'],
  },
  secondary: { type: 'color', names: ['secondary', 'surface-muted', 'muted'] },
  'secondary-foreground': { type: 'color', names: ['secondary-foreground', 'on-secondary', 'foreground', 'text'] },
  muted: { type: 'color', names: ['muted', 'subtle', 'surface-muted', 'sub', 'surface-subtle'] },
  'muted-foreground': {
    type: 'color',
    names: ['muted-foreground', 'text-muted', 'muted-text', 'ink-soft', 'text-secondary', 'text-subtle', 'subtle-text'],
  },
  accent: { type: 'color', names: ['accent', 'highlight'] },
  'accent-foreground': { type: 'color', names: ['accent-foreground', 'on-accent'] },
  destructive: { type: 'color', names: ['destructive', 'danger', 'error', 'critical'] },
  border: { type: 'color', names: ['border', 'line', 'stroke', 'divider', 'outline'] },
  input: { type: 'color', names: ['input', 'border-input', 'input-border', 'border', 'line'] },
  ring: { type: 'color', names: ['ring', 'focus', 'focus-ring', 'primary', 'brand'] },
  /* shadcn's --radius is the lg step: rounded-md is --radius minus 2px */
  radius: { type: 'radius', names: ['radius', 'lg', 'md', 'base', 'default', 'control'] },
  'font-sans': { type: 'fontFamily', names: ['sans', 'body', 'ui', 'base', 'text', 'default', 'heading', 'display'] },
}

const NAMESPACE: Partial<Record<TokenType, RegExp>> = {
  color: /^(?:color|colour|c)-/,
  radius: /^(?:radius|rounded|r)-/,
  fontFamily: /^(?:font-family|font|family)-/,
}

/** A token's name as a slot would say it: `--color-on-primary` is `on-primary`. */
function bareName(token: DesignToken): string {
  const name = token.name.replace(/^--/, '').toLowerCase()
  return name.replace(NAMESPACE[token.type] ?? /^$/, '') || name
}

export interface RegistryTheme {
  /** declarations appended after the registry's own theme: `--primary:var(--color-brand)` */
  overrides: string
  /** canvas token names the rendered CSS must not define itself: Tailwind's
   *  theme uses the same namespaces (`--radius-md`, `--color-primary`), and a
   *  definition inside the component would shadow the token or close a cycle */
  shadowed: string[]
  /** the canvas tokens' values, present while rendering only and never saved,
   *  so the frame's own token block supplies them later */
  renderTokens: string
  mapped: { variable: string; token: string }[]
}

/** Which shadcn variables this canvas's tokens can stand in for. */
export function registryTheme(tokens: readonly DesignToken[], themeOrder: readonly string[] = []): RegistryTheme {
  const mapped: { variable: string; token: string }[] = []
  const declarations: string[] = []
  for (const [variable, slot] of Object.entries(SLOTS)) {
    const candidates = tokens.filter((token) => token.type === slot.type)
    let match: DesignToken | undefined
    for (const name of slot.names) {
      match = candidates.find((token) => bareName(token) === name)
      if (match) break
    }
    if (!match) continue
    /* a canvas token already called `--primary` is the variable itself: the
       registry's own value is dropped and the frame's token block supplies it */
    if (match.name !== `--${variable}`) declarations.push(`--${variable}:var(${match.name})`)
    mapped.push({ variable: `--${variable}`, token: match.name })
  }
  return {
    overrides: declarations.length ? `:root{${declarations.join(';')}}` : '',
    shadowed: [...new Set(mapped.map((entry) => entry.token))],
    renderTokens: mapped.length ? tokensCss(tokens, themeOrder) : '',
    mapped,
  }
}

/** Compiled CSS with every declaration of a shadowed name removed and the
 *  overrides added last in the base layer, after the registry's own theme. */
export function applyRegistryTheme(css: string, theme: RegistryTheme | undefined): string {
  if (!theme?.mapped.length) return css
  let themed = css
  for (const name of theme.shadowed) {
    const escaped = name.replace(/[^\w-]/g, '\\$&')
    themed = themed.replace(new RegExp(`(^|[{;\\s])${escaped}\\s*:[^;}]*;?`, 'g'), '$1')
  }
  return theme.overrides ? `${themed}\n@layer base{${theme.overrides}}` : themed
}
