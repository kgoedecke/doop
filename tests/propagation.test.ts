import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  frameWritePending: () => false,
}))

/* what a write landing while a frame is being prepared looks like: the hook runs inside the prepare */
const duringPrepare = vi.hoisted(() => ({ run: undefined as ((frameId: string) => void) | undefined }))

vi.mock('../server/components.ts', async (original) => {
  const real = await original<typeof import('../server/components.ts')>()
  return {
    ...real,
    prepareFrameHtml: (...args: Parameters<typeof real.prepareFrameHtml>) => {
      const prepared = real.prepareFrameHtml(...args)
      duringPrepare.run?.(args[1])
      return prepared
    },
  }
})

import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import * as propagation from '../server/propagation.ts'
import { blankComponent, prepareFrameHtml } from '../server/components.ts'
import { updateComponent } from '../server/componentActions.ts'
import { withCanvasFaces } from '../server/canvasFaces.ts'
import { composedHtml } from '../server/frameCompose.ts'
import { referencesComponent } from '../server/components.ts'
import { COMPONENT_ATTR, type ComponentDef } from '../shared/components.ts'
import type { Actor, Canvas } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor

const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

/* as rendered: a frame stores its source, and these cases are about what it shows */
const framed = (id: string) => composedHtml(store.getFrame(id)!.canvasId, store.getFrame(id)!.html)
const current = (canvasId: string, id: string) => store.getComponents(canvasId).find((d) => d.id === id)!

/** A Button main, a Card main built from it, and `pages` frames using one or both. */
function library(pages: number) {
  const canvas = store.createCanvas('propagation test')
  const button = blankComponent({ name: 'Button', by: 'Tester' })
  store.saveComponent(canvas.id, button)
  const buttonMain = actions.createFrame(canvas.id, { name: 'Button main', html: '' }, actor)!
  actions.updateFrame(
    buttonMain.id,
    {
      html: doc(
        `<button class="btn" ${COMPONENT_ATTR}="${button.id}"><span data-doop-prop="label">Buy</span></button>`,
        '.btn { padding: 8px }',
      ),
    },
    actor,
  )
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
  const frames = Array.from({ length: pages }, (_, index) => {
    const frame = actions.createFrame(canvas.id, { name: `Page ${index}`, html: '' }, actor)!
    const body =
      index % 3 === 0
        ? `<doop-use component="Card" title="Card ${index}"></doop-use>`
        : index % 3 === 1
          ? `<doop-use component="Button" label="Go ${index}"></doop-use><p>text ${index}</p>`
          : `<p>plain ${index}</p>`
    actions.updateFrame(frame.id, { html: doc(body) }, actor)
    return frame
  })
  return { canvas, button, buttonMain, card, cardMain, frames }
}

/* A frame that follows a changed main is rendered again in memory (store.rerenderFrame) where
   what it stores, its instances as references, is unchanged; it is written (store.updateFrame)
   only where that changed too. Either way it is one visit of the queue. */
type FrameChange = (frameId: string, ...rest: unknown[]) => ReturnType<typeof store.updateFrame>

function onFrameChanges(seen: (frameId: string, changed: ReturnType<typeof store.updateFrame>) => void) {
  for (const method of ['updateFrame', 'rerenderFrame'] as const) {
    const real = (Object.getPrototypeOf(store) as Record<string, FrameChange>)[method]!
    vi.spyOn(store, method).mockImplementation(((frameId: string, ...rest: unknown[]) => {
      const changed = real.call(store, frameId, ...rest)
      seen(frameId, changed)
      return changed
    }) as never)
  }
}

const restyle = (frameId: string, cls: string) =>
  actions.updateFrame(
    frameId,
    { html: framed(frameId).replace(/<button class="btn[^"]*"/, `<button class="btn ${cls}"`) },
    actor,
  )

/** The synchronous sweep this queue replaced, as it stood before (history and broadcasts aside). */
function oldPropagateComponents(canvasId: string, changed: ComponentDef[], originFrameId?: string) {
  const queue = [...changed]
  const seen = new Set<string>()
  for (let def = queue.shift(); def; def = queue.shift()) {
    if (seen.has(def.id)) continue
    seen.add(def.id)
    const canvas = store.getCanvas(canvasId)
    if (!canvas) break
    for (const frame of [...canvas.frames]) {
      if (frame.id === originFrameId && !seen.has(`origin:${frame.id}`)) {
        seen.add(`origin:${frame.id}`)
        continue
      }
      if (!referencesComponent(frame.html, def.id)) continue
      const prepared = prepareFrameHtml(canvas, frame.id, frame.html, actor.name, frame.html)
      queue.push(...prepared.changed)
      const html = withCanvasFaces(canvasId, prepared.html)
      if (html === frame.html) continue
      store.updateFrame(frame.id, { html }, actor.name)
    }
  }
}

/* as rendered: the queue stores each frame's source, the old sweep the composed document */
const htmlOf = (canvas: Canvas) =>
  Object.fromEntries(canvas.frames.map((frame) => [frame.id, composedHtml(canvas.id, frame.html)]))
const defsOf = (canvas: Canvas) =>
  (canvas.components ?? []).map(({ updatedAt: _at, history, ...def }) => ({
    ...def,
    history: history.map(({ savedAt: _saved, ...entry }) => entry),
  }))

afterEach(async () => {
  duringPrepare.run = undefined
  vi.restoreAllMocks()
  unstubAllEnvs()
  await propagation.whenIdle()
})

describe('the propagation queue', () => {
  it('returns from a main edit without touching any other frame, then reaches them all', async () => {
    const { canvas, buttonMain, frames } = library(300)
    await propagation.whenIdle()
    const before = htmlOf(canvas)
    const writes = vi.spyOn(store, 'updateFrame')

    restyle(buttonMain.id, 'fresh')

    expect(writes.mock.calls.map(([frameId]) => frameId)).toEqual([buttonMain.id])
    for (const frame of frames) expect(framed(frame.id)).toBe(before[frame.id])
    expect(propagation.pendingFrames(canvas.id)).toBeGreaterThan(0)

    await propagation.whenIdle()
    for (const [index, frame] of frames.entries()) {
      if (index % 3 === 2) expect(framed(frame.id)).toBe(before[frame.id])
      else expect(framed(frame.id)).toContain('btn fresh')
    }
    expect(propagation.pendingFrames(canvas.id)).toBe(0)
  })

  it('drains to the HTML the synchronous sweep produced', async () => {
    const { canvas, button, buttonMain, frames } = library(12)
    await propagation.whenIdle()
    actions.setFrameApproval(frames[1]!.id, true, { id: 'u', name: 'Reviewer' })
    /* an override on one instance, which both have to keep */
    actions.updateFrame(
      frames[4]!.id,
      { html: framed(frames[4]!.id).replace('<button class="btn"', '<button class="btn" title="mine"') },
      actor,
    )
    await propagation.whenIdle()

    restyle(buttonMain.id, 'fresh')
    /* nothing has run yet: this is the state the old function started from */
    const start = { html: htmlOf(canvas), components: structuredClone(canvas.components ?? []) }

    await propagation.whenIdle()
    const queued = { html: htmlOf(canvas), defs: defsOf(canvas) }
    expect(queued.html[frames[4]!.id]).toContain('title="mine"')
    expect(queued.html[frames[0]!.id]).toContain('btn fresh')
    expect(store.getFrame(frames[1]!.id)!.approval?.status).toBe('ready_for_dev')

    for (const frame of canvas.frames) store.updateFrame(frame.id, { html: start.html[frame.id]! }, actor.name)
    canvas.components = start.components
    oldPropagateComponents(canvas.id, [current(canvas.id, button.id)], buttonMain.id)

    expect(htmlOf(canvas)).toEqual(queued.html)
    expect(defsOf(canvas)).toEqual(queued.defs)
  })

  it('changes at most one frame per tick', async () => {
    const { buttonMain } = library(30)
    await propagation.whenIdle()
    let turn = 0
    const immediate = globalThis.setImmediate
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((run: () => void) =>
      immediate(() => {
        turn += 1
        run()
      })) as typeof setImmediate)
    const perTurn = new Map<number, number>()
    onFrameChanges(() => perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1))

    restyle(buttonMain.id, 'fresh')
    perTurn.clear()
    await propagation.whenIdle()

    /* the Card main (a Button inside it) and the twenty pages using either */
    expect(perTurn.size).toBe(21)
    expect(Math.max(...perTurn.values())).toBe(1)
  })

  it('keeps an edit made mid-drain, and still updates that frame', async () => {
    const { buttonMain, frames } = library(9)
    await propagation.whenIdle()
    restyle(buttonMain.id, 'fresh')
    /* one tick in: some frames are done, the last one is not */
    await new Promise((resolve) => setImmediate(resolve))
    const last = frames[7]!
    expect(framed(last.id)).not.toContain('btn fresh')
    actions.updateFrame(last.id, { html: framed(last.id).replace('<p>text 7</p>', '<p>edited</p>') }, actor)

    await propagation.whenIdle()
    expect(framed(last.id)).toContain('<p>edited</p>')
    expect(framed(last.id)).toContain('btn fresh')
  })

  it('re-queues a frame that changed while it was being prepared instead of overwriting it', async () => {
    const { buttonMain, frames } = library(3)
    await propagation.whenIdle()
    const target = frames[1]!
    restyle(buttonMain.id, 'fresh')
    let raced = 0
    duringPrepare.run = (frameId) => {
      if (frameId !== target.id || raced++) return
      store.updateFrame(target.id, { html: framed(target.id).replace('<p>text 1</p>', '<p>raced</p>') }, 'Someone')
    }

    await propagation.whenIdle()
    expect(raced).toBeGreaterThan(1)
    expect(framed(target.id)).toContain('<p>raced</p>')
    expect(framed(target.id)).toContain('btn fresh')
  })

  it('lets two canvases take turns', async () => {
    const one = library(9)
    const two = library(9)
    await propagation.whenIdle()
    const order: string[] = []
    onFrameChanges((_frameId, frame) => {
      if (frame) order.push(frame.canvasId === one.canvas.id ? 'one' : 'two')
    })
    restyle(one.buttonMain.id, 'fresh')
    restyle(two.buttonMain.id, 'fresh')
    order.length = 0

    await propagation.whenIdle()
    expect(order).toHaveLength(14)
    expect(order.slice(0, 6)).toEqual(['one', 'two', 'one', 'two', 'one', 'two'])
  })

  it('coalesces a burst of edits to one main into one visit per frame and one activity line', async () => {
    const { canvas, buttonMain, frames } = library(9)
    await propagation.whenIdle()
    const perFrame = new Map<string, number>()
    for (const cls of ['a', 'b', 'c', 'd', 'e']) restyle(buttonMain.id, cls)
    onFrameChanges((frameId) => perFrame.set(frameId, (perFrame.get(frameId) ?? 0) + 1))

    await propagation.whenIdle()
    expect(perFrame.size).toBe(7)
    expect([...perFrame.values()].every((count) => count === 1)).toBe(true)
    expect(framed(frames[1]!.id)).toContain('btn e')
    const lines = actions.getActivity(canvas.id).filter((item) => item.message.startsWith('updated “Button”'))
    expect(lines).toHaveLength(1)
    expect(lines[0]!.message).toBe('updated “Button” in 7 frames')
  })

  /* it used to load the whole canvas and hold it until the queue drained. A frame at rest
     holds references to its components (server/frameRest.ts), so only frames in memory are
     visited, and a canvas is neither read nor kept for it */
  it('holds no canvas for a changed main: frames that leave memory mid-drain are passed over', async () => {
    const { canvas, buttonMain, frames } = library(3)
    await propagation.whenIdle()
    const changed: string[] = []
    restyle(buttonMain.id, 'fresh')
    expect(store.stats().held).toBe(0)
    expect(propagation.pendingFrames(canvas.id)).toBeGreaterThan(0)
    onFrameChanges((frameId) => changed.push(frameId))
    const load = vi.spyOn(store, 'load')
    store.evictIdle(0, Date.now() + 1)
    expect(store.isLoaded(canvas.id)).toBe(false)

    await propagation.whenIdle()
    expect(changed).toEqual([])
    expect(load).not.toHaveBeenCalled()
    expect(store.isLoaded(canvas.id)).toBe(false)
    expect(frames).toHaveLength(3)
  })

  it('still skips propagation on frame writes while the kill switch is on', async () => {
    const { buttonMain, frames } = library(3)
    await propagation.whenIdle()
    stubEnv('DOOP_DEFER_COMPONENT_PROPAGATION', 'true')
    restyle(buttonMain.id, 'fresh')
    await propagation.whenIdle()
    expect(framed(frames[1]!.id)).not.toContain('btn fresh')
    /* its own next write brings it up to date, as before */
    actions.updateFrame(frames[1]!.id, { html: framed(frames[1]!.id) + '<!-- touched -->' }, actor)
    expect(framed(frames[1]!.id)).toContain('btn fresh')
  })
})

describe('what a component update reports', () => {
  it('says how many frames it queued, and has changed none of them yet', async () => {
    const { canvas, buttonMain, frames } = library(6)
    await propagation.whenIdle()
    const before = htmlOf(canvas)

    const applied = updateComponent(canvas.id, 'Button', { find: 'class="btn"', replace: 'class="btn big"' }, actor)
    expect(applied.propagation).toEqual({ status: 'queued', frames: 5 })
    expect(framed(buttonMain.id)).toContain('btn big')
    for (const frame of frames) expect(framed(frame.id)).toBe(before[frame.id])

    await propagation.whenIdle()
    expect(framed(frames[0]!.id)).toContain('btn big')
    expect(framed(frames[1]!.id)).toContain('btn big')
  })

  it('queues new prop defaults, which no frame write carries', async () => {
    const { canvas, frames } = library(3)
    await propagation.whenIdle()
    const applied = updateComponent(
      canvas.id,
      'Button',
      { props: [{ name: 'tone', type: 'enum', options: ['ghost', 'solid'] }] },
      actor,
    )
    expect(applied.propagation?.status).toBe('queued')
    expect(framed(frames[1]!.id)).not.toContain('data-tone')
    await propagation.whenIdle()
    expect(framed(frames[1]!.id)).toContain('data-tone="ghost"')
  })

  it('says so when the kill switch leaves the instances behind', async () => {
    const { canvas, frames } = library(3)
    await propagation.whenIdle()
    stubEnv('DOOP_DEFER_COMPONENT_PROPAGATION', 'true')
    const applied = updateComponent(canvas.id, 'Button', { find: 'class="btn"', replace: 'class="btn big"' }, actor)
    expect(applied.propagation).toEqual({ status: 'deferred', frames: 3 })
    await propagation.whenIdle()
    expect(framed(frames[1]!.id)).not.toContain('btn big')
  })
})
