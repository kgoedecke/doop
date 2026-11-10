import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import * as persist from '../server/db/persist.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* The burst rules live in the action layer; persistence is mocked so the
 * test can read which states were filed, in order. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  insertCanvas: async () => {},
  saveCanvas: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  saveFrameVersion: vi.fn(),
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const CANVAS: Canvas = { id: 'c1', name: 'Bursts', ownerId: 'owner-1', createdAt: 0, updatedAt: 0, frames: [] }

/* a big shared wrapper: two different designs that keep it still share well
   over half their text at the start and the end */
const STYLE = `<style>${'body{margin:0;font-family:sans-serif}\n'.repeat(40)}</style>`
const doc = (body: string) => `<!doctype html><html><head>${STYLE}</head><body>${body}</body></html>`

const agent = actions.resolveActor({ name: 'Claude', kind: 'agent' })

function filed(): string[] {
  return vi.mocked(persist.saveFrameVersion).mock.calls.map(([version]) => version.html)
}

describe('frame history bursts', () => {
  beforeEach(() => {
    vi.mocked(persist.saveFrameVersion).mockClear()
    store.init([structuredClone(CANVAS)])
  })

  it('files every explicit replace, however much of the document it keeps', () => {
    const frame = actions.createFrame(CANVAS.id, { name: 'hero', html: doc('<h1>One</h1>') }, agent)!
    actions.updateFrame(frame.id, { html: doc('<h1>Two</h1>') }, agent, { replace: true })
    actions.updateFrame(frame.id, { html: doc('<h1>Three</h1>') }, agent, { replace: true })
    expect(filed()).toEqual([doc('<h1>One</h1>'), doc('<h1>Two</h1>')])
  })

  it('folds a tweak into the burst of the replace it follows', () => {
    const frame = actions.createFrame(CANVAS.id, { name: 'hero', html: doc('<h1>One</h1>') }, agent)!
    actions.updateFrame(frame.id, { html: doc('<h1>Two</h1>') }, agent, { replace: true })
    actions.updateFrame(frame.id, { html: doc('<h1>Two!</h1>') }, agent)
    actions.updateFrame(frame.id, { html: doc('<h1>Two!!</h1>') }, agent)
    expect(filed()).toEqual([doc('<h1>One</h1>')])
  })

  it('opens a burst when another actor takes over, tweak or not', () => {
    const frame = actions.createFrame(CANVAS.id, { name: 'hero', html: doc('<h1>One</h1>') }, agent)!
    const human = actions.resolveActor({ name: 'Vera', kind: 'user' })
    actions.updateFrame(frame.id, { html: doc('<h1>One!</h1>') }, human)
    expect(filed()).toEqual([doc('<h1>One</h1>')])
  })
})
