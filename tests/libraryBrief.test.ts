import { expect, it, vi } from 'vitest'

/* the library writes through drizzle; here every query is a resolved no-op */
vi.mock('../server/db/index.ts', () => {
  const chain: unknown = new Proxy(() => chain, {
    get: (_target, key) => (key === 'then' ? (resolve: (v: unknown) => void) => resolve([]) : chain),
    apply: () => chain,
  })
  return { db: chain }
})

const library = await import('../server/library.ts')

it('keeps the design-system brief bounded and points the agent at get_component for the rest', () => {
  const scope = 'canvas:brief-test' as const
  const markup = (n: number) => `<section class="block-${n}">${'<p>Row of a long listing</p>'.repeat(60)}</section>`
  for (let n = 0; n < 40; n++) {
    library.saveComponent(
      scope,
      { name: `Block ${n}`, slug: `block-${n}`, groupId: 'layout', description: 'A long block', html: markup(n) },
      'Tester',
    )
  }
  const brief = library.designSystemBrief(scope)
  const everything = 40 * markup(0).length
  expect(everything).toBeGreaterThan(library.BRIEF_MARKUP_BUDGET * 3)
  expect(brief.length).toBeLessThan(library.BRIEF_MARKUP_BUDGET + 10_000)
  /* every component is still listed by name, the ones past the budget without markup */
  for (let n = 0; n < 40; n++) expect(brief).toContain(`(\`block-${n}\``)
  expect(brief).toContain('call get_component with slug "block-39"')
  expect(brief).toContain('<section class="block-0"')
  expect(brief).not.toContain('<section class="block-39"')
})

it('renames a component together with the selectors and instances that name it', () => {
  const scope = 'canvas:rename-test' as const
  library.saveComponent(
    scope,
    {
      name: 'Button',
      slug: 'button',
      groupId: 'buttons',
      html: '<button>Go</button>',
      css: '[data-doop-component="button"] { color: red; }',
      js: 'document.querySelectorAll(\'[data-doop-component="button"]\')',
    },
    'Tester',
  )
  library.saveComponent(
    scope,
    {
      name: 'Toolbar',
      slug: 'toolbar',
      groupId: 'layout',
      html: '<div><button data-doop-component="button">Go</button></div>',
      css: '[data-doop-component="toolbar"] [data-doop-component="button"] { margin: 0; }',
    },
    'Tester',
  )
  const existing = library.findComponent(scope, 'button')!
  const { component, renamedFrom } = library.saveComponent(scope, { slug: 'action' }, 'Tester', existing.id)
  expect(renamedFrom).toBe('button')
  expect(component.css).toBe('[data-doop-component="action"] { color: red; }')
  expect(component.js).toContain('[data-doop-component="action"]')
  const toolbar = library.findComponent(scope, 'toolbar')!
  expect(toolbar.html).toContain('data-doop-component="action"')
  expect(toolbar.css).toContain('[data-doop-component="action"]')
  expect(toolbar.css).not.toContain('"button"')
})
