import { describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'
import type { CustomFont } from '../shared/fonts'

/* Frame writes mirror into Postgres and broadcast; only the saved HTML
   matters here. The stream idle sweep is a module-level interval, so the
   clock is faked before actions.ts loads. */
vi.mock('../server/db/persist.ts', () => ({
  saveToken: () => {},
  deleteToken: () => {},
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

/* what open canvases are sent: the frame HTML each frame:updated carried */
const sent: { frameId: string; html: string }[] = []
actions.wire(
  (_canvasId, msg) => {
    if (msg.type === 'frame:updated') sent.push({ frameId: msg.frame.id, html: msg.frame.html })
  },
  () => {},
)

describe('library faces on frame writes', () => {
  it('adds them on create', () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero', html: `${DESIGN}</body></html>` }, agent)!
    expect(store.getFrame(frame.id)!.html).toContain(BRAND.url)
  })

  it('links a hosted family the design names, next to the library faces', () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const html = `${DESIGN}<p style="font-family: 'Space Grotesk', sans-serif">x</p></body></html>`
    const frame = actions.createFrame(canvasId, { name: 'Hero', html }, agent)!
    const saved = store.getFrame(frame.id)!.html
    expect(saved).toContain(BRAND.url)
    expect(saved).toContain('data-doop-webfonts')
    expect(saved).toContain('family=Space+Grotesk:')
    /* an uploaded family is never also linked from Google Fonts */
    expect(saved).not.toContain('family=Brand+Sans')
  })

  it('finds a family named only through a font token', () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }
    actions.createTokens(
      canvasId,
      [{ name: '--font-body', type: 'fontFamily', value: '"Brand Sans", sans-serif' }],
      human,
    )
    const frame = actions.createFrame(
      canvasId,
      { name: 'Hero', html: '<html><head></head><body style="font-family:var(--font-body)">Hi</body></html>' },
      agent,
    )!
    expect(store.getFrame(frame.id)!.html).toContain(BRAND.url)
    /* and a token change to a hosted family links it */
    actions.setTokens(canvasId, [{ name: '--font-body', value: '"Space Grotesk", sans-serif' }], human)
    expect(store.getFrame(frame.id)!.html).toContain('family=Space+Grotesk:')
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
    sent.length = 0
    vi.advanceTimersByTime(31_000)
    expect(store.getFrame(frame.id)!.html).toContain(BRAND.url)
    /* and open canvases are sent the document with the faces, not just the store */
    expect(sent.some((m) => m.frameId === frame.id && m.html.includes(BRAND.url))).toBe(true)
  })

  it('never sends viewers a script the stream left unfinished', () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, agent)!
    actions.appendFrameHtml(frame.id, `${DESIGN}<script>document.body.innerHTML = ''; // and then`, agent, {
      start: true,
    })
    sent.length = 0
    vi.advanceTimersByTime(31_000)
    const last = sent.filter((m) => m.frameId === frame.id).at(-1)!
    expect(last.html).toContain(BRAND.url)
    expect(last.html).not.toContain('<script>')
    /* the store keeps what the agent actually sent */
    expect(store.getFrame(frame.id)!.html).toContain('<script>')
  })
})
