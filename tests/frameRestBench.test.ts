import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  frameWritePending: () => false,
  saveComponent: () => {},
  deleteComponent: () => {},
  saveActivity: () => {},
  saveTask: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const propagation = await import('../server/propagation.ts')
const { changeInstances, createComponentFromHtml, updateComponent } = await import('../server/componentActions.ts')
const { forgetKeptReferences, restingHtml, wakingHtml } = await import('../server/frameRest.ts')
const { forgetKeptTemplates } = await import('../server/componentEngine.ts')
const { parse, runOperation, usage } = await import('../server/workBudget.ts')
const { INSTANCE_ATTR } = await import('../shared/components.ts')
const { stubEnv, unstubAllEnvs } = await import('./envStub.ts')
type Actor = import('../shared/types.ts').Actor

/**
 * What compact storage costs on a heavy page: 40 frames of 150 instances each (a row of
 * cards with a nested button and slot content, plain buttons, some with overrides), about
 * as dense as the densest pages in production. Before this change a page load did no work
 * on a frame's HTML (it was stored rendered) and a save none either; these are the two new
 * costs, with the one document parse a save adds shown beside them. The numbers are
 * printed; the bounds are loose, there to catch a change that makes them many times worse.
 */

const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }
const FRAMES = 40
const INSTANCES = 150

const BUTTON =
  '<button class="btn" type="button"><span class="btn-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" fill="none"></path></svg></span><span class="btn-label" data-doop-prop="label">Continue</span></button>'
const CARD =
  '<article class="card"><header class="card-head"><img class="card-avatar" data-doop-prop="src:avatar" src="/a/avatar.png" alt=""><div class="card-titles"><h3 class="card-title" data-doop-prop="title">Card title</h3><p class="card-meta" data-doop-prop="meta">Updated 2 days ago</p></div></header><div class="card-body" data-doop-slot="body"><p>Body copy goes here, a sentence or two about the thing.</p></div><footer class="card-foot"><doop-use component="Button" label="Open"></doop-use><span class="card-count" data-doop-prop="count">12</span></footer></article>'

function body(frame: number): string {
  const uses: string[] = []
  for (let at = 0; at < INSTANCES; at++) {
    if (at % 3 === 0)
      uses.push(
        `<doop-use component="Card" title="Card ${frame}.${at}" meta="Edited by Ana" count="${at}"><p>Item ${at} of frame ${frame}</p>${at % 9 === 0 ? '<doop-use component="Button" label="In the slot"></doop-use>' : ''}</doop-use>`,
      )
    else uses.push(`<doop-use component="Button" label="Action ${frame}.${at}"></doop-use>`)
  }
  return `<!doctype html><html><head><style>body{margin:0;font-family:Inter}</style></head><body><main class="grid">${uses.join('\n')}</main></body></html>`
}

const ms = (run: () => void): number => {
  const started = performance.now()
  run()
  return performance.now() - started
}
const kb = (chars: number) => `${Math.round(chars / 1024)} KB`

describe('compact storage on a heavy page', () => {
  it('reads and stores 40 frames of 150 instances', async () => {
    const canvas = store.createCanvas('bench', 'kevin')
    createComponentFromHtml(canvas.id, { name: 'Button', html: BUTTON, css: '.btn { padding: 8px }' }, human)
    createComponentFromHtml(canvas.id, { name: 'Card', html: CARD, css: '.card { border: 1px solid }' }, human)
    const frames = Array.from({ length: FRAMES }, (_, at) =>
      actions.createFrame(canvas.id, { name: `Frame ${at}`, html: body(at) }, human)!,
    )
    /* overrides on a tenth of the plain buttons */
    const button = store.getComponents(canvas.id).find((def) => def.name === 'Button')!
    for (const frame of frames) {
      const ids = [
        ...store
          .getFrame(frame.id)!
          .html.matchAll(
            new RegExp(
              `<button class="btn" type="button" ${INSTANCE_ATTR}="${button.id}" data-doop-rev="\\d+" data-doop-id="([^"]+)"`,
              'g',
            ),
          ),
      ].map((match) => match[1]!)
      changeInstances(
        canvas.id,
        frame.id,
        ids.filter((_, at) => at % 10 === 0).map((instanceId) => ({ instanceId, props: { label: 'Overridden' } })),
        human,
      )
    }
    await propagation.whenIdle()
    const defs = () => store.getComponents(canvas.id)
    const rendered = frames.map((frame) => store.getFrame(frame.id)!.html)
    const instances = rendered.reduce((sum, html) => sum + html.split(` ${INSTANCE_ATTR}="`).length - 1, 0)

    /* storing: every instance new to the server (a restart, then every frame saved) */
    forgetKeptReferences()
    forgetKeptTemplates()
    let compact: string[] = []
    const storeCold = ms(() => (compact = rendered.map((html) => restingHtml(html, defs()))))
    /* storing again, nothing changed: a debounced save of a frame that moved */
    const storeWarm = ms(() => rendered.forEach((html) => restingHtml(html, defs())))
    /* one frame saved after one instance in it changed */
    const edited = rendered[0]!.replace('>Action 0.1<', '>Edited<')
    const storeOne = ms(() => restingHtml(edited, defs()))
    const parseOnly = ms(() => rendered.forEach((html) => parse(html, { sourceCodeLocationInfo: true })))

    /* reading the page: templates not parsed yet (a cold server), then again */
    forgetKeptTemplates()
    let awake: string[] = []
    const cold = runOperation('read page', canvas.id, () => {
      const took = ms(() => (awake = compact.map((html) => wakingHtml(html, defs(), 'bench'))))
      return { took, parsed: usage().parsedBytes }
    })
    const readWarm = ms(() => compact.forEach((html) => wakingHtml(html, defs(), 'bench')))
    /* frames stored written out and current: what every frame is before its first compact save */
    const readRendered = ms(() => rendered.forEach((html) => wakingHtml(html, defs(), 'bench')))
    for (const [at, html] of awake.entries()) expect(html).toBe(rendered[at])

    /* the Button's markup changes: frames stored written out are brought up when read */
    stubEnv('DOOP_DEFER_COMPONENT_PROPAGATION', 'true')
    updateComponent(canvas.id, 'Button', { find: 'class="btn-label"', replace: 'class="btn-label strong"' }, human)
    await propagation.whenIdle()
    unstubAllEnvs()
    let upgraded: string[] = []
    const readBehind = ms(() => (upgraded = rendered.map((html) => wakingHtml(html, defs(), 'bench'))))
    let fromCompact: string[] = []
    const readCompactAfter = ms(() => (fromCompact = compact.map((html) => wakingHtml(html, defs(), 'bench'))))
    for (const [at, html] of fromCompact.entries()) expect(html).toBe(upgraded[at])

    const chars = (list: string[]) => list.reduce((sum, html) => sum + html.length, 0)
    const per = (total: number) => `${total.toFixed(0)} ms (${(total / FRAMES).toFixed(1)} ms a frame)`
    console.log(
      [
        `heavy page: ${FRAMES} frames, ${instances} instances (nested ones counted)`,
        `  rendered ${kb(chars(rendered))}, at rest ${kb(chars(compact))} (${Math.round((chars(compact) / chars(rendered)) * 100)}%)`,
        `  before compact storage: reading and storing do no work on a frame's HTML`,
        `  store, every instance new:           ${per(storeCold)}`,
        `  store again, nothing changed:        ${per(storeWarm)}  (one parse of each frame: ${per(parseOnly)})`,
        `  store one frame, one instance edited: ${storeOne.toFixed(1)} ms`,
        `  read page, cold templates:           ${per(cold.took)}, ${kb(cold.parsed)} handed to the parser`,
        `  read page again:                     ${per(readWarm)}`,
        `  read page stored written out, current: ${per(readRendered)}`,
        `  read page stored written out, behind:  ${per(readBehind)}`,
        `  read page at rest, after the change:   ${per(readCompactAfter)}`,
      ].join('\n'),
    )
    /* loose: a regression of several times, not a slow machine */
    expect(cold.took).toBeLessThan(15_000)
    expect(storeCold).toBeLessThan(30_000)
    expect(cold.parsed).toBeLessThan(chars(compact) * 2)
  }, 120_000)
})
