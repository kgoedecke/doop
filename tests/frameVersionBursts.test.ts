import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { AGENT_VERSION_MS } from '../server/actions.ts'
import * as persist from '../server/db/persist.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* The burst rules live in the action layer; persistence is mocked so the
 * test can read which states were filed, in order. */
vi.mock('../server/db/persist.ts', () => ({
  refreshAssetRefs: () => {},
  saveFrame: () => {},
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

  describe('an agent’s edits minutes apart', () => {
    let now = 1_000_000
    beforeEach(() => {
      now = 1_000_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
    })
    afterEach(() => vi.restoreAllMocks())

    it('files the state an edit replaced once 30 s have passed since the last version', () => {
      const frame = actions.createFrame(CANVAS.id, { name: 'hero', html: doc('<h1>One</h1>') }, agent)!
      now += 5_000
      actions.updateFrame(frame.id, { html: doc('<h1>One!</h1>') }, agent)
      now += 10_000
      actions.updateFrame(frame.id, { html: doc('<h1>One!!</h1>') }, agent)
      now += AGENT_VERSION_MS
      actions.updateFrame(frame.id, { html: doc('<h1>One!!!</h1>') }, agent)
      expect(filed()).toEqual([doc('<h1>One</h1>'), doc('<h1>One!!</h1>')])
    })

    it('makes an edit after a stream undoable, and files no chunk of the stream itself', () => {
      const frame = actions.createFrame(CANVAS.id, { name: 'hero' }, agent)!
      actions.appendFrameHtml(frame.id, `<!doctype html><html><head>${STYLE}</head><body>`, agent, { start: true })
      now += 40_000
      actions.appendFrameHtml(frame.id, '<h1>Streamed</h1>', agent)
      now += 40_000
      actions.appendFrameHtml(frame.id, '</body></html>', agent, { done: true })
      expect(filed()).toEqual([])
      const streamed = store.getFrame(frame.id)!.html
      now += 60_000
      actions.updateFrame(frame.id, { html: streamed.replace('Streamed', 'Edited') }, agent)
      expect(filed()).toEqual([streamed])
    })

    it('keeps a person’s tweaks in one burst while they keep editing', () => {
      const human = actions.resolveActor({ name: 'Vera', kind: 'user' })
      const frame = actions.createFrame(CANVAS.id, { name: 'hero', html: doc('<h1>One</h1>') }, human)!
      actions.updateFrame(frame.id, { html: doc('<h1>Two</h1>') }, human, { replace: true })
      now += 60_000
      actions.updateFrame(frame.id, { html: doc('<h1>Two!</h1>') }, human)
      now += 60_000
      actions.updateFrame(frame.id, { html: doc('<h1>Two!!</h1>') }, human)
      expect(filed()).toEqual([doc('<h1>One</h1>')])
    })
  })
})
