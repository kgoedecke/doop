import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

/* what the database holds for each frame: set by hand here, to stand for rows a
   propagation never reached */
const rows = vi.hoisted(() => ({ frames: new Map<string, string>(), saved: [] as string[] }))

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: (f: Frame) => void rows.saved.push(f.id),
  saveFrameNow: async () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  frameWritePending: () => false,
  loadFrameHtml: async (ids: readonly string[]) =>
    new Map(ids.flatMap((id) => (rows.frames.has(id) ? [[id, rows.frames.get(id)!] as const] : []))),
}))

import * as actions from '../server/actions.ts'
import * as propagation from '../server/propagation.ts'
import { createComponentFromHtml } from '../server/componentActions.ts'
import { store } from '../server/store.ts'
import type { Actor } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/*
 * Instances a propagation never reached (the queue lives in memory, so a restart
 * mid-drain dropped it) used to be found by a query over every stored frame at boot
 * and rewritten, a canvas at a time (`catchUpComponentsBehind`). Nothing is left for
 * that to do: a frame is brought up to its components when it is read
 * (server/frameRest.ts), whichever form it was stored in, and no frame is written
 * for it. What these cases keep from the old ones: such a frame ends up current, and
 * its sign-off stands. What went with the catch-up itself: its count of what it
 * queued, and its taking one canvas at a time (it loads no canvas now).
 */
const actor = { name: 'Tester', kind: 'agent', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

/** A page using a Badge, stored with the Badge's first markup, and a Badge that has moved on. */
async function leftBehind() {
  const canvas = store.createCanvas('catch-up', 'owner-catch-up')
  const def = createComponentFromHtml(canvas.id, { name: 'Badge', html: '<span class="b">New</span>' }, actor).component
  const page = actions.createFrame(
    canvas.id,
    { name: 'Page', html: doc('<doop-use component="Badge"></doop-use>') },
    actor,
  )!
  actions.setFrameApproval(page.id, true, { id: 'u', name: 'Reviewer' })
  const stale = store.getFrame(page.id)!.html
  const main = store.getFrame(def.mainFrameId!)!
  for (const frame of store.getCanvas(canvas.id)!.frames) rows.frames.set(frame.id, frame.html)
  /* the server stops here: the row holds the old markup, written out */
  rows.frames.set(page.id, stale)
  rows.frames.set(main.id, main.html.replace('>New<', '>Fresh<'))
  actions.updateFrame(main.id, { html: main.html.replace('>New<', '>Fresh<') }, actor)
  await propagation.whenIdle()
  store.evictIdle(0, Date.now() + 1)
  expect(store.isLoaded(canvas.id)).toBe(false)
  rows.saved.length = 0
  return { canvas, page, stale }
}

afterEach(async () => {
  unstubAllEnvs()
  await propagation.whenIdle()
})

describe('instances left behind in the database', () => {
  it('are current when their frame is read, and keep the frame’s sign-off and version', async () => {
    const { canvas, page, stale } = await leftBehind()
    expect(stale).toContain('New')
    const version = store.getFrame(page.id)!.updatedAt

    await store.load(canvas.id)
    expect(store.getFrame(page.id)!.html).toContain('Fresh')
    expect(store.getFrame(page.id)!.html).not.toContain('New')
    expect(store.getFrame(page.id)!.approval?.status).toBe('ready_for_dev')
    expect(store.getFrame(page.id)!.updatedAt).toBe(version)
    /* the row is stored again as read, once, so the next read of it has nothing to do */
    await propagation.whenIdle()
    expect(rows.saved).toEqual([page.id])
  })

  it('takes a frame whose instances are current exactly as stored', async () => {
    const { canvas, page } = await leftBehind()
    await store.load(canvas.id)
    const current = store.getFrame(page.id)!.html
    rows.frames.set(page.id, current)
    store.evictIdle(0, Date.now() + 1)
    await store.load(canvas.id)
    expect(store.getFrame(page.id)!.html).toBe(current)
  })

  it('are current when read while propagation is switched off too: the switch holds back the queue, not a read', async () => {
    const { canvas, page } = await leftBehind()
    stubEnv('DOOP_DEFER_COMPONENT_PROPAGATION', 'true')
    await store.load(canvas.id)
    expect(store.getFrame(page.id)!.html).toContain('Fresh')
  })
})
