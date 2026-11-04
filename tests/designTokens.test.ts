import { describe, expect, it } from 'vitest'
import {
  TOKEN_BLOCK_ATTR,
  aliasOf,
  normalizeTokenName,
  normalizeTokenValue,
  resolveToken,
  tailwindName,
  tokensCss,
  tokensMarkdown,
  tokensTailwind,
  tokenLabel,
  tokensUsedBy,
  usesToken,
  withTokenBlock,
  type DesignToken,
} from '../shared/designTokens.ts'

/**
 * The pure half of design tokens: how a frame's managed `<style
 * data-doop-tokens>` block follows the tokens it names, and how the list
 * exports as CSS, Tailwind and markdown.
 */

function token(name: string, type: DesignToken['type'], value: string, order = 0): DesignToken {
  return { name, type, value, order, updatedAt: 0, updatedBy: 'test' }
}

const TOKENS = [
  token('--color-ink', 'color', '#111', 1),
  token('--color-primary', 'color', 'var(--color-ink)', 2),
  token('--spacing-4', 'spacing', '16px', 3),
  token('--radius-md', 'radius', '8px', 4),
]

describe('withTokenBlock', () => {
  it('writes the values of the tokens a design names, and only those', () => {
    const html = '<!doctype html><html><head></head><body style="padding:var(--spacing-4)"></body></html>'
    const out = withTokenBlock(html, TOKENS)
    expect(out).toContain(`<style ${TOKEN_BLOCK_ATTR}>:root{--spacing-4:16px}</style>`)
    expect(out).not.toContain('--color-ink')
    expect(out.indexOf('<head>') + '<head>'.length).toBe(out.indexOf('<style'))
  })

  it('brings an alias target along', () => {
    const html = '<html><head></head><body style="color:var(--color-primary)"></body></html>'
    expect(withTokenBlock(html, TOKENS)).toContain(':root{--color-ink:#111;--color-primary:var(--color-ink)}')
  })

  it('returns the same string when the block already matches', () => {
    const html = withTokenBlock('<html><head></head><body style="gap:var(--spacing-4)"></body></html>', TOKENS)
    expect(withTokenBlock(html, TOKENS)).toBe(html)
  })

  it('replaces the block when a value changes, and drops it when nothing is named', () => {
    const html = withTokenBlock('<html><head></head><body style="gap:var(--spacing-4)"></body></html>', TOKENS)
    const changed = withTokenBlock(html, [token('--spacing-4', 'spacing', '20px')])
    expect(changed).toContain(':root{--spacing-4:20px}')
    expect(changed.match(/data-doop-tokens/g)).toHaveLength(1)
    const dropped = withTokenBlock(html, [])
    expect(dropped).not.toContain(TOKEN_BLOCK_ATTR)
  })

  it('ignores names that only appear inside its own block', () => {
    const html = '<html><head><style data-doop-tokens>:root{--color-ink:#111}</style></head><body></body></html>'
    expect(withTokenBlock(html, TOKENS)).not.toContain(TOKEN_BLOCK_ATTR)
  })

  it('places the block before a document without a head', () => {
    const out = withTokenBlock('<div style="color:var(--color-ink)">x</div>', TOKENS)
    expect(out.startsWith(`<style ${TOKEN_BLOCK_ATTR}>`)).toBe(true)
  })

  it('reads a fallback form and keeps prefixes apart', () => {
    expect(usesToken('var(--spacing-4, 8px)', '--spacing-4')).toBe(true)
    expect(usesToken('var(--spacing-40)', '--spacing-4')).toBe(false)
    expect(tokensUsedBy('<p style="margin:var( --radius-md )">', TOKENS).map((t) => t.name)).toEqual(['--radius-md'])
  })
})

describe('values and aliases', () => {
  it('keeps one clean declaration', () => {
    expect(normalizeTokenValue(' #fff ')).toBe('#fff')
    expect(normalizeTokenValue(600)).toBe('600')
    expect(normalizeTokenValue('red; } body { display:none')).toBeNull()
    expect(normalizeTokenValue('')).toBeNull()
    expect(normalizeTokenValue('<script>')).toBeNull()
  })

  it('normalizes a typed name to the CSS custom property', () => {
    expect(normalizeTokenName('color-primary')).toBe('--color-primary')
    expect(normalizeTokenName('  Color primary ')).toBe('--Color-primary')
    expect(normalizeTokenName('--color-primary')).toBe('--color-primary')
    expect(normalizeTokenName('-x')).toBe('--x')
    expect(tokenLabel('--color-primary')).toBe('color-primary')
  })

  it('resolves alias chains and refuses loops', () => {
    expect(aliasOf('var( --color-ink )')).toBe('--color-ink')
    expect(aliasOf('#111')).toBeNull()
    expect(resolveToken(TOKENS, '--color-primary')).toBe('#111')
    const loop = [token('--a', 'color', 'var(--b)'), token('--b', 'color', 'var(--a)')]
    expect(resolveToken(loop, '--a')).toBeNull()
    expect(resolveToken(TOKENS, '--missing')).toBeNull()
  })
})

describe('exports', () => {
  it('writes CSS in group order', () => {
    expect(tokensCss([TOKENS[2]!, TOKENS[0]!])).toBe(':root{--color-ink:#111;--spacing-4:16px}')
    expect(tokensCss([])).toBe('')
  })

  it('namespaces names for Tailwind and rewrites aliases to match', () => {
    expect(tailwindName({ name: '--primary', type: 'color' })).toBe('--color-primary')
    expect(tailwindName({ name: '--color-primary', type: 'color' })).toBe('--color-primary')
    expect(tailwindName({ name: '--body', type: 'fontSize' })).toBe('--text-body')
    const theme = tokensTailwind([token('--ink', 'color', '#111', 1), token('--brand', 'color', 'var(--ink)', 2)])
    expect(theme).toBe('@theme {\n  --color-ink: #111;\n  --color-brand: var(--color-ink);\n}')
  })

  it('writes one markdown table per type', () => {
    const md = tokensMarkdown([...TOKENS.slice(0, 3), { ...TOKENS[3]!, description: 'cards' }])
    expect(md).toContain('### Colour')
    expect(md).toContain('| `--color-ink` | `#111` |  |')
    expect(md).toContain('### Radius')
    expect(md).toContain('| `--radius-md` | `8px` | cards |')
    expect(md.indexOf('### Colour')).toBeLessThan(md.indexOf('### Spacing'))
  })
})
