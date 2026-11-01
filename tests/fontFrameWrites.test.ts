import { describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'
import type { CustomFont } from '../shared/fonts'

/* Frame writes mirror into Postgres and broadcast; only the saved HTML
   matters here. The stream idle sweep is a module-level interval, so the
   clock is faked before actions.ts loads. */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
}))

const BRAND: CustomFont = {
  id: 'f1',
  family: 'Brand Sans',
  weight: '400',
  style: 'normal',
  format: 'woff2',
  url: 'https://doop.test/a/brand.woff2',
  fileName: 'brand.woff2',
  size: 1,
  createdAt: 1,
}
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [BRAND] }))

vi.useFakeTimers({ now: 1_000_000 })
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

/**
 * A frame write that names a library family gets that family's @font-face —
 * on a one-shot create, at the end of an append stream, and when a stream is
 * left unfinished and the idle sweep closes it.
 */

const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
const DESIGN = `<!doctype html><html><head></head><body><h1 style="font-family:'Brand Sans'">Hi</h1>`

actions.wire(
  () => {},
  () => {},
)

describe('library faces on frame writes', () => {
  it('adds them on create', () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero', html: `${DESIGN}</body></html>` }, agent)!
    expect(store.getFrame(frame.id)!.html).toContain(BRAND.url)
  })

  it('adds them with the done chunk of a stream, not before', () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, agent)!
    actions.appendFrameHtml(frame.id, DESIGN, agent, { start: true })
    expect(store.getFrame(frame.id)!.html).not.toContain(BRAND.url)
    actions.appendFrameHtml(frame.id, '</body></html>', agent, { done: true })
    expect(store.getFrame(frame.id)!.html).toContain(BRAND.url)
  })

  it('adds them when an unfinished stream goes idle', () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, agent)!
    actions.appendFrameHtml(frame.id, DESIGN, agent, { start: true })
    vi.advanceTimersByTime(31_000)
    expect(store.getFrame(frame.id)!.html).toContain(BRAND.url)
  })
})
