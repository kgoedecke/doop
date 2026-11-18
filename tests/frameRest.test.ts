import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Actor, Canvas, Frame, FrameVersion, ServerMessage } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/* The database, as far as this file needs one: a frame's row holds it at rest, as the real
   persist layer writes it (server/frameRest.ts), and a read gives the row back. */
const rows = vi.hoisted(() => ({
  frames: new Map<string, string>(),
  saved: [] as string[],
  refreshed: [] as string[],
  versions: [] as string[],
  atRest: (_canvasId: string, html: string) => html,
}))

vi.mock('../server/db/persist.ts', () => {
  const save = (f: Frame) => {
    rows.saved.push(f.id)
    rows.frames.set(f.id, rows.atRest(f.canvasId, f.html))
  }
  return {
    saveCanvas: () => {},
    saveFrame: save,
    saveFrameNow: async (f: Frame) => save(f),
    deleteFrame: (id: string) => void rows.frames.delete(id),
    saveFrameVersion: (version: FrameVersion) => void rows.versions.push(version.frameId),
    loadFrameHtml: async (ids: readonly string[]) =>
      new Map(ids.flatMap((id) => (rows.frames.has(id) ? [[id, rows.frames.get(id)!] as const] : []))),
    loadOneFrameHtml: async (id: string) => rows.frames.get(id),
    frameWritePending: () => false,
    retryFrameWrite: () => {},
    refreshAssetRefs: (f: Frame) => void rows.refreshed.push(f.id),
    saveComponent: () => {},
    deleteComponent: () => {},
    saveActivity: () => {},
    saveTask: () => {},
    saveToken: () => {},
    deleteToken: () => {},
    saveComment: () => {},
    saveFeedback: () => {},
  }
})
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const propagation = await import('../server/propagation.ts')
const { prepareFrameHtml } = await import('../server/components.ts')
const { changeInstances, createComponentFromHtml, deleteComponent, detachAllInstances, updateComponent } =
  await import('../server/componentActions.ts')
const { sourceHtml, stampRender } = await import('../server/frameCompose.ts')
const { forgetKeptReferences, restingHtml, storesCompactly, wakingHtml } = await import('../server/frameRest.ts')
const { LOST_USE_ATTR, forgetKeptTemplates, lostUsePlaceholder, reviveLostUses } =
  await import('../server/componentEngine.ts')
const { renderStamp, stampCurrent } = await import('../server/styleVersion.ts')
const { transaction } = await import('../server/journal.ts')
const { runOperation, usage } = await import('../server/workBudget.ts')
const { COMPONENT_ATTR, DETACHED_ATTR, INSTANCE_ATTR, OVERRIDES_ATTR, PART_ATTR } =
  await import('../shared/components.ts')
const { ELEMENT_ID_ATTR } = await import('../shared/elementId.ts')
const { canvasPages } = await import('../shared/pages.ts')
type ComponentDef = import('../shared/components.ts').ComponentDef

rows.atRest = (canvasId, html) => restingHtml(html, store.getComponents(canvasId))

/**
 * Compact frame storage (server/frameRest.ts): what a frame is stored as, and what
 * reading it back gives. In memory a frame holds every instance written out; at rest
 * an instance is a `<doop-use>` reference, rendered from its component when read.
 */

const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }
const sent: ServerMessage[] = []
actions.wire(
  (_canvasId, message) => void sent.push(message),
  () => {},
)

const doc = (body: string, css = '') =>
  `<!doctype html>\n<html><head><style>${css}</style></head>\n<body>\n${body}\n</body></html>`

const html = (frameId: string) => store.getFrame(frameId)!.html
const defsOf = (canvasId: string) => store.getComponents(canvasId)
const atRest = (frameId: string) => restingHtml(html(frameId), defsOf(store.getFrame(frameId)!.canvasId))
const awake = (canvasId: string, stored: string) => wakingHtml(stored, defsOf(canvasId), 'test')
const def = (canvasId: string, name: string) => defsOf(canvasId).find((each) => each.name === name)!

/** What the write pipeline holds for this HTML once its instances are reconciled and at
 *  their components' current revision: what a propagation used to write into the frame. */
function upToDate(canvas: Canvas, frameId: string, source: string): string {
  return transaction(() => sourceHtml(canvas.id, prepareFrameHtml(canvas, frameId, source, 'Tester', source).html))
}

const BUTTON = '<button class="btn"><span data-doop-prop="label">Buy</span><i class="ico">→</i></button>'
const CARD =
  '<div class="card"><h2 data-doop-prop="title">Title</h2><div class="body" data-doop-slot="body"><p>Default</p></div><doop-use component="Button" label="Inside"></doop-use></div>'

function setup(name = 'at rest') {
  const canvas = store.createCanvas(name, 'kevin')
  createComponentFromHtml(canvas.id, { name: 'Button', html: BUTTON, css: '.btn { padding: 8px }' }, human)
  createComponentFromHtml(canvas.id, { name: 'Card', html: CARD, css: '.card { border: 1px solid }' }, human)
  const frame = (body: string, pageId?: string) =>
    actions.createFrame(canvas.id, { name: 'Page', html: doc(body), ...(pageId ? { pageId } : {}) }, human)!
  return { canvas, frame }
}

const instanceIds = (source: string, componentId: string) =>
  [
    ...source.matchAll(
      new RegExp(`${INSTANCE_ATTR}="${componentId}" data-doop-rev="\\d+" ${ELEMENT_ID_ATTR}="([^"]+)"`, 'g'),
    ),
  ].map((match) => match[1]!)

/** The round trip, for a frame the write pipeline produced: reading back what is stored
 *  gives the frame's HTML byte for byte, and storing that again stores the same. */
function expectLossless(frameId: string) {
  const canvasId = store.getFrame(frameId)!.canvasId
  const stored = atRest(frameId)
  expect(awake(canvasId, stored)).toBe(html(frameId))
  expect(restingHtml(awake(canvasId, stored), defsOf(canvasId))).toBe(stored)
  return stored
}

afterEach(async () => {
  unstubAllEnvs()
  vi.restoreAllMocks()
  await propagation.whenIdle()
  sent.length = 0
  rows.saved.length = 0
  rows.versions.length = 0
})

describe('a frame at rest', () => {
  it('holds each instance as a reference by id, and reads back to the same bytes', () => {
    const { canvas, frame } = setup()
    const page = frame(
      [
        '  <!-- a comment <doop-use component="Button"></doop-use> stays a comment -->',
        '  <main  class="wrap">',
        '    <doop-use component="Button" label="One"></doop-use>',
        '    <p>between &amp; around</p>   <doop-use component="Button"></doop-use>',
        '    <doop-use component="Card" title="Hello"><p>Mine</p><doop-use component="Button" label="In slot"></doop-use></doop-use>',
        '  </main>',
        '  <script>const text = \'<doop-use component="Button"></doop-use>\'</script>',
      ].join('\n'),
    )
    const stored = expectLossless(page.id)
    const button = def(canvas.id, 'Button')
    const card = def(canvas.id, 'Card')

    expect(stored).not.toContain(INSTANCE_ATTR)
    expect(stored.length).toBeLessThan(html(page.id).length / 2)
    expect(stored).toMatch(new RegExp(`<doop-use component="${button.id}" id="[a-z0-9]+" label="One"></doop-use>`))
    expect(stored).toContain(`<doop-use component="${card.id}"`)
    /* the rest of the document is the frame's own, byte for byte */
    expect(stored).toContain('<main  class="wrap">')
    expect(stored).toContain('<p>between &amp; around</p>   <doop-use')
    expect(stored).toContain('<!-- a comment <doop-use component="Button"></doop-use> stays a comment -->')
    expect(stored).toContain('<script>const text = \'<doop-use component="Button"></doop-use>\'</script>')
  })

  it('keeps overrides of every kind: a prop, a part’s style and attribute, a hidden part, rewritten children', () => {
    const { canvas, frame } = setup()
    const page = frame(
      '<doop-use component="Button" label="A"></doop-use><doop-use component="Button"></doop-use><doop-use component="Card"></doop-use>',
    )
    const button = def(canvas.id, 'Button')
    const [first, second] = instanceIds(html(page.id), button.id)
    const parts = [...button.template.matchAll(new RegExp(`${PART_ATTR}="([^"]+)"`, 'g'))].map((match) => match[1]!)
    const [rootPart, labelPart, iconPart] = parts
    changeInstances(
      canvas.id,
      page.id,
      [
        {
          instanceId: first!,
          props: { label: 'Changed' },
          overrides: {
            [rootPart!]: { style: { color: 'red' }, attrs: { title: 'mine', 'data-doop-on': 'click' } },
            [iconPart!]: { hidden: true },
          },
        },
        { instanceId: second!, overrides: { [labelPart!]: { style: { 'font-weight': '600' } } } },
      ],
      human,
    )
    /* rewritten children: an `html` override on that one element */
    const card = def(canvas.id, 'Card')
    actions.updateFrame(
      page.id,
      { html: html(page.id).replace(/<h2([^>]*)>Title<\/h2>/, '<h2$1><em>Re</em>written</h2>') },
      human,
    )
    expect(html(page.id)).toContain('title="mine"')
    expect(html(page.id)).toContain(OVERRIDES_ATTR)
    const stored = expectLossless(page.id)
    expect(stored).not.toContain(INSTANCE_ATTR)
    expect(stored).toContain(`component="${card.id}"`)
    expect(awake(canvas.id, stored)).toContain('<em>Re</em>written')
    expect(awake(canvas.id, stored)).not.toMatch(new RegExp(`${first}"[^>]*>.*?class="ico"[^<]*<\\/i>.*?${second}`))
  })

  it('keeps slot content, nested instances with their derived ids, and an override inside a nested one', () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Card" title="T"><ul><li>one</li></ul></doop-use>')
    const button = def(canvas.id, 'Button')
    const nestedId = instanceIds(html(page.id), button.id)[0]!
    changeInstances(canvas.id, page.id, [{ instanceId: nestedId, props: { label: 'Nested changed' } }], human)
    expect(html(page.id)).toContain('Nested changed')
    const stored = expectLossless(page.id)
    /* the nested instance is the template's: its id is not stored, and comes back the same */
    expect(stored).not.toContain(nestedId)
    expect(instanceIds(awake(canvas.id, stored), button.id)).toEqual([nestedId])
    expect(stored).toContain('<ul><li>one</li></ul>')
  })

  it('leaves a reference alone that is text of an attribute: rewritten children holding a nested instance', () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Card" title="T"></doop-use>')
    /* the Card's children reordered: an `html` override on its root, kept in the marker as
       markup, with the nested Button in it as <doop-use> */
    const reordered = html(page.id).replace(/(<h2[^>]*>T<\/h2>)(<div class="body"[\s\S]*?<\/div>)/, '$2$1')
    actions.updateFrame(page.id, { html: reordered }, human)
    const rendered = html(page.id)
    expect(rendered).toMatch(new RegExp(`${OVERRIDES_ATTR}="[^"]*<doop-use component=`))
    /* read as stored written out: nothing in it is a reference to expand */
    expect(awake(canvas.id, rendered)).toBe(rendered)
    expect(upToDate(canvas, page.id, rendered)).toBe(rendered)
    const stored = expectLossless(page.id)
    expect(stored).not.toContain(INSTANCE_ATTR)
  })

  it('keeps element ids stamped inside an instance, where comments and links point', async () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Button" label="A"></doop-use><doop-use component="Card"></doop-use>')
    const inButton = await actions.ensureElementId(page.id, 'body > button > span', 'Kevin')
    const inNested = await actions.ensureElementId(page.id, 'body > div > button > i', 'Kevin')
    expect(inButton && inNested).toBeTruthy()
    const stored = atRest(page.id)
    expect(stored).not.toContain(INSTANCE_ATTR)
    const back = awake(canvas.id, stored)
    expect(back).toMatch(new RegExp(`<span [^>]*${ELEMENT_ID_ATTR}="${inButton!.id}"[^>]*>A</span>`))
    expect(back).toMatch(new RegExp(`<i [^>]*${ELEMENT_ID_ATTR}="${inNested!.id}"`))
    /* a stamp is an annotation that passes no reconcile: read back, the instance is what the
       next write of the frame would have made of it (the id held as an override), no more */
    expect(back).toBe(upToDate(canvas, page.id, html(page.id)))
    expect(restingHtml(back, defsOf(canvas.id))).toBe(stored)
  })

  it('keeps the key and the element id of an instance inside a main', () => {
    const { canvas } = setup()
    const card = def(canvas.id, 'Card')
    const button = def(canvas.id, 'Button')
    const main = store.getFrame(card.mainFrameId!)!
    expect(main.html).toContain(`${COMPONENT_ATTR}="${card.id}"`)
    const nested = instanceIds(main.html, button.id)[0]!
    const stored = expectLossless(main.id)
    /* the main itself is the component: written out. The Button in it is a reference */
    expect(stored).toContain(`${COMPONENT_ATTR}="${card.id}"`)
    expect(stored).toMatch(
      new RegExp(`<doop-use component="${button.id}" ${PART_ATTR}="[a-z]+" id="${nested}" label="Inside">`),
    )
  })

  it('leaves a detached element and its frozen stylesheet as they are', () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Button" label="Kept"></doop-use><doop-use component="Button"></doop-use>')
    const [first] = instanceIds(html(page.id), def(canvas.id, 'Button').id)
    changeInstances(canvas.id, page.id, [{ instanceId: first!, detach: true }], human)
    expect(html(page.id)).toContain(DETACHED_ATTR)
    const stored = expectLossless(page.id)
    expect(stored).toContain(DETACHED_ATTR)
    expect(stored).toContain('>Kept</span>')
  })

  it('reads back at the component’s current markup, as a propagation would have rewritten it', async () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Button" label="A"></doop-use><doop-use component="Card"></doop-use>')
    const [first] = instanceIds(html(page.id), def(canvas.id, 'Button').id)
    changeInstances(canvas.id, page.id, [{ instanceId: first!, props: { label: 'Mine' } }], human)
    const storedBefore = atRest(page.id)
    const renderedBefore = html(page.id)

    stubEnv('DOOP_DEFER_COMPONENT_PROPAGATION', 'true')
    updateComponent(canvas.id, 'Button', { find: 'class="btn"', replace: 'class="btn big"' }, human)
    await propagation.whenIdle()
    expect(html(page.id)).toBe(renderedBefore)

    const expected = upToDate(canvas, page.id, renderedBefore)
    expect(expected).toContain('btn big')
    expect(expected).toContain('>Mine</span>')
    /* stored as references */
    expect(awake(canvas.id, storedBefore)).toBe(expected)
    /* stored written out, as every frame is before its first compact save */
    expect(awake(canvas.id, renderedBefore)).toBe(expected)
    /* and a document holding both forms */
    const mixed = renderedBefore.replace(/<div class="card"[\s\S]*<\/div>(?=\s*<\/body>)/, () => {
      const cardReference = /<doop-use component="[^"]+" id="[^"]+"><\/doop-use>(?=\s*<\/body>)/.exec(storedBefore)
      return cardReference![0]
    })
    expect(mixed).toContain(INSTANCE_ATTR)
    expect(mixed).toContain('<doop-use')
    expect(awake(canvas.id, mixed)).toBe(expected)
  })

  it('takes a frame that needs nothing as it is stored, without parsing it', () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Button"></doop-use><p>text</p>')
    const rendered = html(page.id)
    const plain = doc('<p>no components</p>')
    const used = runOperation('read', canvas.id, () => {
      expect(awake(canvas.id, rendered)).toBe(rendered)
      expect(awake(canvas.id, plain)).toBe(plain)
      return usage().parsedBytes
    })
    expect(used).toBe(0)
  })

  it('stores instances written out again with DOOP_COMPACT_FRAME_STORAGE=false, and still reads references', () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Button" label="A"></doop-use>')
    const compact = atRest(page.id)
    stubEnv('DOOP_COMPACT_FRAME_STORAGE', 'false')
    expect(atRest(page.id)).toBe(html(page.id))
    expect(storesCompactly(canvas)).toBe(false)
    expect(awake(canvas.id, compact)).toBe(html(page.id))
    unstubAllEnvs()
    expect(storesCompactly(canvas)).toBe(true)
  })
})

describe('the round trip, for frames made at random through the real write paths', () => {
  /* mulberry32: the same frames every run */
  function random(seed: number) {
    let state = seed
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('is lossless and idempotent, before and after the components change', async () => {
    const next = random(20261118)
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!
    const words = ['Buy', 'Go & see', 'Ünïcode ✓', 'a "quoted" one', "it's", '<b>not markup</b>', '   spaced   ']
    const { canvas, frame } = setup('random')
    const uses = () =>
      Array.from({ length: 1 + Math.floor(next() * 6) }, () => {
        const kind = next()
        const label = pick(words).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
        if (kind < 0.4) return `<doop-use component="Button" label="${label}"></doop-use>`
        if (kind < 0.55) return '<doop-use component="Button" class="wide" style="margin: 4px"></doop-use>'
        if (kind < 0.8)
          return `<doop-use component="Card" title="${label}"><p>${label}</p>${next() < 0.5 ? '<doop-use component="Button" label="deep"></doop-use>' : ''}</doop-use>`
        if (kind < 0.9) return `<section>\n  <h3>${label}</h3>\n</section>`
        return '<table><tbody><tr><td><doop-use component="Button"></doop-use></td></tr></tbody></table>'
      }).join(next() < 0.5 ? '\n' : '')

    const frames = Array.from({ length: 24 }, () => frame(uses()))
    for (const page of frames) {
      const button = def(canvas.id, 'Button')
      const ids = instanceIds(html(page.id), button.id)
      const parts = [...button.template.matchAll(new RegExp(`${PART_ATTR}="([^"]+)"`, 'g'))].map((match) => match[1]!)
      for (const instanceId of ids) {
        const roll = next()
        if (roll < 0.25) changeInstances(canvas.id, page.id, [{ instanceId, props: { label: pick(words) } }], human)
        else if (roll < 0.45)
          changeInstances(
            canvas.id,
            page.id,
            [{ instanceId, overrides: { [pick(parts)]: { style: { color: 'red' }, attrs: { title: pick(words) } } } }],
            human,
          )
        else if (roll < 0.55)
          changeInstances(canvas.id, page.id, [{ instanceId, overrides: { [parts[2]!]: { hidden: true } } }], human)
        else if (roll < 0.6) changeInstances(canvas.id, page.id, [{ instanceId, detach: true }], human)
      }
      /* an inline edit in the editor: the document comes back with something changed inside */
      if (next() < 0.5)
        actions.updateFrame(page.id, { html: html(page.id).replace('class="ico"', 'class="ico" lang="en"') }, human)
      if (next() < 0.3) await actions.ensureElementId(page.id, 'body > button > span', 'Kevin')
    }
    await propagation.whenIdle()

    const before = new Map<string, { stored: string; rendered: string }>()
    for (const page of frames) {
      const stored = atRest(page.id)
      const back = awake(canvas.id, stored)
      expect(back).toBe(upToDate(canvas, page.id, html(page.id)))
      expect(restingHtml(back, defsOf(canvas.id))).toBe(stored)
      expect(awake(canvas.id, restingHtml(back, defsOf(canvas.id)))).toBe(back)
      before.set(page.id, { stored, rendered: html(page.id) })
    }

    /* the components move on, and no frame hears of it: what was stored reads back as the
       pipeline would have brought each frame up to date */
    stubEnv('DOOP_DEFER_COMPONENT_PROPAGATION', 'true')
    updateComponent(canvas.id, 'Button', { find: 'class="ico"', replace: 'class="ico arrow" hidden' }, human)
    updateComponent(canvas.id, 'Card', { find: 'class="card"', replace: 'class="card raised"' }, human)
    await propagation.whenIdle()
    for (const page of frames) {
      const { stored, rendered } = before.get(page.id)!
      expect(html(page.id)).toBe(rendered)
      const expected = upToDate(canvas, page.id, rendered)
      expect(awake(canvas.id, stored)).toBe(expected)
      expect(awake(canvas.id, rendered)).toBe(expected)
      const again = restingHtml(expected, defsOf(canvas.id))
      expect(awake(canvas.id, again)).toBe(expected)
      expect(restingHtml(awake(canvas.id, again), defsOf(canvas.id))).toBe(again)
    }
  })
})

describe('a definition that is damaged or gone', () => {
  const without = (canvas: Canvas, name: string): ComponentDef[] =>
    (canvas.components ?? []).filter((each) => each.name !== name)

  it('never becomes a reference at rest: unknown, deleted, hollow, not stored yet, or without an element id', () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Button" label="A"></doop-use><doop-use component="Card"></doop-use>')
    const rendered = html(page.id)
    const all = defsOf(canvas.id)
    const button = def(canvas.id, 'Button')

    /* unknown: the Button, and the Card built from it, stay written out */
    expect(restingHtml(rendered, without(canvas, 'Button'))).toBe(rendered)
    /* hollow: the same */
    forgetKeptReferences()
    const hollow = all.map((each) => (each === button ? { ...button, template: '' } : each))
    expect(restingHtml(rendered, hollow)).toBe(rendered)
    /* its row is not in the database yet (the write is queued, or failed) */
    forgetKeptReferences()
    expect(restingHtml(rendered, all, { stored: (each) => each.name !== 'Button' })).toBe(rendered)
    const onlyButton = restingHtml(rendered, all, { stored: (each) => each.name !== 'Card' })
    expect(onlyButton).toContain(`<doop-use component="${button.id}"`)
    expect(onlyButton).toContain(`${INSTANCE_ATTR}="${def(canvas.id, 'Card').id}"`)
    /* no element id: read back it would get a new one, and whatever named the old one lose it */
    forgetKeptReferences()
    const anonymous = rendered.replace(new RegExp(` ${ELEMENT_ID_ATTR}="[^"]+"`), '')
    expect(restingHtml(anonymous, all).split(INSTANCE_ATTR).length).toBe(2)
    /* deleted: its instances keep their markup byte for byte, at rest too. The Card built
       from it keeps rendering as it did, so the Card's instance is still a reference */
    deleteComponent(canvas.id, 'Button', human)
    const afterDelete = restingHtml(rendered, defsOf(canvas.id))
    const buttonInstance = /<button class="btn" data-doop-instance[\s\S]*?<\/button>/.exec(rendered)![0]
    expect(afterDelete).toContain(buttonInstance)
    expect(afterDelete).toContain(`<doop-use component="${def(canvas.id, 'Card').id}"`)
    expect(awake(canvas.id, afterDelete)).toBe(rendered)
  })

  it('keeps a reference it cannot render as a visible placeholder, stores it back as it was, and renders it once repaired', () => {
    const { canvas, frame } = setup()
    const page = frame('<p>before</p><doop-use component="Button" label="Kept"></doop-use><p>after</p>')
    const stored = atRest(page.id)
    const reference = /<doop-use [^>]*><\/doop-use>/.exec(stored)![0]
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const report = { lost: 0, revived: [] as string[] }
    const broken = wakingHtml(stored, without(canvas, 'Button'), 'canvas c frame f', report)
    expect(report.lost).toBe(1)
    expect(logged.mock.calls.join('\n')).toContain('could not be rendered')
    expect(broken).toContain(LOST_USE_ATTR)
    expect(broken).toContain('Missing component')
    expect(broken).toContain('<p>before</p>')
    expect(broken).not.toContain('<doop-use')
    expect(reviveLostUses(broken)).toBe(stored)

    /* saved while broken, by the server or after a browser sent the document back: the row
       holds the reference again, never the placeholder and never nothing */
    expect(restingHtml(broken, without(canvas, 'Button'))).toBe(stored)
    const roundTripped = broken.replace(`<div ${LOST_USE_ATTR}=`, `<div data-doop-id="abc123" ${LOST_USE_ATTR}=`)
    expect(restingHtml(roundTripped, without(canvas, 'Button'))).toContain(reference)
    stubEnv('DOOP_COMPACT_FRAME_STORAGE', 'false')
    expect(awake(canvas.id, restingHtml(broken, without(canvas, 'Button')))).toBe(html(page.id))
    unstubAllEnvs()

    /* the definition is back: a read renders it, and so does a write of the frame as it stands */
    expect(awake(canvas.id, stored)).toBe(html(page.id))
    expect(awake(canvas.id, broken)).toBe(html(page.id))
    const written = transaction(() => prepareFrameHtml(canvas, page.id, broken, 'Tester', broken).html)
    expect(sourceHtml(canvas.id, written)).toBe(html(page.id))
  })

  it('renders a hollow definition’s references from its newest kept revision, and says so', () => {
    const { canvas, frame } = setup()
    updateComponent(canvas.id, 'Button', { find: 'class="btn"', replace: 'class="btn v2"' }, human)
    const page = frame('<doop-use component="Button" label="Kept"></doop-use>')
    const stored = atRest(page.id)
    const button = def(canvas.id, 'Button')
    expect(button.history.length).toBeGreaterThan(0)
    const hollowed = (history: ComponentDef['history']) =>
      defsOf(canvas.id).map((each) => (each === button ? { ...button, template: '', css: '', history } : each))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const report = { lost: 0, revived: [] as string[] }
    const back = wakingHtml(stored, hollowed(button.history), 'canvas c frame f', report)
    expect(report).toEqual({ lost: 0, revived: [button.id] })
    expect(logged.mock.calls.join('\n')).toContain('has lost its markup')
    expect(back).toContain('>Kept</span>')
    expect(back).toContain(`${INSTANCE_ATTR}="${button.id}"`)
    /* written out from then on: a hollow component's instance is never a reference */
    expect(restingHtml(back, hollowed(button.history))).toBe(back)

    /* nothing kept to render from: the placeholder */
    const lost = wakingHtml(stored, hollowed([]), 'canvas c frame f')
    expect(lost).toContain(LOST_USE_ATTR)
    expect(restingHtml(lost, hollowed([]))).toBe(stored)
  })

  it('renders a reference to a component deleted since the frame was stored, frozen as it was', () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Button" label="Kept"></doop-use>')
    const stored = atRest(page.id)
    const rendered = html(page.id)
    deleteComponent(canvas.id, 'Button', human)
    expect(awake(canvas.id, stored)).toBe(rendered)
  })

  it('keeps a reference whole when a component its template is built from is missing', () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Card" title="Outer"><p>slot</p></doop-use>')
    const stored = atRest(page.id)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = wakingHtml(stored, without(canvas, 'Button'), 'canvas c frame f')
    expect(broken).toContain(LOST_USE_ATTR)
    expect(broken).not.toContain(INSTANCE_ATTR)
    expect(restingHtml(broken, without(canvas, 'Button'))).toBe(stored)
    expect(awake(canvas.id, broken)).toBe(html(page.id))
    /* a reference lost inside slot content is kept there, and the instance around it renders */
    const inSlot = stored.replace(
      '<p>slot</p>',
      `<p>slot</p>${lostUsePlaceholder('<doop-use component="Gone"></doop-use>', 'Gone')}`,
    )
    const back = awake(canvas.id, inSlot)
    expect(back).toContain(`${INSTANCE_ATTR}="${def(canvas.id, 'Card').id}"`)
    expect(back).toContain(LOST_USE_ATTR)
    expect(reviveLostUses(restingHtml(back, defsOf(canvas.id)))).toContain('<doop-use component="Gone"></doop-use>')
  })
})

describe('what reading and storing cost', () => {
  it('parses a template once however many instances are read, and nothing again for an unchanged save', () => {
    const { canvas, frame } = setup()
    const page = frame(
      Array.from({ length: 200 }, (_, index) => `<doop-use component="Button" label="No ${index}"></doop-use>`).join(
        '',
      ),
    )
    const stored = atRest(page.id)
    const template = def(canvas.id, 'Button').template
    forgetKeptTemplates()
    const reading = runOperation('read', canvas.id, () => {
      expect(awake(canvas.id, stored)).toBe(html(page.id))
      return usage().parsedBytes
    })
    /* the references themselves, and the template once: not the template 200 times */
    expect(reading).toBeLessThan(stored.length + template.length * 3)
    expect(reading).toBeLessThan(template.length * 100)

    /* a save of the same frame: one parse to find the instances, each already known */
    const saving = runOperation('save', canvas.id, () => {
      expect(atRest(page.id)).toBe(stored)
      return usage().parsedBytes
    })
    expect(saving).toBe(html(page.id).length)
  })

  it('opens the page with placeholders, loudly, for a frame it could not render within its budget', async () => {
    const { canvas, frame } = setup()
    const big = `<p>${'x'.repeat(1_200_000)}</p>`
    const page = frame(`<doop-use component="Card" title="Big">${big}</doop-use>`)
    await propagation.whenIdle()
    const row = rows.frames.get(page.id)!
    expect(row).toContain('<doop-use')
    store.evictIdle(0, Date.now() + 1)
    expect(store.isLoaded(canvas.id)).toBe(false)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubEnv('DOOP_WORK_BUDGET_PARSE_MB', '1')
    await store.load(canvas.id)
    unstubAllEnvs()
    /* the page is read, the frame's reference kept as a placeholder, and nothing is stored for it */
    expect(logged.mock.calls.join('\n')).toContain('reading it failed')
    expect(html(page.id)).toContain(LOST_USE_ATTR)
    expect(rows.frames.get(page.id)).toBe(row)
    expect(restingHtml(html(page.id), defsOf(canvas.id))).toBe(row)
    store.evictIdle(0, Date.now() + 1)
    await store.load(canvas.id)
    expect(html(page.id)).toContain(INSTANCE_ATTR)
  })
})

describe('a main that changes its markup', () => {
  /** Two pages using the Button; the second is not in memory when the Button changes. */
  async function twoPages() {
    const { canvas, frame } = setup('two pages')
    const first = canvasPages(canvas)[0]!
    const second = actions.createCanvasPage(canvas.id, 'Second', human)!.page
    const open = frame('<doop-use component="Button" label="Open"></doop-use><p>open</p>', first.id)
    const closed = frame('<doop-use component="Button" label="Closed"></doop-use>', second.id)
    const plain = frame('<p>plain</p>', first.id)
    await propagation.whenIdle()
    /* someone has the first page up: the second leaves memory */
    const release = store.hold(canvas.id, { pages: [first.id], frames: [] })
    store.evictIdle(0, Date.now() + 1)
    expect(store.isPageLoaded(canvas.id, first.id)).toBe(true)
    expect(store.isPageLoaded(canvas.id, second.id)).toBe(false)
    return { canvas, open, closed, plain, second, release }
  }

  it('writes no frame: loaded frames are rendered again in place, the rest when their page is read', async () => {
    const { canvas, open, closed, plain, second, release } = await twoPages()
    const main = (await store.loadFrame(def(canvas.id, 'Button').mainFrameId!))!
    const stampBefore = stampRender(renderStamp(store.getFrame(open.id)!), store.getFrame(open.id)!)
    const closedStamp = stampRender(renderStamp(store.getFrame(closed.id)!), (await store.renderableFrame(closed.id))!)
    expect(stampCurrent(store.getFrame(closed.id)!, closedStamp)).toBe(true)
    const versions = { open: store.getFrame(open.id)!.updatedAt, closed: store.getFrame(closed.id)!.updatedAt }
    const rowsBefore = { open: rows.frames.get(open.id), closed: rows.frames.get(closed.id) }
    rows.saved.length = 0
    rows.versions.length = 0
    sent.length = 0
    const load = vi.spyOn(store, 'load')

    actions.updateFrame(main.id, { html: main.html.replace('class="btn"', 'class="btn fresh"') }, human)
    await propagation.whenIdle()

    /* the main's own frame is the only row written, and the only version filed */
    expect(rows.saved.filter((id) => id !== main.id)).toEqual([])
    expect(rows.versions.filter((id) => id !== main.id)).toEqual([])
    expect(rows.frames.get(open.id)).toBe(rowsBefore.open)
    expect(rows.frames.get(closed.id)).toBe(rowsBefore.closed)
    expect(load).not.toHaveBeenCalled()
    expect(store.isPageLoaded(canvas.id, second.id)).toBe(false)

    /* the loaded frame shows it, at the version it had: a save in flight is not refused */
    expect(html(open.id)).toContain('btn fresh')
    expect(store.getFrame(open.id)!.updatedAt).toBe(versions.open)
    expect(store.getFrame(open.id)!.rendered).toBeGreaterThan(0)
    expect(store.getFrame(plain.id)!.rendered).toBeUndefined()
    const shown = sent.filter(
      (message): message is Extract<ServerMessage, { type: 'frame:updated' }> =>
        message.type === 'frame:updated' && message.frame.id === open.id,
    )
    expect(shown).toHaveLength(1)
    expect(shown[0]!.rerender).toBe(true)
    expect(shown[0]!.frame.html).toContain('btn fresh')
    expect(shown[0]!.frame.updatedAt).toBe(versions.open)
    /* what the row holds is still what a read of it gives */
    expect(awake(canvas.id, rows.frames.get(open.id)!)).toBe(html(open.id))

    /* renders made before the change are retired, of the frame that is not in memory too */
    expect(stampCurrent(store.getFrame(open.id)!, stampBefore)).toBe(false)
    expect(stampCurrent(store.getFrame(closed.id)!, closedStamp)).toBe(false)
    const fresh = (await store.renderableFrame(closed.id))!
    expect(fresh.html).toContain('btn fresh')
    expect(store.isPageLoaded(canvas.id, second.id)).toBe(false)

    /* and its page, once opened, has it: at the version it was stored with */
    await store.loadPages(canvas.id, [second.id])
    expect(html(closed.id)).toContain('btn fresh')
    expect(html(closed.id)).toContain('>Closed</span>')
    expect(store.getFrame(closed.id)!.updatedAt).toBe(versions.closed)
    expect(rows.saved.filter((id) => id !== main.id)).toEqual([])
    release()
  })

  it('writes the frame, as before, where what it stores changed too: an instance kept written out', async () => {
    const { canvas, frame } = setup()
    const page = frame('<doop-use component="Button" label="A"></doop-use>')
    /* without an element id the instance is not a reference at rest */
    const anonymous = html(page.id).replace(new RegExp(` ${ELEMENT_ID_ATTR}="[^"]+"`), '')
    store.updateFrame(page.id, { html: anonymous }, 'Kevin', { annotation: true })
    await propagation.whenIdle()
    const before = store.getFrame(page.id)!.updatedAt
    rows.saved.length = 0
    const main = store.getFrame(def(canvas.id, 'Button').mainFrameId!)!
    actions.updateFrame(main.id, { html: main.html.replace('class="btn"', 'class="btn fresh"') }, human)
    await propagation.whenIdle()
    expect(html(page.id)).toContain('btn fresh')
    expect(store.getFrame(page.id)!.updatedAt).toBeGreaterThan(before)
    expect(rows.saved).toContain(page.id)
  })

  it('writes every frame with DOOP_COMPACT_FRAME_STORAGE=false, still only the ones in memory', async () => {
    stubEnv('DOOP_COMPACT_FRAME_STORAGE', 'false')
    const { canvas, open, closed, second, release } = await twoPages()
    const before = store.getFrame(open.id)!.updatedAt
    rows.saved.length = 0
    const main = (await store.loadFrame(def(canvas.id, 'Button').mainFrameId!))!
    actions.updateFrame(main.id, { html: main.html.replace('class="btn"', 'class="btn fresh"') }, human)
    await propagation.whenIdle()
    expect(rows.saved).toContain(open.id)
    expect(rows.saved).not.toContain(closed.id)
    expect(store.getFrame(open.id)!.updatedAt).toBeGreaterThan(before)
    expect(rows.frames.get(open.id)).toContain(INSTANCE_ATTR)
    /* the frame that was not in memory was stored written out, at the old markup: read, it is current */
    expect(rows.frames.get(closed.id)).not.toContain('btn fresh')
    await store.loadPages(canvas.id, [second.id])
    expect(html(closed.id)).toContain('btn fresh')
    release()
  })

  it('still detaches every instance on every page, which writes real markup', async () => {
    const { canvas, open, closed, second, release } = await twoPages()
    rows.saved.length = 0
    /* asked for with the whole canvas in memory, as its route and its tool have it */
    await store.load(canvas.id)
    runOperation('detach', canvas.id, () => detachAllInstances(canvas.id, 'Button', human))
    store.evictIdle(0, Date.now() + 1)
    /* held until it has been through every frame */
    expect(store.isPageLoaded(canvas.id, second.id)).toBe(true)
    await propagation.whenIdle()
    expect(rows.saved).toEqual(expect.arrayContaining([open.id, closed.id]))
    for (const id of [open.id, closed.id]) {
      expect(html(id)).toContain(DETACHED_ATTR)
      expect(rows.frames.get(id)).toContain(DETACHED_ATTR)
      expect(rows.frames.get(id)).not.toContain('<doop-use')
    }
    release()
  })
})

describe('what a review of compact storage found', () => {
  const without = (canvas: Canvas, name: string): ComponentDef[] =>
    (canvas.components ?? []).filter((each) => each.name !== name)
  const CHIP = '<span class="chip" data-doop-prop="label">Chip</span>'

  it('keeps an instance written out while a component placed in its slot is not stored yet', () => {
    const { canvas, frame } = setup('slot durability')
    createComponentFromHtml(canvas.id, { name: 'Chip', html: CHIP }, human)
    const page = frame(
      '<doop-use component="Card"><div slot="body"><doop-use component="Chip" label="New"></doop-use></div></doop-use>',
    )
    const rendered = html(page.id)
    const card = def(canvas.id, 'Card')
    const chip = def(canvas.id, 'Chip')
    expect(rendered).toContain(`${INSTANCE_ATTR}="${chip.id}"`)
    forgetKeptReferences()
    const waiting = restingHtml(rendered, defsOf(canvas.id), { stored: (each) => each.name !== 'Chip' })
    expect(waiting).not.toContain(`<doop-use component="${card.id}"`)
    expect(waiting).toBe(rendered)
    forgetKeptReferences()
    expect(restingHtml(rendered, defsOf(canvas.id), { stored: () => true })).toContain(
      `<doop-use component="${card.id}"`,
    )
  })

  it('stores the frames using a deleted component again, its instances written out and frozen', async () => {
    const { canvas, frame } = setup('deleted frozen')
    createComponentFromHtml(
      canvas.id,
      { name: 'Tile', html: '<div class="tile"><doop-use component="Button" label="Go"></doop-use></div>' },
      human,
    )
    const page = frame('<doop-use component="Tile"></doop-use>')
    const tile = def(canvas.id, 'Tile')
    expect(rows.frames.get(page.id)).toContain(`<doop-use component="${tile.id}"`)
    rows.saved.length = 0
    transaction(() => deleteComponent(canvas.id, 'Tile', human))
    expect(rows.saved).toContain(page.id)
    const stored = rows.frames.get(page.id)!
    expect(stored).not.toContain(`<doop-use component="${tile.id}"`)
    const frozen = html(page.id)
    /* the Button it was built from changes: the deleted Tile's instance does not follow, in
       memory or read back from its row */
    updateComponent(canvas.id, 'Button', { html: BUTTON.replace('→', '↗') }, human)
    await propagation.whenIdle()
    expect(awake(canvas.id, rows.frames.get(page.id)!)).toBe(html(page.id))
    expect(html(page.id)).toBe(frozen)
  })

  it('keeps an instance written out while a deleted component’s instance sits in its slot', () => {
    const { canvas, frame } = setup('deleted in a slot')
    createComponentFromHtml(canvas.id, { name: 'Chip', html: CHIP }, human)
    const page = frame(
      '<doop-use component="Card"><div slot="body"><doop-use component="Chip" label="Old"></doop-use></div></doop-use>',
    )
    transaction(() => deleteComponent(canvas.id, 'Chip', human))
    const stored = rows.frames.get(page.id)!
    expect(stored).not.toContain(`<doop-use component="${def(canvas.id, 'Card').id}"`)
    expect(awake(canvas.id, stored)).toBe(html(page.id))
  })

  it('counts a frame’s instances again once its page is read back rendering something else', async () => {
    const { usageOf } = await import('../server/componentUsage.ts')
    const { canvas, frame } = setup('usage after reload')
    const page = frame('<doop-use component="Button" label="A"></doop-use>')
    const two = frame(
      '<doop-use component="Button" label="B"></doop-use><doop-use component="Button" label="C"></doop-use>',
    )
    const button = def(canvas.id, 'Button')
    const counted = () => usageOf(canvas, button.id).frames.find((each) => each.id === page.id)?.instances
    expect(counted()).toBe(1)
    /* what the row renders changes while the frame is out of memory, as when a component it
       uses gains a nested one: neither `updatedAt` nor `rendered` moves */
    rows.frames.set(page.id, rows.frames.get(two.id)!)
    store.evictIdle(0, Date.now() + 1)
    expect(counted()).toBe(1)
    await store.load(canvas.id)
    expect(counted()).toBe(2)
  })

  it('keeps a placeholder through a write while a component its reference nests is still missing', () => {
    const { canvas, frame } = setup('placeholder through a write')
    const page = frame('<doop-use component="Card" title="Kept"></doop-use>')
    const whole = html(page.id)
    const all = canvas.components!
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = wakingHtml(atRest(page.id), without(canvas, 'Button'), 'canvas c frame f')
    expect(broken).toContain(LOST_USE_ATTR)
    /* the Card is there, the Button its template nests is not: a write leaves the placeholder
       alone, where rendering the rest would record the Button as hidden for good */
    canvas.components = without(canvas, 'Button')
    const written = transaction(() => prepareFrameHtml(canvas, page.id, broken, 'Tester', broken).html)
    canvas.components = all
    expect(written).toContain(LOST_USE_ATTR)
    expect(written).not.toContain('hidden')
    /* repaired: the same document renders whole on its next write */
    const repaired = transaction(() => prepareFrameHtml(canvas, page.id, written, 'Tester', written).html)
    expect(sourceHtml(canvas.id, repaired)).toBe(whole)
  })

  it('brings a re-rendered frame’s asset references up to date, though no row is written', async () => {
    const { canvas, frame } = setup('assets after a re-render')
    const page = frame('<doop-use component="Button" label="A"></doop-use>')
    rows.saved.length = 0
    rows.refreshed.length = 0
    updateComponent(canvas.id, 'Button', { html: BUTTON.replace('→', '<img src="/a/new.png">') }, human)
    await propagation.whenIdle()
    expect(rows.saved).not.toContain(page.id)
    expect(rows.refreshed).toContain(page.id)
  })

  it('still expands a reference that follows text a stray `<` and an apostrophe make look like an open tag', () => {
    const { frame } = setup('stray tag')
    const page = frame(`<pre>if (a<b) print('don't')</pre><doop-use component="Button" label="After"></doop-use>`)
    expect(html(page.id)).toContain(INSTANCE_ATTR)
    expect(html(page.id)).not.toContain('<doop-use')
    expectLossless(page.id)
  })
})
