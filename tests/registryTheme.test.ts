import { describe, expect, it } from 'vitest'
import type { DesignToken } from '../shared/designTokens.ts'
import { applyRegistryTheme, registryTheme } from '../server/registryTheme.ts'

const token = (name: string, type: DesignToken['type'], value: string): DesignToken => ({
  name,
  type,
  value,
  order: 0,
  updatedAt: 0,
  updatedBy: 'test',
})

describe('theming registry components with canvas tokens', () => {
  it('points shadcn variables at the canvas tokens that mean the same thing', () => {
    const theme = registryTheme([
      token('--color-brand', 'color', '#6d28d9'),
      token('--color-on-brand', 'color', '#fff'),
      token('--color-surface', 'color', '#fafafa'),
      token('--color-ink', 'color', '#111'),
      token('--radius-md', 'radius', '10px'),
      token('--font-body', 'fontFamily', 'Inter, sans-serif'),
      token('--spacing-4', 'spacing', '16px'),
    ])
    expect(theme.mapped).toEqual(
      expect.arrayContaining([
        { variable: '--primary', token: '--color-brand' },
        { variable: '--primary-foreground', token: '--color-on-brand' },
        { variable: '--background', token: '--color-surface' },
        { variable: '--foreground', token: '--color-ink' },
        { variable: '--ring', token: '--color-brand' },
        { variable: '--radius', token: '--radius-md' },
        { variable: '--font-sans', token: '--font-body' },
      ]),
    )
    expect(theme.overrides).toContain('--primary:var(--color-brand)')
    expect(theme.overrides).not.toContain('spacing')
    expect(theme.renderTokens).toContain('--color-brand:#6d28d9')
  })

  it('never makes a variable refer to itself', () => {
    const theme = registryTheme([token('--primary', 'color', 'red')])
    expect(theme.overrides).toBe(':root{--ring:var(--primary)}')
    expect(theme.shadowed).toEqual(['--primary'])
  })

  it('drops the component’s own definitions of the canvas tokens it now reads', () => {
    const theme = registryTheme([token('--radius-md', 'radius', '3px'), token('--color-primary', 'color', 'red')])
    const css = applyRegistryTheme(
      '@layer theme{:root{--radius-md:calc(var(--radius) - 2px);--color-primary:var(--primary);--x:1}}',
      theme,
    )
    expect(css).not.toContain('--radius-md:')
    expect(css).not.toContain('--color-primary:')
    expect(css).toContain('--x:1')
    expect(css).toContain('@layer base{:root{--primary:var(--color-primary)')
    expect(css).toContain('--radius:var(--radius-md)')
  })

  it('leaves the registry’s own theme alone when nothing matches', () => {
    expect(registryTheme([token('--color-chart-7', 'color', 'red')])).toEqual({
      overrides: '',
      shadowed: [],
      renderTokens: '',
      mapped: [],
    })
  })
})

describe('reading the rendered stylesheet', () => {
  it('reads past an escaped quote in a class selector, keeping every rule after it', async () => {
    const { parseFragment } = await import('parse5')
    const { extractComponentCss } = await import('../server/componentCss.ts')
    const sheet = [
      String.raw`@layer base{:root{--primary:black}}`,
      String.raw`@layer utilities{.bg-primary{background:var(--primary)}.\[\&_svg\:not\(\[class\*\=\'size-\'\]\)\]\:size-4 svg:not([class*="size-"]){width:1rem}}`,
      String.raw`@property --tw-shadow{syntax:"*";inherits:false}`,
      String.raw`@layer base{:root{--primary:var(--color-brand)}}`,
    ].join('\n')
    const root = parseFragment('<button class="bg-primary">Go</button>').childNodes[0] as Parameters<
      typeof extractComponentCss
    >[1]
    const { css } = extractComponentCss(sheet, root, 'c1')
    expect(css).toContain('--primary: var(--color-brand)')
    expect(css).not.toContain('--primary: black')
  })
})
