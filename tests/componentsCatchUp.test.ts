import { describe, expect, it, vi } from 'vitest'

const behind = vi.hoisted(() => ({ list: [] as { canvasId: string; componentId: string }[] }))

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  componentsBehind: async () => behind.list,
}))

import * as actions from '../server/actions.ts'
import * as propagation from '../server/propagation.ts'
import { createComponentFromHtml } from '../server/componentActions.ts'
import { store } from '../server/store.ts'
import type { Actor } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/* instances a propagation never reached (a restart mid-drain) are brought up to their component */
const actor = { name: 'Tester', kind: 'agent', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

describe('catching up instances behind', () => {
  it('rewrites the frames still on an older revision, and keeps their sign-off', async () => {
    const canvas = store.createCanvas('catch-up', 'owner-catch-up')
    const def = createComponentFromHtml(
      canvas.id,
      { name: 'Badge', html: '<span class="b">New</span>' },
      actor,
    ).component
    const page = actions.createFrame(
      canvas.id,
      { name: 'Page', html: doc('<doop-use component="Badge"></doop-use>') },
      actor,
    )!
    actions.setFrameApproval(page.id, true, { id: 'u', name: 'Reviewer' })
    const stale = store.getFrame(page.id)!.html
    /* the component moves on while its propagation is lost: the frame keeps the old markup */
    const main = store.getFrame(def.mainFrameId!)!
    actions.updateFrame(main.id, { html: main.html.replace('>New<', '>Fresh<') }, actor)
    store.updateFrame(page.id, { html: stale }, 'Tester', { annotation: true })
    await propagation.whenIdle()
    store.updateFrame(page.id, { html: stale }, 'Tester', { annotation: true })
    expect(store.getFrame(page.id)!.html).toContain('New')

    behind.list = [{ canvasId: canvas.id, componentId: def.id }]
    expect(await actions.catchUpComponentsBehind()).toEqual({ components: 1, canvases: 1 })
    await propagation.whenIdle()
    expect(store.getFrame(page.id)!.html).toContain('Fresh')
    expect(store.getFrame(page.id)!.approval?.status).toBe('ready_for_dev')
  })

  it('does nothing when every instance is current', async () => {
    behind.list = []
    expect(await actions.catchUpComponentsBehind()).toEqual({ components: 0, canvases: 0 })
  })

  it('leaves frames alone while propagation is switched off', async () => {
    behind.list = [{ canvasId: 'any', componentId: 'any' }]
    stubEnv('DOOP_DEFER_COMPONENT_PROPAGATION', 'true')
    try {
      expect(await actions.catchUpComponentsBehind()).toEqual({ components: 0, canvases: 0 })
    } finally {
      unstubAllEnvs()
    }
  })

  it('finishes one canvas before it starts the next', async () => {
    const first = store.createCanvas('first', 'owner-catch-up')
    const second = store.createCanvas('second', 'owner-catch-up')
    const a = createComponentFromHtml(first.id, { name: 'A', html: '<span class="a">a</span>' }, actor).component
    const b = createComponentFromHtml(second.id, { name: 'B', html: '<span class="b">b</span>' }, actor).component
    await propagation.whenIdle()
    const order: string[] = []
    const waited = propagation.whenCanvasIdle
    const spy = vi.spyOn(propagation, 'whenCanvasIdle').mockImplementation(async (canvasId) => {
      order.push(`wait ${canvasId}`)
      return waited(canvasId)
    })
    const enqueue = propagation.enqueue
    const queued = vi.spyOn(propagation, 'enqueue').mockImplementation((...args: Parameters<typeof enqueue>) => {
      order.push(`queue ${args[1]}`)
      return enqueue(...args)
    })
    behind.list = [
      { canvasId: first.id, componentId: a.id },
      { canvasId: second.id, componentId: b.id },
    ]
    await actions.catchUpComponentsBehind()
    expect(order).toEqual([`queue ${first.id}`, `wait ${first.id}`, `queue ${second.id}`, `wait ${second.id}`])
    spy.mockRestore()
    queued.mockRestore()
  })
})
