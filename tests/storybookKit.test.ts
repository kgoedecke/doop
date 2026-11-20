import { describe, expect, it } from 'vitest'
import { buildKit, cleanRules, cssEscape, darkSelector, kitTokens, tokenType } from '../shared/storybookKit.ts'
import { groupComponents, parseStoryIndex, storybookBase, storyUrl } from '../shared/storybookIndex.ts'
import { propName, type ComponentCapture } from '../shared/storybookAcquire.ts'
import type { StoryCapture } from '../shared/storybookCapture.ts'
import { extractComponentCss, unmatchedSelectors, unreadCss } from '../server/componentCss.ts'
import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes as Tree } from 'parse5'

const story = (html: string, rules: string[], vars: Record<string, string> = {}): StoryCapture => ({
  html,
  rules,
  vars,
  fontFaces: [],
  text: { 'font-family': 'Inter, sans-serif', color: 'rgb(17, 17, 17)' },
  width: 120,
  height: 40,
  warnings: [],
})

/* a shadcn-style Button: cva classes per variant and size, Tailwind's escaped classes, a .dark rule */
const RULES = [
  '.inline-flex { display: inline-flex; }',
  '.bg-primary { background-color: var(--primary); }',
  '.border { border-width: 1px; }',
  '.bg-transparent { background-color: transparent; }',
  '.h-9 { height: 2.25rem; }',
  '.h-8 { height: 2rem; }',
  String.raw`.\[\&_svg\:not\(\[class\*\=\'size-\'\]\)\]\:size-4 svg:not([class*='size-']) { width: 1rem; height: 1rem; }`,
  String.raw`.hover\:bg-primary\/90:hover { background-color: color-mix(in oklab, var(--primary) 90%, transparent); }`,
  String.raw`@media (hover: hover) { .hover\:underline:hover { text-decoration-line: underline; } }`,
  '@media (hover: none) { .inline-flex { display: block; } }',
  String.raw`.dark\:bg-input\/30:is(.dark *) { background-color: var(--input); }`,
  '.label { color: inherit; }',
]
const CLASSES = String.raw`inline-flex h-9 [&_svg:not([class*='size-'])]:size-4 hover:bg-primary/90 hover:underline dark:bg-input/30`
const button = (variantClasses: string, size = 'h-9') =>
  `<button class="${CLASSES.replace('h-9', size)} ${variantClasses}"><svg></svg><span class="label">Click me</span></button>`

const capture = (): ComponentCapture => ({
  title: 'UI/Button',
  name: 'Button',
  storyId: 'ui-button--default',
  codePath: 'src/components/ui/button.tsx',
  props: [
    {
      name: 'variant',
      arg: 'variant',
      kind: 'enum',
      options: ['default', 'outline'],
      values: ['default', 'outline'],
      default: 'default',
    },
    {
      name: 'size',
      arg: 'size',
      kind: 'enum',
      options: ['default', 'sm'],
      values: ['default', 'sm'],
      default: 'default',
    },
  ],
  texts: [{ name: 'children', arg: 'children', value: 'Click me' }],
  base: story(button('bg-primary'), RULES, {
    '--primary': 'oklch(0.2 0 0)',
    '--input': '#e5e5e5',
    '--ring-offset': '2px',
  }),
  variants: [
    { prop: 'variant', value: 'outline', capture: story(button('border bg-transparent'), RULES) },
    { prop: 'size', value: 'sm', capture: story(button('bg-primary', 'h-8'), RULES) },
  ],
  darkVars: { '--primary': 'oklch(0.9 0 0)', '--ring-offset': '3px' },
  warnings: [],
})

function mainOf(html: string): Tree.Element {
  const stack: Tree.Node[] = [parse(`<!doctype html><html><body>${html}</body></html>`)]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if ('tagName' in node && node.tagName === 'button') return node
    if ('childNodes' in node) stack.push(...node.childNodes)
  }
  throw new Error('no button')
}

describe('reading a Storybook index', () => {
  const index = {
    v: 5,
    entries: {
      a: { type: 'docs', id: 'ui-button--docs', title: 'UI/Button', name: 'Docs' },
      b: {
        type: 'story',
        id: 'ui-button--outline',
        title: 'UI/Button',
        name: 'Outline',
        importPath: './src/Button.stories.tsx',
      },
      c: {
        type: 'story',
        id: 'ui-button--default',
        title: 'UI/Button',
        name: 'Default',
        componentPath: './src/Button.tsx',
      },
      d: { type: 'story', id: 'forms-input--basic', title: 'Forms/Input', name: 'Basic' },
      e: { type: 'story', id: 'marketing-card--a', title: 'Marketing/Card', name: 'A' },
      f: { type: 'story', id: 'app-card--a', title: 'App/Card', name: 'A' },
    },
  }

  it('groups stories by title, picks the default story, and reads where it lives in code', () => {
    const components = groupComponents(parseStoryIndex(index))
    expect(components.map((c) => c.name)).toEqual(['Button', 'Input', 'Marketing Card', 'App Card'])
    expect(components[0]).toMatchObject({
      title: 'UI/Button',
      baseStoryId: 'ui-button--default',
      codePath: 'src/Button.tsx',
    })
    expect(components[0]!.stories).toHaveLength(2)
  })

  it('reads v6 stories.json', () => {
    const v6 = {
      v: 3,
      stories: {
        x: { id: 'a--b', kind: 'A', name: 'B', parameters: {} },
        y: { id: 'a--docs', kind: 'A', name: 'Docs', parameters: { docsOnly: true } },
      },
    }
    expect(parseStoryIndex(v6).map((s) => s.id)).toEqual(['a--b'])
  })

  it('takes a manager URL to its Storybook', () => {
    expect(storybookBase('https://sb.example.com/?path=/story/ui-button--default').href).toBe('https://sb.example.com/')
    expect(storybookBase('https://x.dev/storybook/index.html').href).toBe('https://x.dev/storybook/')
    expect(storyUrl(storybookBase('https://x.dev/sb'), 'a--b')).toBe(
      'https://x.dev/sb/iframe.html?id=a--b&viewMode=story',
    )
    expect(() => storybookBase('ftp://x')).toThrow()
  })
})

describe('building a component from captures', () => {
  const kit = buildKit([capture()])
  const component = kit.components[0]!

  it('makes each prop an enum and the shown text a text prop', () => {
    expect(component.props.map((p) => [p.name, p.type, p.options?.join('|')])).toEqual([
      ['variant', 'enum', 'default|outline'],
      ['size', 'enum', 'default|sm'],
      ['children', 'text', undefined],
    ])
    expect(component.html).toContain('data-doop-prop="children"')
    expect(component.code).toMatchObject({ path: 'src/components/ui/button.tsx', name: 'Button' })
  })

  it('moves the classes a prop decides into rules on its value', () => {
    const classes = /class="([^"]*)"/.exec(component.html)![1]!.split(' ')
    expect(classes).not.toContain('bg-primary')
    expect(classes).not.toContain('h-9')
    expect(component.html).toContain('class="sb-root inline-flex')
    /* the main draws its default variant from the same rules */
    expect(component.html).toContain('data-variant="default" data-size="default"')
    expect(component.css).toContain('.sb-root[data-variant="default"] { background-color: var(--primary); }')
    expect(component.css).toContain('.sb-root[data-variant="outline"] { border-width: 1px; }')
    expect(component.css).toContain('.sb-root[data-size="default"] { height: 2.25rem; }')
    expect(component.css).toContain('.sb-root[data-size="sm"] { height: 2rem; }')
  })

  it('keeps hover-only rules, drops the touch layout, and puts dark on Doop’s switch', () => {
    expect(component.css).toContain(String.raw`.hover\:underline:hover { text-decoration-line: underline; }`)
    expect(component.css).not.toContain('display: block')
    expect(component.css).toContain(
      String.raw`[data-doop-theme="dark"] .dark\:bg-input\/30 { background-color: var(--input); }`,
    )
  })

  it('makes theme colours tokens with their dark value, and keeps the rest on the root', () => {
    expect(kit.tokens).toEqual([
      { name: '--primary', type: 'color', value: 'oklch(0.2 0 0)', themes: { dark: 'oklch(0.9 0 0)' } },
      { name: '--input', type: 'color', value: '#e5e5e5' },
    ])
    expect(component.css).toMatch(/^:where\(\.sb-root\) \{ --ring-offset: 2px;/)
    expect(component.css).toContain('.sb-root { font-family: Inter, sans-serif; }')
    expect(component.css).toContain('[data-doop-theme="dark"] :where(.sb-root) { --ring-offset: 3px; }')
  })

  it('is CSS Doop reads to the end and keeps whole', () => {
    expect(unreadCss(component.css)).toBeNull()
    const main = mainOf(component.html)
    expect(unmatchedSelectors(component.css, main, ['data-variant', 'data-size'])).toEqual([])
    const { rawCss } = extractComponentCss(component.css, main, 'cmp', ['data-variant', 'data-size'])
    expect(rawCss).toContain('width: 1rem')
    expect(rawCss).toContain('[data-doop-theme="dark"]')
    expect(rawCss).toContain('[data-variant="outline"]')
  })

  it('sizes its main to the story’s viewport when its CSS has width breakpoints', () => {
    expect(component.width).toBe(168)
    const responsive = capture()
    responsive.base.rules = [
      ...responsive.base.rules,
      '@media (min-width: 66rem) { .inline-flex { max-width: 46rem; } }',
    ]
    expect(buildKit([responsive]).components[0]!.width).toBe(1280)
  })

  it('hashes what it built, so an unchanged sync sends nothing', () => {
    expect(buildKit([capture()]).components[0]!.hash).toBe(component.hash)
    const changed = capture()
    changed.base.vars['--ring-offset'] = '4px'
    expect(buildKit([changed]).components[0]!.hash).not.toBe(component.hash)
  })

  it('says when a variant changes the markup, and keeps only its root’s classes', () => {
    const odd = capture()
    odd.variants[0]!.capture!.html = `<button class="${CLASSES} border bg-transparent"><span class="label">Click me</span></button>`
    const built = buildKit([odd]).components[0]!
    expect(built.notes.join('\n')).toContain('variant=outline changes the markup')
    expect(built.css).toContain('.sb-root[data-variant="outline"] { border-width: 1px; }')
  })

  it('carries token and local variables referenced only by a variant', () => {
    const input = capture()
    const variant = input.variants[0]!.capture!
    variant.vars = { '--outline-color': '#013355', '--outline-width': '2px' }
    variant.rules.push('.border { border: var(--outline-width) solid var(--outline-color); }')
    const kit = buildKit([input])
    expect(kit.tokens).toContainEqual({ name: '--outline-color', type: 'color', value: '#013355' })
    expect(kit.components[0]!.css).toContain('--outline-width: 2px')
  })

  it('reports attributes a CSS variant cannot reproduce', () => {
    const input = capture()
    const variant = input.variants[0]!.capture!
    variant.html = variant.html.replace('<button ', '<button disabled ')
    expect(buildKit([input]).components[0]!.notes.join(' ')).toContain('variant=outline changes the markup')
  })

  it('keeps viewport conditions when a pointer query also names a breakpoint', () => {
    const query = '@media (hover: hover) and (min-width: 900px)'
    expect(cleanRules([`${query} { .button { padding: 8px; } }`])[0]).toContain(query)
  })

  it('marks a descendant whose classes a prop decides', () => {
    const nested = capture()
    nested.variants[1]!.capture!.html = button('bg-primary').replace('class="label"', 'class="label text-sm"')
    nested.base.rules = [...nested.base.rules, '.text-sm { font-size: 0.875rem; }']
    const built = buildKit([nested]).components[0]!
    expect(built.html).toContain('class="label sb-v1"')
    expect(built.css).toContain('.sb-v1:is(.sb-root[data-size="sm"] *) { font-size: 0.875rem; }')
  })
})

describe('a story that draws a component several times', () => {
  it('marks every copy with its class’s one marker, so rules do not multiply', () => {
    const tags = (size: string) =>
      `<div class="group">${Array.from({ length: 12 }, () => `<span class="tag ${size} red">x</span>`).join('')}</div>`
    const rules = ['.tag { padding: 4px; }', '.tag--md.red { height: 24px; }', '.tag--lg.red { height: 32px; }']
    const shot = (html: string) => ({
      html,
      rules,
      vars: {},
      fontFaces: [],
      text: {},
      width: 400,
      height: 40,
      warnings: [],
    })
    const group: ComponentCapture = {
      title: 'Tag',
      name: 'Tag',
      storyId: 'tag--default',
      props: [{ name: 'size', arg: 'size', kind: 'enum', options: ['md', 'lg'], values: ['md', 'lg'], default: 'md' }],
      texts: [],
      base: shot(tags('tag--md')),
      variants: [{ prop: 'size', value: 'lg', capture: shot(tags('tag--lg')) }],
      warnings: [],
    }
    const built = buildKit([group]).components[0]!
    expect(built.css).toContain('.sb-v1:is(.sb-root[data-size="md"] *).red { height: 24px; }')
    expect(built.css).toContain('.sb-v2:is(.sb-root[data-size="lg"] *).red { height: 32px; }')
    expect(built.css.length).toBeLessThan(1000)
    expect(built.html.match(/sb-v1/g)).toHaveLength(12)
  })
})

describe('the pieces', () => {
  it('escapes class names as the CSSOM does', () => {
    expect(cssEscape('hover:bg-primary/90')).toBe(String.raw`hover\:bg-primary\/90`)
    expect(cssEscape('2xl:p-4')).toBe(String.raw`\32 xl\:p-4`)
    expect(cssEscape(`[&_svg]:size-4`)).toBe(String.raw`\[\&_svg\]\:size-4`)
  })

  it('moves every form of dark onto Doop’s theme switch', () => {
    expect(darkSelector('.x:is(.dark *)')).toBe('[data-doop-theme="dark"] .x')
    expect(darkSelector('.dark .x')).toBe('[data-doop-theme="dark"] .x')
    expect(darkSelector('html.dark .x > .y')).toBe('[data-doop-theme="dark"] .x > .y')
    expect(darkSelector('.x:where(.dark, .dark *)')).toBe('[data-doop-theme="dark"] .x')
    expect(darkSelector('[data-theme="dark"] .x')).toBe('[data-doop-theme="dark"] .x')
    expect(darkSelector('.x')).toBe('.x')
  })

  it('unwraps Tailwind’s property defaults and trims them to the ones used', () => {
    const rules = cleanRules([
      '@supports ((-webkit-hyphens: none) and (not (margin-trim: inline))) { *, ::before, ::after { --tw-shadow: 0 0 #0000; --tw-ring-color: red; } }',
      '.shadow { box-shadow: var(--tw-shadow); }',
    ])
    expect(rules[0]).toBe('*, ::before, ::after { --tw-shadow: 0 0 #0000; }')
  })

  it('tells tokens from the rest', () => {
    expect(tokenType('--primary', 'oklch(0.2 0 0)')).toBe('color')
    expect(tokenType('--radius', '0.625rem')).toBe('radius')
    expect(tokenType('--font-sans', '"Inter", sans-serif')).toBe('fontFamily')
    expect(tokenType('--primary', '222 47% 11%')).toBeNull()
    expect(tokenType('--tw-ring-color', '#fff')).toBeNull()
    expect(kitTokens([capture(), capture()])).toHaveLength(2)
  })

  it('names props as <doop-use> attributes', () => {
    const taken = new Set<string>()
    expect(propName('buttonText', taken)).toBe('button-text')
    expect(propName('class', taken)).toBe('class-prop')
    expect(propName('buttonText', taken)).toBe('button-text-2')
    expect(propName('_private', taken)).toBe('private')
  })
})
