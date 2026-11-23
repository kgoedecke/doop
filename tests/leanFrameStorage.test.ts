import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'
import { COMPONENT_ATTR, CSS_ATTR, HEAD_ATTR, INSTANCE_ATTR, MAX_COMPONENT_HISTORY } from '../shared/components'
import { TOKEN_BLOCK_ATTR } from '../shared/designTokens'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveComponent: () => {},
  deleteComponent: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveToken: () => {},
  deleteToken: () => {},
  saveReference: () => {},
  saveCanvasCopy: async () => {},
  saveFrameVersion: () => {},
  frameWritePending: () => false,
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const propagation = await import('../server/propagation.ts')
const { blankComponent } = await import('../server/components.ts')
const { compactFrameHtml } = await import('../server/componentActions.ts')
const { composedHtml, sourceHtml, stampRender } = await import('../server/frameCompose.ts')
const { renderStamp, stampCurrent } = await import('../server/styleVersion.ts')
const { transaction } = await import('../server/journal.ts')
const { printShell } = await import('../server/pdfExport.ts')

/**
 * What a frame stores, and what a change to the canvas's shared styles writes.
 * Lean storage (the default): a frame keeps its source, and a token value or a
 * component's rules change with no frame written. `DOOP_LEAN_FRAME_STORAGE=false`
 * (the temporary switch back): the composed document is stored and those changes
 * rewrite frames, as before. Either way the composed document is the same, also
 * for a database holding frames of both forms.
 */

const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }

const sent: { type: string; frameId?: string }[] = []
actions.wire(
  (_canvasId, msg) => {
    sent.push(msg.type === 'frame:updated' ? { type: msg.type, frameId: msg.frame.id } : { type: msg.type })
  },
  () => {},
)
const frameUpdates = () => sent.filter((msg) => msg.type === 'frame:updated').map((msg) => msg.frameId)

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const html = (frameId: string) => store.getFrame(frameId)!.html
const SHARED = [TOKEN_BLOCK_ATTR, CSS_ATTR, HEAD_ATTR]

/** A canvas with two tokens, a Button component styled through one of them, a frame
 *  using the Button and a token, and a frame that uses nothing shared. */
function setup() {
  const canvas = store.createCanvas('lean frames', 'kevin')
  actions.createTokens(
    canvas.id,
    [
      { name: '--ink', type: 'color', value: '#111' },
      { name: '--brand', type: 'color', value: 'blue' },
    ],
    human,
  )
  const button = blankComponent({ name: 'Button', by: human.name })
  transaction(() => store.saveComponent(canvas.id, button))
  const main = actions.createFrame(canvas.id, { name: 'Button main', html: '' }, human)!
  actions.updateFrame(
    main.id,
    {
      html: doc(
        `<button class="btn" ${COMPONENT_ATTR}="${button.id}"><span data-doop-prop="label">Buy</span></button>`,
        '.btn { color: var(--brand); padding: 8px }',
      ),
    },
    human,
  )
  const page = actions.createFrame(
    canvas.id,
    {
      name: 'Page',
      html: doc('<h1 style="color:var(--ink)">Title</h1><doop-use component="Button" label="Go"></doop-use>'),
    },
    human,
  )!
  const plain = actions.createFrame(canvas.id, { name: 'Plain', html: doc('<p>plain</p>') }, human)!
  sent.length = 0
  return { canvasId: canvas.id, button, main, page, plain }
}

/** A render of the frame as it is now, and whether a cache would still serve it. */
function renderOf(frameId: string) {
  const stamp = stampRender(renderStamp(store.getFrame(frameId)!), store.getFrame(frameId)!)
  return { current: () => stampCurrent(store.getFrame(frameId)!, stamp) }
}

const restyleMain = (frameId: string, padding: string) =>
  actions.updateFrame(frameId, { html: html(frameId).replace(/padding: \d+px/, `padding: ${padding}`) }, human)

afterEach(() => unstubAllEnvs())

describe.each([
  ['lean storage (the default)', undefined, true],
  ['DOOP_LEAN_FRAME_STORAGE=false', 'false', false],
] as const)('%s', (_name, setting, lean) => {
  const start = () => {
    stubEnv('DOOP_LEAN_FRAME_STORAGE', setting)
    return setup()
  }

  it(lean ? 'stores a frame’s source' : 'stores the composed document', () => {
    const { page, canvasId } = start()
    const stored = html(page.id)
    expect(stored).toContain(`${INSTANCE_ATTR}=`)
    for (const mark of [TOKEN_BLOCK_ATTR, CSS_ATTR]) expect(stored.includes(mark)).toBe(!lean)
    /* what is rendered is the same document either way */
    const composed = composedHtml(canvasId, stored)
    expect(composed).toContain(`<style ${TOKEN_BLOCK_ATTR}>`)
    expect(composed).toMatch(new RegExp(`<style ${CSS_ATTR}="[^"]+">[^<]*color: var\\(--brand\\)`))
    /* --brand is named only by the Button's rules */
    expect(composed).toMatch(/--brand:blue/)
    if (!lean) expect(composed).toBe(stored)
    expect(sourceHtml(canvasId, composed)).toBe(sourceHtml(canvasId, stored))
  })

  it(
    lean
      ? 'a token value change writes no frame and sends no frame'
      : 'a token value change rewrites the frames naming it',
    () => {
      const { canvasId, page, plain } = start()
      const before = { page: store.getFrame(page.id)!.updatedAt, plain: store.getFrame(plain.id)!.updatedAt }
      const rendered = renderOf(page.id)
      const untouched = renderOf(plain.id)
      actions.setTokens(canvasId, [{ name: '--ink', value: 'hotpink' }], human)
      expect(sent.map((msg) => msg.type)).toContain('tokens')
      expect(store.getFrame(plain.id)!.updatedAt).toBe(before.plain)
      if (lean) {
        expect(frameUpdates()).toEqual([])
        expect(store.getFrame(page.id)!.updatedAt).toBe(before.page)
      } else {
        expect(frameUpdates()).toEqual([page.id])
        expect(store.getFrame(page.id)!.updatedAt).toBeGreaterThan(before.page)
        expect(html(page.id)).toContain('--ink:hotpink')
      }
      expect(composedHtml(canvasId, html(page.id))).toContain('--ink:hotpink')
      /* a render made before the change is not served as current, written or not; one of
         a frame that does not name the token still is */
      expect(rendered.current()).toBe(false)
      expect(untouched.current()).toBe(true)
    },
  )

  it('a token rename rewrites the frames naming it', () => {
    const { canvasId, page, plain } = start()
    actions.setTokens(canvasId, [{ name: '--ink', newName: '--text' }], human)
    expect(frameUpdates()).toContain(page.id)
    expect(frameUpdates()).not.toContain(plain.id)
    expect(html(page.id)).toContain('color:var(--text)')
    expect(composedHtml(canvasId, html(page.id))).toContain('--text:#111')
  })

  it('a token rename reaches the stylesheet a component composes into the frames using it', () => {
    const { canvasId, page, button } = start()
    actions.setTokens(canvasId, [{ name: '--brand', newName: '--accent' }], human)
    expect(store.getComponents(canvasId).find((def) => def.id === button.id)!.css).toContain('var(--accent)')
    const composed = composedHtml(canvasId, html(page.id))
    expect(composed).toMatch(new RegExp(`<style ${CSS_ATTR}="[^"]+">[^<]*color: var\\(--accent\\)`))
    expect(composed).toContain('--accent:blue')
    expect(composed).not.toContain('--brand')
  })

  it(
    lean
      ? 'a change to a component’s rules alone writes no frame using it'
      : 'a change to a component’s rules rewrites the frames using it',
    async () => {
      const { canvasId, main, page, plain, button } = start()
      const before = store.getFrame(page.id)!.updatedAt
      const rendered = renderOf(page.id)
      const untouched = renderOf(plain.id)
      restyleMain(main.id, '12px')
      await propagation.whenCanvasIdle(canvasId)
      expect(sent.map((msg) => msg.type)).toContain('component')
      expect(store.getComponents(canvasId).find((def) => def.id === button.id)!.css).toContain('12px')
      expect(composedHtml(canvasId, html(page.id))).toContain('padding: 12px')
      if (lean) {
        expect(frameUpdates()).toEqual([main.id])
        expect(store.getFrame(page.id)!.updatedAt).toBe(before)
      } else {
        expect(frameUpdates()).toContain(page.id)
        expect(html(page.id)).toContain('padding: 12px')
      }
      expect(rendered.current()).toBe(false)
      expect(untouched.current()).toBe(true)
    },
  )

  it('a change to a component’s markup still reaches the frames using it', async () => {
    const { canvasId, main, page } = start()
    actions.updateFrame(main.id, { html: html(main.id).replace('>Buy<', '>Buy now<') }, human)
    actions.updateFrame(main.id, { html: html(main.id).replace('<span', '<i data-doop-part="zz">★</i><span') }, human)
    await propagation.whenCanvasIdle(canvasId)
    expect(frameUpdates()).toContain(page.id)
    expect(html(page.id)).toContain('★')
  })

  it('agents read the source: no component stylesheet and no token block', () => {
    const { page } = start()
    const compact = compactFrameHtml(store.getFrame(page.id)!)
    expect(compact).toContain('<doop-use')
    for (const mark of SHARED) expect(compact).not.toContain(mark)
  })

  it('prints the composed document', () => {
    const { page } = start()
    const shell = printShell(store.getFrame(page.id)!)
    /* the design is the iframe's srcdoc: the canvas's styles are in it, escaped with it */
    expect(shell).toContain(`<style ${TOKEN_BLOCK_ATTR}>`)
    expect(shell).toContain('--ink:#111')
    expect(shell).toMatch(new RegExp(`<style ${CSS_ATTR}=&quot;[^&]+&quot;>`))
  })

  it('a pinned reference is a document of its own', () => {
    const { canvasId, page } = start()
    const reference = actions.pinReference(canvasId, page.id, human)!
    expect(reference.html).toBe(composedHtml(canvasId, html(page.id)))
    actions.setTokens(canvasId, [{ name: '--ink', value: 'hotpink' }], human)
    /* it keeps the values it was pinned with */
    expect(store.getReferences(canvasId)[0]!.html).toContain('--ink:#111')
  })
})

describe('a canvas holding frames of both forms', () => {
  /** `page` stored composed (as before lean storage), `twin` stored lean, same design. */
  function mixed() {
    stubEnv('DOOP_LEAN_FRAME_STORAGE', 'false')
    const made = setup()
    const design = html(made.page.id)
    unstubAllEnvs()
    const twin = actions.createFrame(
      made.canvasId,
      {
        name: 'Twin',
        html: doc('<h1 style="color:var(--ink)">Title</h1><doop-use component="Button" label="Go"></doop-use>'),
      },
      human,
    )!
    sent.length = 0
    expect(design).toContain(TOKEN_BLOCK_ATTR)
    expect(html(twin.id)).not.toContain(TOKEN_BLOCK_ATTR)
    return { ...made, twin }
  }

  /* instance ids differ between two frames: compare what the canvas supplied */
  const blocks = (composed: string) => ({
    tokens: /<style data-doop-tokens>[\s\S]*?<\/style>/.exec(composed)?.[0],
    component: new RegExp(`<style ${CSS_ATTR}="[^"]+">[\\s\\S]*?</style>`).exec(composed)?.[0],
  })

  it('composes an old stored frame and a lean one to the same styles, through every change', async () => {
    const { canvasId, page, twin, main } = mixed()
    const same = () =>
      expect(blocks(composedHtml(canvasId, html(page.id)))).toEqual(blocks(composedHtml(canvasId, html(twin.id))))
    same()
    actions.setTokens(canvasId, [{ name: '--ink', value: 'hotpink' }], human)
    same()
    expect(composedHtml(canvasId, html(page.id))).toContain('--ink:hotpink')
    restyleMain(main.id, '20px')
    await propagation.whenCanvasIdle(canvasId)
    same()
    expect(composedHtml(canvasId, html(page.id))).toContain('padding: 20px')
    /* the stale blocks were replaced, not added to */
    expect(composedHtml(canvasId, html(page.id)).match(new RegExp(TOKEN_BLOCK_ATTR, 'g'))).toHaveLength(1)
  })

  it('leaves the old stored frame unwritten when only shared styles change', async () => {
    const { canvasId, page, main } = mixed()
    const stored = html(page.id)
    const before = store.getFrame(page.id)!.updatedAt
    actions.setTokens(canvasId, [{ name: '--ink', value: 'hotpink' }], human)
    restyleMain(main.id, '20px')
    await propagation.whenCanvasIdle(canvasId)
    expect(frameUpdates()).toEqual([main.id])
    expect(store.getFrame(page.id)!.updatedAt).toBe(before)
    /* still as it was stored, stale blocks and all: nothing swept it */
    expect(html(page.id)).toBe(stored)
  })

  it('stores the old frame lean on its own next write', () => {
    const { page } = mixed()
    actions.updateFrame(page.id, { html: html(page.id).replace('Title', 'Renamed') }, human)
    for (const mark of SHARED) expect(html(page.id)).not.toContain(mark)
    expect(html(page.id)).toContain('Renamed')
  })

  it('switched off again, a lean frame is stored composed on its next write', () => {
    const { twin } = mixed()
    stubEnv('DOOP_LEAN_FRAME_STORAGE', 'false')
    actions.updateFrame(twin.id, { html: html(twin.id).replace('Title', 'Renamed') }, human)
    expect(html(twin.id)).toContain(TOKEN_BLOCK_ATTR)
    expect(html(twin.id)).toContain(CSS_ATTR)
  })
})

describe.each([
  ['lean storage (the default)', undefined],
  ['DOOP_LEAN_FRAME_STORAGE=false', 'false'],
] as const)('revisions of a component’s rules alone, %s', (_name, setting) => {
  const markOf = (frameId: string, componentId: string) =>
    Number(new RegExp(`${INSTANCE_ATTR}="${componentId}" data-doop-rev="(\\d+)"`).exec(html(frameId))![1])
  const defOf = (canvasId: string, id: string) => store.getComponents(canvasId).find((def) => def.id === id)!

  /** more rules-only revisions than the history kept of a component */
  async function restyledPastHistory() {
    stubEnv('DOOP_LEAN_FRAME_STORAGE', setting)
    const made = setup()
    const marked = markOf(made.page.id, made.button.id)
    for (let step = 0; step < MAX_COMPONENT_HISTORY + 5; step++) restyleMain(made.main.id, `${20 + step}px`)
    await propagation.whenCanvasIdle(made.canvasId)
    return { ...made, marked }
  }

  it('leave instances marked with the revision their markup last changed at', async () => {
    const { canvasId, page, button, marked } = await restyledPastHistory()
    const def = defOf(canvasId, button.id)
    expect(def.rev).toBeGreaterThan(marked + MAX_COMPONENT_HISTORY)
    expect(def.renderRev).toBe(marked)
    expect(markOf(page.id, button.id)).toBe(marked)
    /* every kept state is of that same span, and says so */
    expect(def.history.every((entry) => (entry.renderRev ?? entry.rev) === marked)).toBe(true)
  })

  it('keep an edit made inside an instance afterwards, as its overrides', async () => {
    const { canvasId, page, button } = await restyledPastHistory()
    /* what a person does in the frame: type over the label, restyle the text */
    const edited = html(page.id).replace(
      /(<span data-doop-part="[^"]+")>Go<\/span>/,
      '$1 style="color: tomato">Go further</span>',
    )
    expect(edited).not.toBe(html(page.id))
    actions.updateFrame(page.id, { html: edited }, human)
    const saved = html(page.id)
    expect(saved).toContain('Go further')
    expect(saved).toContain('color: tomato')
    expect(saved).toContain('&quot;label&quot;:&quot;Go further&quot;')
    expect(saved).toContain('data-doop-overrides=')
    /* and they hold when the component's markup changes next */
    const main = defOf(canvasId, button.id).mainFrameId!
    actions.updateFrame(main, { html: html(main).replace('<span', '<i data-doop-part="zz">★</i><span') }, human)
    await propagation.whenCanvasIdle(canvasId)
    const after = html(page.id)
    expect(after).toContain('★')
    expect(after).toContain('Go further')
    expect(after).toContain('color: tomato')
    const def = defOf(canvasId, button.id)
    expect(def.renderRev).toBeUndefined()
    expect(markOf(page.id, button.id)).toBe(def.rev)
  })

  it('still merge an instance left behind a markup change, though the kept states are all rules-only', async () => {
    const { canvasId, page, button, main, marked } = await restyledPastHistory()
    /* the markup changes with propagation switched off: the page's instance stays behind */
    stubEnv('DOOP_DEFER_COMPONENT_PROPAGATION', 'true')
    actions.updateFrame(main.id, { html: html(main.id).replace('<span', '<i data-doop-part="zz">★</i><span') }, human)
    expect(markOf(page.id, button.id)).toBe(marked)
    /* its base is a kept state of the span its mark belongs to, long after revision `marked` itself went */
    expect(defOf(canvasId, button.id).history.some((entry) => entry.rev === marked)).toBe(false)
    actions.updateFrame(
      page.id,
      { html: html(page.id).replace(/(<span data-doop-part="[^"]+")>Go<\/span>/, '$1>Go further</span>') },
      human,
    )
    expect(html(page.id)).toContain('Go further')
    expect(html(page.id)).toContain('★')
    expect(markOf(page.id, button.id)).toBe(defOf(canvasId, button.id).rev)
  })
})
