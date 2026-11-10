import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveToken: () => {},
  deleteToken: () => {},
}))

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import { blankComponent, contextFor } from '../server/components.ts'
import { compactDocument } from '../server/componentEngine.ts'
import {
  changeInstances,
  compactFrameHtml,
  createComponentFromElement,
  deleteComponent,
  facesToCarry,
  importComponent,
  restoreComponentVersion,
  syncComponent,
  updateComponent,
  validProps,
  withCarriedFaces,
} from '../server/componentActions.ts'
import { COMPONENT_ATTR, HEAD_ATTR, INSTANCE_ATTR, MAX_COMPONENT_NAME, OVERRIDES_ATTR } from '../shared/components.ts'
import type { CustomFont } from '../shared/fonts.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '', head = '') =>
  `<!doctype html><html><head>${head}<style>${css}</style></head><body>${body}</body></html>`

function makeComponent(
  canvasId: string,
  name: string,
  markup: (id: string) => string,
  css = '',
  props: Parameters<typeof blankComponent>[0]['props'] = [],
  head = '',
) {
  const def = blankComponent({ name, by: 'Tester', props })
  store.saveComponent(canvasId, def)
  const frame = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, actor)!
  actions.updateFrame(frame.id, { html: doc(markup(def.id), css, head) }, actor)
  return { def, frame }
}

const nestedCard = (frameId: string) =>
  new RegExp(
    `<div[^>]*class="card"[^>]*${INSTANCE_ATTR}="([^"]+)"|<div[^>]*${INSTANCE_ATTR}="([^"]+)"[^>]*class="card"`,
  )
    .exec(store.getFrame(frameId)!.html)!
    .slice(1)
    .find(Boolean)!

const ids = (html: string) => [...html.matchAll(/data-doop-id="([^"]+)"/g)].map((match) => match[1]!)
const instanceIdOf = (html: string, componentId: string) =>
  new RegExp(`<[^>]*${INSTANCE_ATTR}="${componentId}"[^>]*>`).exec(html)![0].match(/data-doop-id="([^"]+)"/)![1]!

describe('components edge cases', () => {
  let canvasId: string
  beforeEach(() => {
    canvasId = store.createCanvas('review').id
  })

  function makeFrame(body: string) {
    const frame = actions.createFrame(canvasId, { name: 'Source', html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(body) }, actor)
    return frame.id
  }

  /** A Card holding a Button: the shape nested findings need. */
  function nested() {
    const button = makeComponent(
      canvasId,
      'Button',
      (id) => `<button class="btn" ${COMPONENT_ATTR}="${id}"><span data-doop-prop="label">Buy</span></button>`,
      '.btn { color: red }',
    )
    const card = makeComponent(
      canvasId,
      'Card',
      (id) =>
        `<div class="card" ${COMPONENT_ATTR}="${id}"><h2>Title</h2><doop-use component="${button.def.id}"></doop-use></div>`,
      '.card { padding: 8px }',
    )
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(`<doop-use component="${card.def.id}"></doop-use>`) }, actor)
    return { button, card, page }
  }

  it('a detached instance keeps its look', () => {
    const { def } = makeComponent(
      canvasId,
      'Pill',
      (id) => `<div class="pill" ${COMPONENT_ATTR}="${id}">Hi</div>`,
      '.pill { color: red }',
    )
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(`<doop-use component="${def.id}"></doop-use>`) }, actor)
    const id = instanceIdOf(store.getFrame(page.id)!.html, def.id)
    changeInstances(canvasId, page.id, [{ instanceId: id, detach: true }], actor)
    const html = store.getFrame(page.id)!.html
    expect(html).not.toContain(` ${INSTANCE_ATTR}=`)
    const [, selector] = /([^\n{]*\.pill[^{]*)\{\s*color: red/.exec(html) ?? []
    expect(selector).toBeTruthy()
    const marker = /\[([\w-]+)="([^"]+)"\]/.exec(selector!)!
    expect(html).toMatch(new RegExp(`<div[^>]* ${marker[1]}="${marker[2]}"`))
    /* a later write must not sweep it away */
    actions.updateFrame(page.id, { html: `${store.getFrame(page.id)!.html} ` }, actor)
    expect(store.getFrame(page.id)!.html).toContain('color: red')
  })

  it('an instance of a deleted component keeps its look', () => {
    const { def } = makeComponent(
      canvasId,
      'Pill',
      (id) => `<div class="pill" ${COMPONENT_ATTR}="${id}">Hi</div>`,
      '.pill { color: red }',
    )
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(`<doop-use component="${def.id}"></doop-use>`) }, actor)
    deleteComponent(canvasId, def.id, actor)
    const html = store.getFrame(page.id)!.html
    expect(html).not.toContain(` ${INSTANCE_ATTR}=`)
    const [, selector] = /([^\n{]*\.pill[^{]*)\{\s*color: red/.exec(html) ?? []
    expect(selector).toBeTruthy()
    const marker = /\[([\w-]+)="([^"]+)"\]/.exec(selector!)!
    expect(html).toMatch(new RegExp(`<div[^>]* ${marker[1]}="${marker[2]}"`))
  })

  it('keeps enum variant rules when the main does not wear the attribute', () => {
    const { def } = makeComponent(
      canvasId,
      'Tag',
      (id) => `<span class="tag" ${COMPONENT_ATTR}="${id}">Hi</span>`,
      '.tag { color: black } .tag[data-tone="ghost"] { color: gray }',
      [{ name: 'tone', type: 'enum', options: ['solid', 'ghost'], default: 'solid' }],
    )
    const saved = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(saved.css).toContain('color: gray')
  })

  it('edits a nested instance from its own id', () => {
    const { button, page } = nested()
    const id = instanceIdOf(store.getFrame(page.id)!.html, button.def.id)
    const { missing } = changeInstances(canvasId, page.id, [{ instanceId: id, props: { label: 'Pay' } }], actor)
    expect(missing).toEqual([])
    expect(store.getFrame(page.id)!.html).toContain('Pay')
    expect(store.getFrame(page.id)!.html).toContain(`data-doop-id="${id}"`)
  })

  it('detaches a nested instance from its own id', () => {
    const { button, page } = nested()
    const id = instanceIdOf(store.getFrame(page.id)!.html, button.def.id)
    const card = nestedCard(page.id)
    const { missing } = changeInstances(canvasId, page.id, [{ instanceId: id, detach: true }], actor)
    expect(missing).toEqual([])
    const html = store.getFrame(page.id)!.html
    /* only that link is cut: the card around it stays an instance, and the button keeps its look */
    expect(html).toContain(`${INSTANCE_ATTR}="${card}"`)
    expect(html).not.toContain(` ${INSTANCE_ATTR}="${button.def.id}"`)
    expect(html).toMatch(/data-doop-detached-from="[^"]+"/)
    expect(html).toContain('color: red')
  })

  it('keeps nested instance ids across saves, and an unchanged save writes nothing', () => {
    const { page } = nested()
    const before = store.getFrame(page.id)!.html
    actions.updateFrame(page.id, { html: before }, actor)
    expect(ids(store.getFrame(page.id)!.html)).toEqual(ids(before))
    expect(store.getFrame(page.id)!.html).toBe(before)
    const compact = compactFrameHtml(store.getFrame(page.id)!)
    actions.updateFrame(page.id, { html: compact }, actor)
    expect(ids(store.getFrame(page.id)!.html).sort()).toEqual(ids(before).sort())
  })

  it('reads back a slot on the root of a component', () => {
    const { def } = makeComponent(
      canvasId,
      'Box',
      (id) => `<div class="box" data-doop-slot="content" ${COMPONENT_ATTR}="${id}"></div>`,
    )
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(`<doop-use component="${def.id}"><p>Custom</p></doop-use>`) }, actor)
    const frame = store.getFrame(page.id)!
    expect(frame.html).toContain('<p>Custom</p>')
    expect(compactDocument(frame.html, contextFor(canvasId))).toContain('<p>Custom</p>')
    actions.updateFrame(page.id, { html: compactFrameHtml(frame) }, actor)
    expect(store.getFrame(page.id)!.html).toContain('<p>Custom</p>')
    const id = instanceIdOf(store.getFrame(page.id)!.html, def.id)
    changeInstances(canvasId, page.id, [{ instanceId: id, overrides: {} }], actor)
    expect(store.getFrame(page.id)!.html).toContain('<p>Custom</p>')
  })

  const revOf = (id: string) => store.getComponents(canvasId).find((candidate) => candidate.id === id)!.rev
  const html = (frameId: string) => store.getFrame(frameId)!.html

  it('a <style> inside the main does not turn an unchanged save into an override', () => {
    const { def, frame } = makeComponent(
      canvasId,
      'Hero',
      (id) => `<section ${COMPONENT_ATTR}="${id}"><style>.t { color: red }</style><h1 class="t">Hi</h1></section>`,
    )
    const page = makeFrame(`<doop-use component="${def.id}"></doop-use>`)
    expect(html(page)).not.toContain(OVERRIDES_ATTR)
    const before = html(page)
    actions.updateFrame(page, { html: before }, actor)
    expect(html(page)).toBe(before)
    /* and the main still reaches it */
    actions.updateFrame(frame.id, { html: html(frame.id).replace('>Hi<', '>Bye<') }, actor)
    expect(html(page)).toContain('Bye')
  })

  it('keeps an instance of a component placed in its own slot', () => {
    const { def } = makeComponent(
      canvasId,
      'Box',
      (id) => `<div class="box" ${COMPONENT_ATTR}="${id}"><div data-doop-slot="">Empty</div></div>`,
    )
    const page = makeFrame(
      `<doop-use component="${def.id}"><doop-use component="${def.id}"><p>Inner</p></doop-use></doop-use>`,
    )
    expect(html(page).match(new RegExp(` ${INSTANCE_ATTR}="${def.id}"`, 'g'))).toHaveLength(2)
    expect(html(page)).toContain('<p>Inner</p>')
    expect(actions.takeComponentIssues(page)).toEqual([])
    /* and a later save keeps both */
    actions.updateFrame(page, { html: html(page) }, actor)
    expect(html(page).match(new RegExp(` ${INSTANCE_ATTR}="${def.id}"`, 'g'))).toHaveLength(2)
  })

  it('leaves token values to the token block, and a byte-identical main save is no revision', () => {
    actions.createTokens(canvasId, [{ name: '--brand', type: 'color', value: 'red' }], actor)
    const { def, frame } = makeComponent(
      canvasId,
      'Btn',
      (id) => `<button class="btn" ${COMPONENT_ATTR}="${id}">Buy</button>`,
      '.btn { color: var(--brand) }',
    )
    /* the token and font blocks landed after the first pass: the second save sees them */
    expect(html(frame.id)).toContain('data-doop-tokens')
    actions.updateFrame(frame.id, { html: html(frame.id) }, actor)
    expect(revOf(def.id)).toBe(1)
    const page = makeFrame(`<doop-use component="${def.id}"></doop-use>`)
    expect(html(page)).not.toMatch(/data-doop-component-css[\s\S]*?--brand: red/)
    actions.setTokens(canvasId, [{ name: '--brand', value: 'blue' }], actor)
    expect(html(page)).toMatch(/data-doop-tokens[\s\S]*?--brand:\s*blue/)
    expect(html(page)).not.toContain('red')
  })

  it('an edit inside a nested instance of the main reaches the instances in the same write', () => {
    const button = makeComponent(
      canvasId,
      'Button',
      (id) => `<button ${COMPONENT_ATTR}="${id}"><span data-doop-prop="label">Buy</span></button>`,
    )
    const card = makeComponent(
      canvasId,
      'Card',
      (id) =>
        `<div class="card" ${COMPONENT_ATTR}="${id}"><doop-use component="${button.def.id}" label="Go"></doop-use></div>`,
    )
    const page = makeFrame(`<doop-use component="${card.def.id}"></doop-use>`)
    expect(html(page)).toContain('Go')
    actions.updateFrame(card.frame.id, { html: html(card.frame.id).replace('>Go<', '>Stop<') }, actor)
    expect(html(page)).toContain('Stop')
    expect(html(page)).not.toContain('>Go<')
  })

  it('a null part override is no override, not an error', () => {
    const { def } = makeComponent(
      canvasId,
      'Btn',
      (id) => `<button ${COMPONENT_ATTR}="${id}"><span data-doop-prop="label">Buy</span></button>`,
    )
    const page = makeFrame(`<doop-use component="${def.id}" overrides='{"icon": null}'></doop-use>`)
    expect(html(page)).toContain(` ${INSTANCE_ATTR}="${def.id}"`)
    expect(html(page)).toContain('Buy')
    expect(html(page)).not.toContain(OVERRIDES_ATTR)
  })

  it('a head tag another component brought is not the main’s own', () => {
    const link = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'
    const a = makeComponent(canvasId, 'A', (id) => `<i class="a" ${COMPONENT_ATTR}="${id}">a</i>`, '', [], link)
    const b = makeComponent(canvasId, 'B', (id) => `<b class="b" ${COMPONENT_ATTR}="${id}">b</b>`)
    actions.updateFrame(
      b.frame.id,
      { html: html(b.frame.id).replace('</body>', `<doop-use component="${a.def.id}"></doop-use></body>`) },
      actor,
    )
    expect(html(b.frame.id)).toContain(`<link ${HEAD_ATTR} rel="stylesheet"`)
    expect(html(b.frame.id).match(/<link/g)).toHaveLength(1)
    const before = html(b.frame.id)
    actions.updateFrame(b.frame.id, { html: before }, actor)
    expect(revOf(b.def.id)).toBe(1)
    expect(store.getComponents(canvasId).find((candidate) => candidate.id === b.def.id)!.head).toEqual([])
    expect(html(b.frame.id)).toBe(before)
    /* agents never see the brought tag */
    expect(compactDocument(before, contextFor(canvasId))).not.toContain(HEAD_ATTR)
  })

  it('keeps a part rendered as another tag', () => {
    const { def, frame } = makeComponent(
      canvasId,
      'Action',
      (id) => `<div ${COMPONENT_ATTR}="${id}"><button class="cta">Go</button></div>`,
    )
    const page = makeFrame(`<doop-use component="${def.id}"></doop-use>`)
    const changed = html(page).replace(/<button class="cta"([^>]*)>Go<\/button>/, '<a class="cta"$1 href="/go">Go</a>')
    expect(changed).not.toBe(html(page))
    actions.updateFrame(page, { html: changed }, actor)
    expect(html(page)).toMatch(/<a class="cta"[^>]*href="\/go"[^>]*>Go<\/a>/)
    expect(html(page)).not.toContain('<button')
    actions.updateFrame(page, { html: html(page) }, actor)
    expect(html(page)).toMatch(/<a class="cta"[^>]*>Go<\/a>/)
    /* the main's own text still flows through */
    actions.updateFrame(frame.id, { html: html(frame.id).replace('>Go<', '>Run<') }, actor)
    expect(html(page)).toMatch(/<a class="cta"[^>]*>Run<\/a>/)
  })

  describe('library sync', () => {
    function library() {
      const source = store.createCanvas('library').id
      const lib = makeComponent(
        source,
        'Card',
        (id) => `<div class="card" ${COMPONENT_ATTR}="${id}"><h2>Title</h2></div>`,
        '.card { padding: 8px }',
      )
      importComponent(canvasId, source, lib.def.id, actor)
      return { source, lib }
    }

    it('keeps a long imported name apart from the one already here', () => {
      const long = 'N'.repeat(MAX_COMPONENT_NAME)
      makeComponent(canvasId, long, (id) => `<i ${COMPONENT_ATTR}="${id}">here</i>`)
      const source = store.createCanvas('library').id
      const theirs = makeComponent(source, long, (id) => `<i ${COMPONENT_ATTR}="${id}">theirs</i>`)
      importComponent(canvasId, source, theirs.def.id, actor)
      const names = store.getComponents(canvasId).map((def) => def.name)
      expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length)
      const imported = store.getComponents(canvasId).find((def) => def.id === theirs.def.id)!
      expect(imported.name.length).toBeLessThanOrEqual(MAX_COMPONENT_NAME)
      expect(imported.name).toMatch(/\(library\)$/)
    })

    it('carries the faces of fonts only the library canvas has', () => {
      const face = (family: string): CustomFont => ({
        id: family,
        family,
        weight: '400',
        style: 'normal',
        format: 'woff2',
        url: `/a/${family}.woff2`,
        size: 1,
        fileName: `${family}.woff2`,
        createdAt: 1,
      })
      const origin = {
        template: '<h1 style="font-family: Inter Display">Hi</h1>',
        rawCss: '.x { font-family: "Mono Lib" }',
      }
      const carried = facesToCarry(
        origin,
        [face('Inter Display'), face('Mono Lib'), face('Unused')],
        [face('Mono Lib')],
      )
      expect(carried).toContain('Inter Display')
      expect(carried).not.toContain('Mono Lib')
      expect(carried).not.toContain('Unused')
      expect(facesToCarry(origin, [], [])).toBe('')
    })

    it('places carried faces after the sheet’s imports and before its own rules', () => {
      const face = '@font-face { font-family: "Inter Display"; src: url(/a/x.woff2) }'
      const css =
        "@charset \"utf-8\";\n@import url('https://fonts.example/x.css');\n.x { font-family: 'Inter Display' }"
      const out = withCarriedFaces(css, face)
      expect(out.indexOf('@import')).toBeLessThan(out.indexOf('@font-face'))
      expect(out.indexOf('@font-face')).toBeLessThan(out.indexOf('.x {'))
      expect(withCarriedFaces('.x { color: red }', face).startsWith('@font-face')).toBe(true)
      expect(withCarriedFaces(css, '')).toBe(css)
    })

    it('brings in a component the library added inside this one', () => {
      const { source, lib } = library()
      const badge = makeComponent(
        source,
        'Badge',
        (id) => `<b class="badge" ${COMPONENT_ATTR}="${id}">New</b>`,
        '.badge { color: green }',
      )
      updateComponent(
        source,
        lib.def.id,
        { html: `<div class="card"><h2>Title</h2><doop-use component="${badge.def.id}"></doop-use></div>` },
        actor,
      )
      const { updated } = syncComponent(canvasId, lib.def.id, actor, () => true)
      expect(updated).toBe(true)
      expect(store.getComponents(canvasId).some((candidate) => candidate.id === badge.def.id)).toBe(true)
      const local = store.getComponents(canvasId).find((candidate) => candidate.id === lib.def.id)!
      expect(local.template).toContain(badge.def.id)
    })

    it('notices a change that only a nested library component made', () => {
      const source = store.createCanvas('library').id
      const badge = makeComponent(source, 'Badge', (id) => `<b ${COMPONENT_ATTR}="${id}">New</b>`)
      const card = makeComponent(
        source,
        'Card',
        (id) => `<div ${COMPONENT_ATTR}="${id}"><doop-use component="${badge.def.id}"></doop-use></div>`,
      )
      importComponent(canvasId, source, card.def.id, actor)
      updateComponent(source, badge.def.id, { html: `<b>Newer</b>` }, actor)
      const { updated } = syncComponent(canvasId, card.def.id, actor, () => true)
      expect(updated).toBe(true)
      const local = store.getComponents(canvasId).find((candidate) => candidate.id === badge.def.id)!
      expect(local.template).toContain('Newer')
    })

    it('carries the library’s fonts', () => {
      const source = store.createCanvas('library').id
      const oldFont = '<link rel="stylesheet" href="https://fonts.example/old.css">'
      const newFont = '<link rel="stylesheet" href="https://fonts.example/new.css">'
      const lib = makeComponent(
        source,
        'Card',
        (id) => `<div class="card" ${COMPONENT_ATTR}="${id}">Hi</div>`,
        '.card { color: red }',
        [],
        oldFont,
      )
      importComponent(canvasId, source, lib.def.id, actor)
      const sourceHtml = store.getFrame(lib.frame.id)!.html
      actions.updateFrame(
        lib.frame.id,
        { html: sourceHtml.replace(oldFont, newFont).replace('>Hi<', '>Hello<') },
        actor,
      )
      syncComponent(canvasId, lib.def.id, actor, () => true)
      const local = store.getComponents(canvasId).find((candidate) => candidate.id === lib.def.id)!
      expect(local.head.join('')).toContain('new.css')
    })
  })

  it.each(['id', 'component', 'class', 'style', 'overrides', 'slot', 'data-doop-part'])(
    'refuses a prop called %s, which <doop-use> keeps for itself',
    (name) => {
      expect(() => validProps([{ name, type: 'text' }])).toThrow()
    },
  )

  it('does not infer a prop from a class that would collide with <doop-use>', () => {
    const created = createComponentFromElement(
      canvasId,
      { name: 'Reserved', frameId: makeFrame(`<p class="id">Hello</p>`), element: 'p' },
      actor,
    )
    expect(created.component.props.map((prop) => prop.name)).not.toContain('id')
  })

  it('keeps a boolean default when the prop is also bound to an attribute', () => {
    const { def } = makeComponent(
      canvasId,
      'Panel',
      (id) =>
        `<div ${COMPONENT_ATTR}="${id}" data-doop-prop="aria-expanded:open"><p data-doop-if="open">Body</p></div>`,
      '',
      [{ name: 'open', type: 'boolean', default: 'true' }],
    )
    const saved = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(saved.props.find((prop) => prop.name === 'open')?.default).toBe('true')
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(`<doop-use component="${def.id}"></doop-use>`) }, actor)
    expect(store.getFrame(page.id)!.html).toContain('Body')
  })

  it('takes a revision’s fonts back when it is restored', () => {
    const oldFont = '<link rel="stylesheet" href="https://fonts.example/old.css">'
    const newFont = '<link rel="stylesheet" href="https://fonts.example/new.css">'
    const { def, frame } = makeComponent(
      canvasId,
      'Card',
      (id) => `<div class="card" ${COMPONENT_ATTR}="${id}">One</div>`,
      '.card { color: red }',
      [],
      oldFont,
    )
    const first = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!.rev
    const html = store.getFrame(frame.id)!.html
    actions.updateFrame(frame.id, { html: html.replace(oldFont, newFont).replace('>One<', '>Two<') }, actor)
    restoreComponentVersion(canvasId, def.id, first, actor)
    const restored = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(restored.head.join('')).toContain('old.css')
    expect(restored.head.join('')).not.toContain('new.css')
  })

  it.each([
    ['hover:bg-red', String.raw`.hover\:bg-red:hover { color: red }`],
    ['md:flex', String.raw`@media (min-width: 1px) { .md\:flex { color: red } }`],
    ['w-1/2', String.raw`.w-1\/2 { color: red }`],
    ['[&>svg]:p-1', String.raw`.\[\&\>svg\]\:p-1 > svg { color: red }`],
    ['a,b', String.raw`.a\,b { color: red }`],
  ])('keeps the compiled utility rule for class %s, scoped so that it still matches', (name, css) => {
    const { def } = makeComponent(
      canvasId,
      `Util ${name}`,
      (id) => `<div class="${name}" ${COMPONENT_ATTR}="${id}">Hi<svg></svg></div>`,
      css,
    )
    const saved = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(saved.css).toContain('color: red')
    const selector = css
      .replace(/^@media[^{]*\{\s*/, '')
      .split('{')[0]!
      .trim()
      .split(/[\s:]/)[0]!
    expect(saved.css).toContain(`:where([${INSTANCE_ATTR}="${def.id}"]) ${selector}`)
    const compound = String.raw`.w-1\/2`
    if (name === 'w-1/2') expect(saved.css).toContain(`${compound}:where([${INSTANCE_ATTR}="${def.id}"])`)
  })

  it('gives each component its own keyframes, and the main’s stylesheet keeps the name it wrote', () => {
    const css = '@keyframes pulse { to { opacity: 0 } } .a { animation: pulse 1s infinite }'
    const a = makeComponent(canvasId, 'A', (id) => `<div class="a" ${COMPONENT_ATTR}="${id}">A</div>`, css)
    const b = makeComponent(canvasId, 'B', (id) => `<div class="a" ${COMPONENT_ATTR}="${id}">B</div>`, css)
    const saved = (id: string) => store.getComponents(canvasId).find((candidate) => candidate.id === id)!
    const named = (text: string) => /@keyframes\s+([^\s{]+)/.exec(text)![1]!
    expect(named(saved(a.def.id).css)).not.toBe(named(saved(b.def.id).css))
    expect(saved(a.def.id).css).toContain(`animation: ${named(saved(a.def.id).css)} 1s`)
    expect(saved(a.def.id).rawCss).toContain('@keyframes pulse')
  })

  it('keeps the whitespace around a slot’s content', () => {
    const { def } = makeComponent(
      canvasId,
      'Code',
      (id) => `<div ${COMPONENT_ATTR}="${id}"><code data-doop-slot="body"></code></div>`,
    )
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    const body = '  indented\n    code  '
    actions.updateFrame(
      page.id,
      { html: doc(`<doop-use component="${def.id}"><template slot="body">${body}</template></doop-use>`) },
      actor,
    )
    expect(store.getFrame(page.id)!.html).toContain(`>${body}</code>`)
    actions.updateFrame(page.id, { html: compactFrameHtml(store.getFrame(page.id)!) }, actor)
    expect(store.getFrame(page.id)!.html).toContain(`>${body}</code>`)
  })

  it('an idle stream still catches up on a component change', () => {
    const { def } = makeComponent(canvasId, 'Pill', (id) => `<div class="pill" ${COMPONENT_ATTR}="${id}">Old</div>`)
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.appendFrameHtml(page.id, doc(`<doop-use component="${def.id}"></doop-use>`), actor, { start: true })
    updateComponent(canvasId, def.id, { html: `<div class="pill">Fresh</div>` }, actor)
    expect(store.getFrame(page.id)!.html).not.toContain('Fresh')
    actions.expireIdleStreams(Date.now() + 60_000)
    expect(store.getFrame(page.id)!.html).toContain('Fresh')
  })
  it('carries the fonts and keyframes a main names in its own style attributes', () => {
    const css = '@font-face { font-family: Brand; src: url(/brand.woff2) } @keyframes pulse { to { opacity: 0 } }'
    const { def } = makeComponent(
      canvasId,
      'Badge',
      (id) => `<span ${COMPONENT_ATTR}="${id}" style="font-family: Brand; animation: pulse 1s infinite">New</span>`,
      css,
    )
    const saved = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(saved.css).toContain('@font-face')
    /* the instance's markup still says `pulse`, so that is the name its keyframes keep */
    expect(saved.css).toMatch(/@keyframes pulse\s*\{/)
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(`<doop-use component="${def.id}"></doop-use>`) }, actor)
    expect(html(page.id)).toContain('font-family: Brand; src: url(/brand.woff2)')
    expect(html(page.id)).toMatch(/@keyframes pulse\s*\{/)
  })

  it('a detached instance keeps the stylesheet links its component brought', () => {
    const link = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'
    const { def } = makeComponent(
      canvasId,
      'Pill',
      (id) => `<div class="pill" ${COMPONENT_ATTR}="${id}">Hi</div>`,
      '.pill { font-family: Inter }',
      [],
      link,
    )
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(`<doop-use component="${def.id}"></doop-use>`) }, actor)
    expect(html(page.id)).toContain(`<link ${HEAD_ATTR} rel="stylesheet"`)
    changeInstances(canvasId, page.id, [{ instanceId: instanceIdOf(html(page.id), def.id), detach: true }], actor)
    expect(html(page.id)).toContain(link)
    expect(html(page.id)).not.toContain(HEAD_ATTR)
    /* a later write must not sweep it away */
    actions.updateFrame(page.id, { html: `${html(page.id)} ` }, actor)
    expect(html(page.id).match(/<link/g)).toHaveLength(1)
  })

  it('refuses to import over a component a canvas copy shares, and writes nothing', () => {
    const { def } = makeComponent(
      canvasId,
      'Card',
      (id) => `<div class="card" ${COMPONENT_ATTR}="${id}">Original</div>`,
      '.card { color: red }',
    )
    /* a copy of this canvas: same component id, its own main, edited there */
    const copy = store.createCanvas('copy').id
    store.saveComponent(copy, { ...def, mainFrameId: null })
    const edited = actions.createFrame(copy, { name: 'Card main', html: '' }, actor)!
    actions.updateFrame(
      edited.id,
      { html: doc(`<div class="card" ${COMPONENT_ATTR}="${def.id}">Edited</div>`, '.card { color: blue }') },
      actor,
    )
    const before = store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
    expect(() => importComponent(canvasId, copy, def.id, actor)).toThrow(/already has its own component/)
    expect(store.getComponents(canvasId).find((candidate) => candidate.id === def.id)).toEqual(before)
  })

  it('tells the room when a main only moves', () => {
    const sent: { type: string; component?: { mainFrameId: string | null } | null }[] = []
    actions.wire(
      (_canvasId, msg) => sent.push(msg as (typeof sent)[number]),
      () => {},
    )
    try {
      const { def, frame } = makeComponent(canvasId, 'Tag', (id) => `<i class="tag" ${COMPONENT_ATTR}="${id}">t</i>`)
      sent.length = 0
      actions.updateFrame(frame.id, { html: doc('<p>no main here now</p>') }, actor)
      expect(sent.find((msg) => msg.type === 'component')?.component?.mainFrameId).toBeNull()
      expect(store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!.mainFrameId).toBeNull()
    } finally {
      actions.wire(
        () => {},
        () => {},
      )
    }
  })
})
