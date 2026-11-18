import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
}))

import * as actions from '../server/actions.ts'
import * as propagation from '../server/propagation.ts'
import { compactFrameHtml, createComponentFromHtml, updateComponent } from '../server/componentActions.ts'
import { blankComponent } from '../server/components.ts'
import { store } from '../server/store.ts'
import { INSTANCE_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

/*
 * A component whose root is a table part (a cell, a row) made from markup. Agent report
 * (2026-11-11): create_component said ok and stored an empty definition, since a <td> parsed
 * on its own, outside a table, is dropped by the HTML parser.
 */
const actor = { name: 'Tester', kind: 'agent', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

describe('a component made from a table part', () => {
  it('keeps a cell, renders it inside a row, and reads back in short form', async () => {
    const canvas = store.createCanvas('cells', 'owner-cells')
    const { component } = createComponentFromHtml(
      canvas.id,
      {
        name: 'Cell',
        html: '<td class="cell"><span data-doop-prop="label">x</span></td>',
        css: '.cell { padding: 4px }',
        props: [{ name: 'tone', type: 'enum', options: ['plain', 'loud'], default: 'plain' }],
      },
      actor,
    )
    expect(component.template).toMatch(/^<td/)
    expect(component.mainFrameId).toBeTruthy()
    expect(component.css).toContain('padding: 4px')
    expect(store.getFrame(component.mainFrameId!)!.html).toMatch(/<tr><td[^>]*data-doop-component/)

    const page = actions.createFrame(
      canvas.id,
      {
        name: 'Grid',
        html: doc(
          '<table><tbody><tr><doop-use component="Cell" label="A" tone="loud"></doop-use></tr></tbody></table>',
        ),
      },
      actor,
    )!
    const html = store.getFrame(page.id)!.html
    expect(html).toMatch(new RegExp(`<tr><td[^>]*${INSTANCE_ATTR}="${component.id}"[^>]*>`))
    expect(html).toContain('>A<')
    expect(compactFrameHtml(store.getFrame(page.id)!)).toContain('<doop-use component="Cell"')

    updateComponent(canvas.id, 'Cell', { find: 'class="cell"', replace: 'class="cell wide"' }, actor)
    await propagation.whenIdle()
    expect(store.getFrame(page.id)!.html).toContain('cell wide')
    expect(store.getFrame(page.id)!.html).toContain('>A<')
  })

  it('keeps a row with its cells', () => {
    const canvas = store.createCanvas('rows', 'owner-rows')
    const { component } = createComponentFromHtml(
      canvas.id,
      { name: 'Row', html: '<tr class="row"><td>Name</td><td>Value</td></tr>' },
      actor,
    )
    expect(component.template).toMatch(/^<tr[^>]*><td[^>]*>/)
    expect(component.template).toContain('Value')
  })

  it('finds the table part behind a leading comment', () => {
    const canvas = store.createCanvas('commented', 'owner-cells')
    const { component } = createComponentFromHtml(
      canvas.id,
      { name: 'Note cell', html: '<!-- a cell --><td class="note">Value</td>' },
      actor,
    )
    expect(component.template).toMatch(/^<td/)
  })

  it('puts a table around a main that becomes a cell, so the cell is kept', () => {
    const canvas = store.createCanvas('becomes', 'owner-cells')
    createComponentFromHtml(canvas.id, { name: 'Becomes', html: '<div class="was">Value</div>' }, actor)
    const { component } = updateComponent(canvas.id, 'Becomes', { html: '<td class="now">Value</td>' }, actor)
    expect(component.template).toMatch(/^<td[^>]*class="now"/)
    expect(store.getFrame(component.mainFrameId!)!.html).toMatch(/<tr><td[^>]*data-doop-component/)
  })

  it('refuses to turn a main that sits in a row into something a row cannot hold', () => {
    const canvas = store.createCanvas('stays', 'owner-cells')
    createComponentFromHtml(canvas.id, { name: 'Stays', html: '<td class="cell">Value</td>' }, actor)
    expect(() => updateComponent(canvas.id, 'Stays', { html: '<div>Value</div>' }, actor)).toThrow(/sits inside a <tr>/)
  })

  it('leaves a header row where it is when only its CSS changes', () => {
    const canvas = store.createCanvas('header', 'owner-cells')
    const def = createComponentFromHtml(canvas.id, { name: 'Shell', html: '<div>x</div>' }, actor).component
    const main = store.getFrame(def.mainFrameId!)!
    const head = blankComponent({ name: 'Head row', by: 'Tester' })
    store.saveComponent(canvas.id, head)
    actions.updateFrame(
      main.id,
      {
        html: main.html.replace(
          '</body>',
          `<table><thead><tr class="h" data-doop-component="${head.id}"><th>Name</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table></body>`,
        ),
      },
      actor,
    )
    updateComponent(canvas.id, 'Head row', { css: '.h { font-weight: 600 }' }, actor)
    const html = store.getFrame(main.id)!.html
    expect(html).toMatch(/<thead><tr[^>]*data-doop-component[^>]*><th[^>]*>Name<\/th><\/tr><\/thead>/)
    expect(html.match(/<table>/g)).toHaveLength(1)
  })

  it('refuses to turn a cell into a row where it stands, rather than nesting a table in the row', () => {
    const canvas = store.createCanvas('cell-to-row', 'owner-cells')
    const def = createComponentFromHtml(canvas.id, { name: 'Cell2', html: '<td class="c">Value</td>' }, actor).component
    const before = store.getFrame(def.mainFrameId!)!.html
    expect(() => updateComponent(canvas.id, 'Cell2', { html: '<tr><td>Value</td></tr>' }, actor)).toThrow(
      /sits inside a <tr>, which cannot hold a <tr>/,
    )
    expect(store.getFrame(def.mainFrameId!)!.html).toBe(before)
  })
})
