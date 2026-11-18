// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
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
import { blankComponent } from '../server/components.ts'
import { COMPONENT_ATTR, INSTANCE_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'
import { rootPartKey } from '../src/lib/components.ts'
import { buildLayerTree, type LayerNode } from '../src/lib/layers.ts'

/* The Layers row shows an instance's own name only when its saved overrides
   give its root one: a name its main carries is rendered onto every instance.
   Markup here comes from the real engine, so the part keys are the ones it writes. */

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

function walk(nodes: LayerNode[]): LayerNode[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)])
}

describe('an instance’s own layer name', () => {
  let canvasId: string
  beforeEach(() => {
    canvasId = store.createCanvas('names').id
  })

  function component(name: string, markup: (id: string) => string) {
    const def = blankComponent({ name, by: 'Tester', props: [] })
    store.saveComponent(canvasId, def)
    const frame = actions.createFrame(canvasId, { name: `${name} main`, html: '' }, actor)!
    actions.updateFrame(frame.id, { html: doc(markup(def.id)) }, actor)
    return store.getComponents(canvasId).find((candidate) => candidate.id === def.id)!
  }

  const ownName = (node: LayerNode, defs: ReturnType<typeof store.getComponents>) => {
    const def = defs.find((candidate) => candidate.id === node.componentId)!
    const key = rootPartKey(def)
    return !!key && !!node.namedParts?.includes(key)
  }

  it('is told from an inherited one on a nested instance', () => {
    const button = component(
      'Button',
      (id) => `<button class="btn" ${COMPONENT_ATTR}="${id}" data-doop-name="Main name">Buy</button>`,
    )
    const card = component(
      'Card',
      (id) => `<div class="card" ${COMPONENT_ATTR}="${id}"><doop-use component="${button.id}"></doop-use></div>`,
    )
    const page = actions.createFrame(canvasId, { name: 'Page', html: '' }, actor)!
    actions.updateFrame(page.id, { html: doc(`<doop-use component="${card.id}"></doop-use>`) }, actor)

    const nestedTag = (html: string) => new RegExp(`<button[^>]*${INSTANCE_ATTR}="${button.id}"[^>]*>`).exec(html)![0]
    const before = store.getFrame(page.id)!.html
    /* unnamed, the nested instance only inherits the main's name */
    const defs = store.getComponents(canvasId)
    const inherited = walk(buildLayerTree(before)).find((node) => node.componentId === button.id)!
    expect(inherited.component).toBe('instance')
    expect(inherited.label).toBe('Main name')
    expect(ownName(inherited, defs)).toBe(false)

    /* a rename from the Layers panel writes the name onto that instance's root */
    const tag = nestedTag(before)
    actions.updateFrame(
      page.id,
      { html: before.replace(tag, tag.replace('data-doop-name="Main name"', 'data-doop-name="Mine"')) },
      actor,
    )
    const after = store.getFrame(page.id)!.html
    const named = walk(buildLayerTree(after)).find((node) => node.componentId === button.id)!
    expect(named.label).toBe('Mine')
    expect(ownName(named, store.getComponents(canvasId))).toBe(true)
  })
})
