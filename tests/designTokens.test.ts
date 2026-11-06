import { describe, expect, it } from 'vitest'
import {
  TOKEN_BLOCK_ATTR,
  aliasOf,
  frameTheme,
  nextTokenName,
  normalizeTokenName,
  normalizeTokenValue,
  renameThemeAttrs,
  resolveToken,
  tailwindName,
  tokensCss,
  tokensMarkdown,
  tokensTailwind,
  tokenLabel,
  tokensUsedBy,
  usesToken,
  withFrameTheme,
  withTokenBlock,
  type DesignToken,
} from '../shared/designTokens.ts'

/**
 * The pure half of design tokens: how a frame's managed `<style
 * data-doop-tokens>` block follows the tokens it names, and how the list
 * exports as CSS, Tailwind and markdown.
 */

function token(
  name: string,
  type: DesignToken['type'],
  value: string,
  order = 0,
  extra: Partial<DesignToken> = {},
): DesignToken {
  return { name, type, value, order, updatedAt: 0, updatedBy: 'test', ...extra }
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

  it('names a new token from its type, past the names taken', () => {
    expect(nextTokenName([], 'radius')).toBe('--radius-1')
    expect(nextTokenName([token('--radius-1', 'radius', '4px'), token('--radius-2', 'radius', '8px')], 'radius')).toBe(
      '--radius-3',
    )
    expect(nextTokenName([token('--font-1', 'fontFamily', 'Inter')], 'fontSize')).toBe('--size-1')
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

describe('themes', () => {
  const themed = [
    token('--ink', 'color', '#111', 1, { themes: { dark: '#eee' } }),
    token('--brand', 'color', 'var(--ink)', 2),
    token('--spacing-4', 'spacing', '16px', 3),
  ]

  it('writes every value under each theme, so a nested theme starts from its own values', () => {
    const css = tokensCss(themed, ['dark', 'light'])
    expect(css).toBe(
      ':root{--ink:#111;--brand:var(--ink);--spacing-4:16px}\n' +
        ':root[data-doop-theme="dark"],[data-doop-theme="dark"]{--ink:#eee;--brand:var(--ink);--spacing-4:16px}\n' +
        /* a theme without overrides still resets a subtree to the defaults */
        ':root[data-doop-theme="light"],[data-doop-theme="light"]{--ink:#111;--brand:var(--ink);--spacing-4:16px}',
    )
    expect(resolveToken(themed, '--brand', 'dark')).toBe('#eee')
  })

  it('brings along every token a value reads through var(), not only whole-value aliases', () => {
    const mixed = [
      token('--ink', 'color', '#111', 1),
      token('--tint', 'color', 'color-mix(in srgb, var(--ink) 50%, white)', 2),
      token('--edge', 'color', '#000', 3, { themes: { dark: 'var(--ink)' } }),
    ]
    expect(tokensUsedBy('<p style="color:var(--tint)">', mixed).map((t) => t.name)).toEqual(['--ink', '--tint'])
    expect(tokensUsedBy('<p style="color:var(--edge)">', mixed).map((t) => t.name)).toEqual(['--ink', '--edge'])
  })

  it('moves a frame between themes and reads which one it is on', () => {
    const html = '<!doctype html><html lang="en"><head></head><body></body></html>'
    const dark = withFrameTheme(html, 'dark')
    expect(dark).toContain('<html lang="en" data-doop-theme="dark">')
    expect(frameTheme(dark)).toBe('dark')
    expect(frameTheme(html)).toBeNull()
    expect(withFrameTheme(dark, null)).toBe(html)
    expect(withFrameTheme(dark, 'dim')).toContain('<html lang="en" data-doop-theme="dim">')
    expect(renameThemeAttrs(dark, 'dark', 'night')).toContain('data-doop-theme="night"')
    expect(renameThemeAttrs("<div data-doop-theme='dark'>", 'dark', 'night')).toBe("<div data-doop-theme='night'>")
    expect(withFrameTheme('<p>no root</p>', 'dark')).toBe('<p>no root</p>')
    /* an unquoted attribute is read, replaced and renamed too */
    expect(frameTheme('<html data-doop-theme=dark>')).toBe('dark')
    expect(withFrameTheme('<html data-doop-theme=dark lang="en">', 'dim')).toBe(
      '<html lang="en" data-doop-theme="dim">',
    )
    expect(renameThemeAttrs('<html data-doop-theme=dark>', 'dark', 'night')).toBe('<html data-doop-theme="night">')
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
    /* a reference inside a function, and one with a fallback, follow the rename too */
    const nested = tokensTailwind([
      token('--ink', 'color', '#111', 1),
      token('--tint', 'color', 'color-mix(in srgb, var(--ink) 50%, white)', 2),
      token('--edge', 'color', 'var(--ink, #000)', 3),
      token('--other', 'color', 'var(--unknown)', 4),
      token('--step', 'spacing', '4px', 5),
      token('--double', 'spacing', 'calc(var(--step /* base */) * 2)', 6),
    ])
    expect(nested).toContain('--spacing-double: calc(var(--spacing-step /* base */) * 2);')
    expect(nested).toContain('--color-tint: color-mix(in srgb, var(--color-ink) 50%, white);')
    expect(nested).toContain('--color-edge: var(--color-ink, #000);')
    expect(nested).toContain('--color-other: var(--unknown);')
    /* two names that would export alike keep their own names apart */
    const clash = tokensTailwind([token('--primary', 'color', '#111', 1), token('--color-primary', 'color', '#222', 2)])
    expect(clash).toBe('@theme {\n  --primary: #111;\n  --color-primary: #222;\n}')
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
