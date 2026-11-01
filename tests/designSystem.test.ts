import { describe, expect, it } from 'vitest'
import {
  PRESET_GROUPS,
  componentSlugsIn,
  cssTokens,
  ensureInstanceAttribute,
  libraryScopeOf,
  renameInstances,
  slugify,
  stampLibrary,
  type StampSource,
} from '../shared/designSystem.ts'
import { presetFor } from '../shared/componentPresets.ts'

const source = (overrides: Partial<StampSource> = {}): StampSource => ({
  initialized: true,
  globalCss: ':root { --color-primary: #2743ee; --space-2: 8px; }',
  components: new Map([
    ['button', { css: '.button { color: var(--color-primary); }', js: '' }],
    ['tabs', { css: '.tabs { display: flex; }', js: 'elements.forEach(function (el) { el.dataset.ready = "1" })' }],
  ]),
  ...overrides,
})

const page = (body: string) => `<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`

describe('stampLibrary', () => {
  it('leaves documents that use nothing from the library untouched', () => {
    const html = page('<h1 style="color: red">Hi</h1>')
    expect(stampLibrary(html, source())).toBe(html)
  })

  it('stamps the tokens and the CSS of each component used, first in <head>', () => {
    const stamped = stampLibrary(page('<button class="button" data-doop-component="button">Go</button>'), source())
    expect(stamped).toContain('<style data-doop-library="tokens">')
    expect(stamped).toContain('<style data-doop-library="css:button">')
    expect(stamped).not.toContain('css:tabs')
    expect(stamped.indexOf('data-doop-library="tokens"')).toBeLessThan(stamped.indexOf('<title>'))
  })

  it('wraps component JS so it runs once with every instance', () => {
    const stamped = stampLibrary(page('<div data-doop-component="tabs"></div>'), source())
    expect(stamped).toContain('<script data-doop-library="js:tabs">')
    expect(stamped).toContain('document.querySelectorAll("[data-doop-component=\\"tabs\\"]")')
  })

  it('is idempotent and returns the same string when nothing changed', () => {
    const once = stampLibrary(page('<button data-doop-component="button">Go</button>'), source())
    expect(stampLibrary(once, source())).toBe(once)
  })

  it('follows library edits and drops blocks of components no longer used', () => {
    const once = stampLibrary(page('<button data-doop-component="button">Go</button>'), source())
    const edited = source({ components: new Map([['button', { css: '.button { color: hotpink; }', js: '' }]]) })
    const again = stampLibrary(once, edited)
    expect(again).toContain('hotpink')
    expect(again.match(/data-doop-library="css:button"/g)).toHaveLength(1)

    const removed = stampLibrary(again.replace(' data-doop-component="button"', ''), edited)
    expect(removed).not.toContain('data-doop-library')
  })

  it('keeps the carried block of a component the library no longer has', () => {
    const once = stampLibrary(page('<button data-doop-component="button">Go</button>'), source())
    const kept = stampLibrary(once, source({ components: new Map() }))
    expect(kept).toContain('<style data-doop-library="css:button">')
    expect(kept).toContain('.button { color: var(--color-primary); }')
  })

  it('stamps the tokens alone when a frame only reads a defined token', () => {
    const stamped = stampLibrary(page('<p style="padding: var(--space-2)">x</p>'), source())
    expect(stamped).toContain('data-doop-library="tokens"')
    expect(stampLibrary(page('<p style="padding: var(--other)">x</p>'), source())).not.toContain('data-doop-library')
  })

  it('does not stamp tokens for a scope without a library', () => {
    const html = page('<p style="padding: var(--space-2)">x</p>')
    expect(stampLibrary(html, source({ initialized: false }))).toBe(html)
  })

  it('handles fragments without a head', () => {
    const stamped = stampLibrary('<button data-doop-component="button">Go</button>', source())
    expect(stamped.startsWith('<style data-doop-library="tokens">')).toBe(true)
  })

  it('cannot be broken out of by a closing tag inside the CSS or JS', () => {
    const hostile = source({
      components: new Map([['x', { css: 'a{}</style><b>css</b>', js: '"</script><b>js</b>"' }]]),
    })
    const stamped = stampLibrary(page('<i data-doop-component="x"></i>'), hostile)
    expect(stamped).not.toContain('</style><b>css')
    expect(stamped).not.toContain('</script><b>js')
    expect(stamped.match(/<\/script>/g)).toHaveLength(1)
  })
})

describe('library helpers', () => {
  it('names the scope a canvas draws from', () => {
    expect(libraryScopeOf({ id: 'c', ownerId: 'u', workspaceId: 'w' })).toBe('workspace:w')
    expect(libraryScopeOf({ id: 'c', ownerId: 'u' })).toBe('user:u')
    expect(libraryScopeOf({ id: 'c' })).toBe('canvas:c')
  })

  it('reads tokens, slugs and instance attributes', () => {
    expect(cssTokens('/* --nope: 1 */ :root { --a: 1px; --b: red } .x { --a: 2px }')).toEqual([
      { name: '--a', value: '2px' },
      { name: '--b', value: 'red' },
    ])
    expect([...componentSlugsIn('<a data-doop-component="link"><b data-doop-component=\'badge\'>')]).toEqual([
      'link',
      'badge',
    ])
    expect(slugify('ToggleButtonGroup')).toBe('toggle-button-group')
    expect(slugify('  Pricing card 2 ')).toBe('pricing-card-2')
  })

  it('marks the root of markup as an instance, replacing another slug', () => {
    expect(ensureInstanceAttribute('<button class="b">Go</button>', 'button')).toBe(
      '<button class="b" data-doop-component="button">Go</button>',
    )
    expect(ensureInstanceAttribute('<input class="i" />', 'input')).toBe(
      '<input class="i" data-doop-component="input" />',
    )
    expect(ensureInstanceAttribute('<div data-doop-component="old">x</div>', 'new')).toBe(
      '<div data-doop-component="new">x</div>',
    )
    const already = '<div><span data-doop-component="chip"></span></div>'
    expect(ensureInstanceAttribute(already, 'chip')).toBe(already)
  })

  it('renames instances without touching longer slugs', () => {
    expect(
      renameInstances('<a data-doop-component="btn"></a><a data-doop-component="btn-x"></a>', 'btn', 'button'),
    ).toBe('<a data-doop-component="button"></a><a data-doop-component="btn-x"></a>')
  })

  it('has a ready-made starter for every preset kind', () => {
    for (const group of PRESET_GROUPS) {
      for (const kind of group.kinds) {
        const preset = presetFor(kind, slugify(kind))
        expect(preset.description, kind).not.toBe('')
        expect(componentSlugsIn(preset.html).has(slugify(kind)), kind).toBe(true)
        expect(preset.html + preset.css, kind).not.toContain('{{s}}')
      }
    }
  })
})
