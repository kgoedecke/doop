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
}))

import * as actions from '../server/actions.ts'
import { compactFrameHtml, createComponentFromHtml, updateComponent } from '../server/componentActions.ts'
import { store } from '../server/store.ts'
import { INSTANCE_ATTR, PART_ATTR } from '../shared/components.ts'
import type { Actor } from '../shared/types.ts'

/*
 * A part key is how an instance's overrides find their element. Agent reports (2026-11-11):
 * inserting a keyless element before a keyed one moved the keyed one's key, and the
 * overrides with it, onto the new element, with nothing in the impact report.
 */
const actor = { name: 'Tester', kind: 'agent', color: '#000', clientId: 'x' } as unknown as Actor

/** The key on the element whose `label` (a `<doop-use>`) or text is `label`. */
function keyOf(template: string, label: string): string | undefined {
  const tag = new RegExp(`<[^>]*\\blabel="${label}"[^>]*>|<[^>]*>${label}<`).exec(template)?.[0] ?? ''
  return new RegExp(`${PART_ATTR}="([a-z]+)"`).exec(tag)?.[1]
}

function footer() {
  const canvas = store.createCanvas('parts', 'owner-parts')
  createComponentFromHtml(
    canvas.id,
    { name: 'Button', html: '<button class="b"><span data-doop-prop="label">Go</span></button>' },
    actor,
  )
  const def = createComponentFromHtml(
    canvas.id,
    { name: 'Step Footer', html: '<div class="f"><doop-use component="Button" label="Skip"></doop-use></div>' },
    actor,
  ).component
  return { canvas, def }
}

describe('a nested instance added to a main', () => {
  it('in front of a keyed one leaves that one its key', () => {
    const { canvas, def } = footer()
    const skip = keyOf(def.template, 'Skip')!
    const sent = def.template.replace('<doop-use', '<doop-use component="Button" label="Previous"></doop-use><doop-use')
    const after = updateComponent(canvas.id, 'Step Footer', { html: sent }, actor).component
    expect(keyOf(after.template, 'Skip')).toBe(skip)
    expect(keyOf(after.template, 'Previous')).toBeDefined()
    expect(keyOf(after.template, 'Previous')).not.toBe(skip)
  })

  it('gets a key of its own, not the one every use of that component shares', () => {
    const { canvas, def } = footer()
    const sent = def.template.replace(
      '</div>',
      '<doop-use component="Button" label="Next"></doop-use><doop-use component="Button" label="Done"></doop-use></div>',
    )
    const after = updateComponent(canvas.id, 'Step Footer', { html: sent }, actor).component
    const keys = ['Skip', 'Next', 'Done'].map((label) => keyOf(after.template, label))
    expect(new Set(keys).size).toBe(3)
    /* the main's frame carries the same keys as the template */
    const main = store.getFrame(after.mainFrameId!)!.html
    const nested = [...main.matchAll(new RegExp(`<button[^>]*${INSTANCE_ATTR}[^>]*>`, 'g'))].map(
      ([tag]) => new RegExp(`${PART_ATTR}="([a-z]+)"`).exec(tag)?.[1],
    )
    expect(nested).toEqual(keys)
  })
})

describe('a keyless element added to a main', () => {
  it('in front of a keyed sibling of the same tag leaves the sibling its key', () => {
    const canvas = store.createCanvas('list', 'owner-parts')
    const def = createComponentFromHtml(
      canvas.id,
      { name: 'List', html: '<ul><li>Second</li></ul>', autoProps: false },
      actor,
    ).component
    const second = keyOf(def.template, 'Second')!
    const sent = def.template.replace(/<li /, '<li>First</li><li ')
    const after = updateComponent(canvas.id, 'List', { html: sent }, actor).component
    expect(keyOf(after.template, 'Second')).toBe(second)
    expect(keyOf(after.template, 'First')).not.toBe(second)
  })

  it('still takes the old key by place when the agent resent the markup with no keys at all', () => {
    const canvas = store.createCanvas('resend', 'owner-parts')
    const def = createComponentFromHtml(
      canvas.id,
      { name: 'Pair', html: '<div><h2>Title</h2><p>Body</p></div>', autoProps: false },
      actor,
    ).component
    const sent = '<div><h2>New title</h2><p>New body</p></div>'
    const after = updateComponent(canvas.id, 'Pair', { html: sent }, actor).component
    expect(keyOf(after.template, 'New title')).toBe(keyOf(def.template, 'Title'))
    expect(keyOf(after.template, 'New body')).toBe(keyOf(def.template, 'Body'))
  })
})

describe('a main read back in short form and saved', () => {
  it('keeps the keys of the instances nested in it, so nothing about the component changes', () => {
    const { canvas, def } = footer()
    const main = store.getFrame(def.mainFrameId!)!
    const compact = compactFrameHtml(main)
    expect(compact).toContain(`${PART_ATTR}="${keyOf(def.template, 'Skip')}"`)
    actions.updateFrame(main.id, { html: compact }, actor)
    const after = store.getComponents(canvas.id).find((d) => d.id === def.id)!
    expect(after.template).toBe(def.template)
    expect(after.rev).toBe(def.rev)
  })

  it('keeps the element ids of the instances nested in it, so comments and links still find them', () => {
    const { def } = footer()
    const main = store.getFrame(def.mainFrameId!)!
    const ids = () =>
      [...store.getFrame(main.id)!.html.matchAll(new RegExp(`<button[^>]*${INSTANCE_ATTR}[^>]*>`, 'g'))].map(
        ([tag]) => /data-doop-id="([^"]+)"/.exec(tag)?.[1],
      )
    const before = ids()
    expect(before[0]).toBeDefined()
    actions.updateFrame(main.id, { html: compactFrameHtml(main) }, actor)
    expect(ids()).toEqual(before)
  })
})
