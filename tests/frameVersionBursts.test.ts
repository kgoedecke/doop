import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { randomUUID } from 'node:crypto'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* The burst rules live in the frame actor; SQL persistence is mocked (no
 * legacy history), so the versions listed are the ones the actor filed. */
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  loadLegacyFrameIds: async () => [],
  listFrameVersions: async () => [],
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

let CANVAS: Canvas

/* a big shared wrapper: two different designs that keep it still share well
   over half their text at the start and the end */
const STYLE = `<style>${'body{margin:0;font-family:sans-serif}\n'.repeat(40)}</style>`
const doc = (body: string) => `<!doctype html><html><head>${STYLE}</head><body>${body}</body></html>`

const agent = actions.resolveActor({ name: 'Claude', kind: 'agent' })

/** the states filed so far, oldest first */
async function filed(frameId: string): Promise<string[]> {
  const versions = await actions.listFrameVersions(frameId)
  return Promise.all(versions.reverse().map(async (v) => (await actions.getFrameVersion(frameId, v.id))!.html))
}

describe('frame history bursts', () => {
  beforeEach(() => {
    CANVAS = { id: randomUUID(), name: 'Bursts', ownerId: 'owner-1', createdAt: 0, updatedAt: 0, frames: [] }
    store.init([CANVAS])
  })

  it('files every explicit replace, however much of the document it keeps', async () => {
    const frame = (await actions.createFrame(CANVAS.id, { name: 'hero', html: doc('<h1>One</h1>') }, agent))!
    await actions.updateFrame(frame.id, { html: doc('<h1>Two</h1>') }, agent, { replace: true })
    await actions.updateFrame(frame.id, { html: doc('<h1>Three</h1>') }, agent, { replace: true })
    expect(await filed(frame.id)).toEqual([doc('<h1>One</h1>'), doc('<h1>Two</h1>')])
  })

  it('folds a tweak into the burst of the replace it follows', async () => {
    const frame = (await actions.createFrame(CANVAS.id, { name: 'hero', html: doc('<h1>One</h1>') }, agent))!
    await actions.updateFrame(frame.id, { html: doc('<h1>Two</h1>') }, agent, { replace: true })
    await actions.updateFrame(frame.id, { html: doc('<h1>Two!</h1>') }, agent)
    await actions.updateFrame(frame.id, { html: doc('<h1>Two!!</h1>') }, agent)
    expect(await filed(frame.id)).toEqual([doc('<h1>One</h1>')])
  })

  it('opens a burst when another actor takes over, tweak or not', async () => {
    const frame = (await actions.createFrame(CANVAS.id, { name: 'hero', html: doc('<h1>One</h1>') }, agent))!
    const human = actions.resolveActor({ name: 'Vera', kind: 'user' })
    await actions.updateFrame(frame.id, { html: doc('<h1>One!</h1>') }, human)
    expect(await filed(frame.id)).toEqual([doc('<h1>One</h1>')])
  })
})
