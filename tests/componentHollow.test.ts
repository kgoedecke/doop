import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  deleteFrame: () => {},
}))

import * as actions from '../server/actions.ts'
import { blankComponent } from '../server/components.ts'
import { compactFrameHtml } from '../server/componentActions.ts'
import { store } from '../server/store.ts'
import { COMPONENT_ATTR, CSS_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

/*
 * A hollow definition: the row lost its markup (an older write landed last, 2026-11-11)
 * while its main and its instances still hold the design. Nothing may be rendered from it:
 * its instances keep their markup and their stylesheet whatever is written, until a write of
 * the main gives the definition its markup back.
 */
const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

function setup() {
  const canvas = store.createCanvas('hollow', 'owner-hollow')
  const def = blankComponent({ name: 'Button', by: 'Tester' })
  store.saveComponent(canvas.id, def)
  const main = actions.createFrame(canvas.id, { name: 'Button main', html: '' }, actor)!
  actions.updateFrame(
    main.id,
    {
      html: doc(
        `<button class="btn" ${COMPONENT_ATTR}="${def.id}"><span data-doop-prop="label">Buy</span></button>`,
        '.btn { padding: 8px; background: teal }',
      ),
    },
    actor,
  )
  const page = actions.createFrame(canvas.id, { name: 'Page', html: '' }, actor)!
  actions.updateFrame(page.id, { html: doc('<doop-use component="Button" label="Go"></doop-use><p>text</p>') }, actor)
  const filled = store.getComponents(canvas.id).find((d) => d.id === def.id)!
  /* the row a boot loads after the blank write landed last */
  store.saveComponent(canvas.id, {
    ...filled,
    template: '',
    css: '',
    rawCss: '',
    props: [],
    slots: [],
    rev: 0,
    mainFrameId: null,
    history: [],
  })
  return { canvas, def, main, page }
}

const html = (id: string) => store.getFrame(id)!.html

describe('a hollow component', () => {
  it('reads back to an agent with its instances written out and their stylesheet', () => {
    const { def, page } = setup()
    const compact = compactFrameHtml(store.getFrame(page.id)!)
    expect(compact).not.toContain('<doop-use')
    expect(compact).toContain(`${INSTANCE_ATTR}="${def.id}"`)
    expect(compact).toContain(`${CSS_ATTR}="${def.id}"`)
    expect(compact).toContain('Go')
  })

  it('keeps its instances when an agent writes the frame back with an edit elsewhere', () => {
    const { def, page } = setup()
    const compact = compactFrameHtml(store.getFrame(page.id)!)
    actions.updateFrame(page.id, { html: compact.replace('<p>text</p>', '<p>edited</p>') }, actor)
    expect(html(page.id)).toContain('edited')
    expect(html(page.id)).toContain(`${INSTANCE_ATTR}="${def.id}"`)
    expect(html(page.id)).toContain('Go')
    expect(html(page.id)).toMatch(new RegExp(`${CSS_ATTR}="${def.id}"[^>]*>[^<]*background: teal`))
  })

  it('keeps the stylesheet of its instances through a whole write of their frame', () => {
    const { def, page } = setup()
    actions.updateFrame(page.id, { html: html(page.id).replace('<p>text</p>', '<p>moved</p>') }, actor)
    expect(html(page.id)).toMatch(new RegExp(`${CSS_ATTR}="${def.id}"[^>]*>[^<]*background: teal`))
  })

  it('gets its markup back from the next write of its main', () => {
    const { canvas, def, main } = setup()
    actions.updateFrame(main.id, { html: html(main.id).replace('Buy', 'Buy now') }, actor)
    const healed = store.getComponents(canvas.id).find((d) => d.id === def.id)!
    expect(healed.template).toContain('Buy now')
    expect(healed.mainFrameId).toBe(main.id)
    expect(healed.rev).toBeGreaterThan(0)
  })
})

describe('healing hollow components after boot', () => {
  it('gives each its markup back from its main and leaves its instances as they are', async () => {
    const { canvas, def, main, page } = setup()
    const pageBefore = html(page.id)
    const mainBefore = html(main.id)
    const { healed, failed } = await actions.healHollowComponents()
    expect(healed).toBeGreaterThanOrEqual(1)
    expect(failed).toBe(0)
    const now = store.getComponents(canvas.id).find((d) => d.id === def.id)!
    expect(now.template).toContain('Buy')
    expect(now.css).toContain('teal')
    expect(now.mainFrameId).toBe(main.id)
    expect(html(page.id)).toBe(pageBefore)
    expect(html(main.id)).toBe(mainBefore)
  })

  it('counts one whose main is gone, and leaves it be', async () => {
    const { canvas, def, main } = setup()
    actions.updateFrame(main.id, { html: doc('<p>no main any more</p>') }, actor)
    const result = await actions.healHollowComponents()
    expect(result.noMain).toBeGreaterThanOrEqual(1)
    expect(store.getComponents(canvas.id).find((d) => d.id === def.id)!.template).toBe('')
  })
})

/** A Card whose main nests a Button, a page using the Card, and a frame holding another
 *  component's main beside a Card. Then the Button and the Badge lose their markup. */
function nested() {
  const { canvas, def: button, main: buttonMain } = setup()
  /* a write of its main gives the Button its markup back, so the Card and its instances render it */
  actions.updateFrame(buttonMain.id, { html: `${html(buttonMain.id)} ` }, actor)
  const card = blankComponent({ name: 'Card', by: 'Tester' })
  store.saveComponent(canvas.id, card)
  const cardMain = actions.createFrame(canvas.id, { name: 'Card main', html: '' }, actor)!
  actions.updateFrame(
    cardMain.id,
    {
      html: doc(
        `<div class="card" ${COMPONENT_ATTR}="${card.id}"><h2 data-doop-prop="title">Title</h2><doop-use component="Button" label="Inside"></doop-use></div>`,
        '.card { border: 1px solid }',
      ),
    },
    actor,
  )
  const badge = blankComponent({ name: 'Badge', by: 'Tester' })
  store.saveComponent(canvas.id, badge)
  const mixed = actions.createFrame(canvas.id, { name: 'Mixed', html: '' }, actor)!
  actions.updateFrame(
    mixed.id,
    {
      html: doc(
        `<span class="badge" ${COMPONENT_ATTR}="${badge.id}">New</span><doop-use component="Card" title="Hello"></doop-use><p>text</p>`,
        '.badge { color: red }',
      ),
    },
    actor,
  )
  expect(html(mixed.id)).toContain('Inside')
  for (const id of [button.id, badge.id]) {
    const now = store.getComponents(canvas.id).find((d) => d.id === id)!
    store.saveComponent(canvas.id, {
      ...now,
      template: '',
      css: '',
      rawCss: '',
      rev: 0,
      mainFrameId: null,
      history: [],
    })
  }
  return { canvas, button, badge, card, mixed }
}

describe('an instance holding one of a hollow component', () => {
  it('reads back written out, so writing it back keeps the nested instance', () => {
    const { mixed } = nested()
    const compact = compactFrameHtml(store.getFrame(mixed.id)!)
    expect(compact).not.toContain('component="Card"')
    actions.updateFrame(mixed.id, { html: compact.replace('<p>text</p>', '<p>edited</p>') }, actor)
    expect(html(mixed.id)).toContain('edited')
    expect(html(mixed.id)).toContain('Inside')
  })

  it('keeps the nested instance through a whole write of its frame', () => {
    const { mixed } = nested()
    actions.updateFrame(mixed.id, { html: html(mixed.id).replace('<p>text</p>', '<p>moved</p>') }, actor)
    expect(html(mixed.id)).toContain('Inside')
  })

  it('is left as it is when the frame it shares with a hollow main is healed', async () => {
    const { canvas, badge, mixed } = nested()
    const before = html(mixed.id)
    await actions.healHollowComponents()
    expect(store.getComponents(canvas.id).find((d) => d.id === badge.id)!.template).toContain('New')
    expect(html(mixed.id)).toBe(before)
  })
})

describe('healing, when a canvas does not load', () => {
  it('counts its definitions as failed and goes on with the other canvases', async () => {
    const broken = setup()
    const fine = setup()
    const load = store.withCanvas.bind(store)
    const spy = vi
      .spyOn(store, 'withCanvas')
      .mockImplementation((id, work) =>
        id === broken.canvas.id ? Promise.reject(new Error('read failed')) : load(id, work),
      )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await actions.healHollowComponents()
    expect(result.failed).toBeGreaterThanOrEqual(1)
    expect(store.getComponents(fine.canvas.id).find((d) => d.id === fine.def.id)!.template).toContain('Buy')
    spy.mockRestore()
  })
})
