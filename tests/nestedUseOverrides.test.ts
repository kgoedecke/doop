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
import * as propagation from '../server/propagation.ts'
import { blankComponent } from '../server/components.ts'
import { compactFrameHtml, instancesIn } from '../server/componentActions.ts'
import { COMPONENT_ATTR, OVERRIDES_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

/* A nested <doop-use> written into a main is the main's own value, not an override every
   instance holds: reading it back as one pinned the instances, so the main's next change to
   that nested instance never reached them. */
describe('a nested instance added to a main', () => {
  let canvasId: string
  beforeEach(() => {
    canvasId = store.createCanvas('nested use').id
  })

  function makeComponent(
    name: string,
    markup: (id: string) => string,
    props: Parameters<typeof blankComponent>[0]['props'] = [],
  ) {
    const def = blankComponent({ name, by: 'Tester', props })
    store.saveComponent(canvasId, def)
    const frame = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(markup(def.id)) }, actor)
    return { def, frame }
  }

  const html = (frameId: string) => store.getFrame(frameId)!.html

  function setUp() {
    const icon = makeComponent(
      'Icon',
      (id) =>
        `<i class="icon" ${COMPONENT_ATTR}="${id}" data-doop-prop="data-size:size"><span data-doop-prop="name">dot</span></i>`,
      [
        { name: 'name', type: 'text', default: 'dot' },
        { name: 'size', type: 'text', default: '16' },
      ],
    )
    const row = makeComponent('MessageRow', (id) => `<div class="row" ${COMPONENT_ATTR}="${id}"><p>Hello</p></div>`)
    const pages = [0, 1].map((n) => {
      const page = actions.createFrame(canvasId, { name: `Page ${n}`, html: '' }, actor)!
      actions.updateFrame(page.id, { html: doc(`<doop-use component="MessageRow"></doop-use>`) }, actor)
      return page.id
    })
    return { icon, row, pages }
  }

  const overriddenParts = (frameId: string) => instancesIn(store.getFrame(frameId)!).map((i) => i.overridden_parts)

  it('is no override on the instances, and the main’s next change reaches them all', async () => {
    const { row, pages } = setUp()
    /* the main gains a nested Icon */
    actions.updateFrame(
      row.frame.id,
      {
        html: html(row.frame.id).replace(
          '</div></body>',
          '<doop-use component="Icon" name="chevron" size="14"></doop-use></div></body>',
        ),
      },
      actor,
    )
    await propagation.whenIdle()
    for (const page of pages) {
      expect(html(page)).toContain('chevron')
      /* what agents read: no overrides and no overridden parts */
      const compact = compactFrameHtml(store.getFrame(page)!)
      expect(compact).not.toContain('overrides=')
      expect(compact).not.toContain('chevron')
      for (const parts of overriddenParts(page)) expect(parts).toEqual([])
    }
    /* an agent writes back what it read on one page */
    actions.updateFrame(pages[0]!, { html: compactFrameHtml(store.getFrame(pages[0]!)!) }, actor)
    expect(html(pages[0]!)).not.toContain(OVERRIDES_ATTR)
    /* the main changes its Icon: every instance follows */
    actions.updateFrame(row.frame.id, { html: html(row.frame.id).replace('>chevron<', '>arrow<') }, actor)
    await propagation.whenIdle()
    for (const page of pages) {
      expect(html(page)).toContain('>arrow<')
      expect(html(page)).not.toContain('chevron')
      for (const parts of overriddenParts(page)) expect(parts).toEqual([])
    }
  })

  it('still reads back a real change to the nested instance on one instance', async () => {
    const { row, pages } = setUp()
    actions.updateFrame(
      row.frame.id,
      {
        html: html(row.frame.id).replace(
          '</div></body>',
          '<doop-use component="Icon" name="chevron" size="14"></doop-use></div></body>',
        ),
      },
      actor,
    )
    await propagation.whenIdle()
    actions.updateFrame(pages[0]!, { html: html(pages[0]!).replace('>chevron<', '>close<') }, actor)
    expect(compactFrameHtml(store.getFrame(pages[0]!)!)).toContain('close')
    expect(overriddenParts(pages[0]!).some((parts) => parts.length === 1)).toBe(true)
    actions.updateFrame(row.frame.id, { html: html(row.frame.id).replace('>chevron<', '>arrow<') }, actor)
    await propagation.whenIdle()
    expect(html(pages[0]!)).toContain('>close<')
    expect(html(pages[1]!)).toContain('>arrow<')
  })
  it('heals an instance an agent already wrote the phantom override into', async () => {
    const { row, pages } = setUp()
    actions.updateFrame(
      row.frame.id,
      {
        html: html(row.frame.id).replace(
          '</div></body>',
          '<doop-use component="Icon" name="chevron" size="14"></doop-use></div></body>',
        ),
      },
      actor,
    )
    await propagation.whenIdle()
    const key = /<i [^>]*data-doop-part="([^"]+)"/.exec(html(row.frame.id))![1]!
    const phantom = JSON.stringify({ [key]: { use: { props: { name: 'chevron', size: '14' } } } })
    actions.updateFrame(
      pages[0]!,
      { html: doc(`<doop-use component="MessageRow" overrides='${phantom}'></doop-use>`) },
      actor,
    )
    expect(html(pages[0]!)).not.toContain(OVERRIDES_ATTR)
    expect(compactFrameHtml(store.getFrame(pages[0]!)!)).not.toContain('overrides=')
    actions.updateFrame(row.frame.id, { html: html(row.frame.id).replace('>chevron<', '>arrow<') }, actor)
    await propagation.whenIdle()
    expect(html(pages[0]!)).toContain('>arrow<')
  })
})
