import { describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'
import type { CustomFont } from '../shared/fonts'
import { healPartialHtml } from '../shared/frame-html'

/* Frame writes land in the canvas actor, which is what viewers read; the rest
   mirrors into Postgres and broadcasts. Only the saved HTML and what viewers
   are sent matter here. The stream idle sweep is a module-level interval, so
   the interval and the clock are faked before actions.ts loads; timeouts stay
   real, since the canvas actor answers over the network. */
vi.mock('../server/db/persist.ts', () => ({
  loadLegacyFrameIds: async () => [],
  saveToken: () => {},
  deleteToken: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
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

vi.useFakeTimers({ now: 1_000_000, toFake: ['setInterval', 'clearInterval', 'Date'] })
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { watchCanvas } = await import('./canvasViewer.ts')

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

const html = async (frameId: string) => (await store.getFrame(frameId))!.html

/** Run the idle sweep past a stream's timeout and wait for its closing write. */
async function goIdle(frameId: string) {
  vi.advanceTimersByTime(31_000)
  await vi.waitFor(async () => expect(await html(frameId)).toContain(BRAND.url))
}

describe('library faces on frame writes', () => {
  it('adds them on create', async () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const frame = (await actions.createFrame(canvasId, { name: 'Hero', html: `${DESIGN}</body></html>` }, agent))!
    expect(await html(frame.id)).toContain(BRAND.url)
  })

  it('links a hosted family the design names, next to the library faces', async () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const design = `${DESIGN}<p style="font-family: 'Space Grotesk', sans-serif">x</p></body></html>`
    const frame = (await actions.createFrame(canvasId, { name: 'Hero', html: design }, agent))!
    const saved = await html(frame.id)
    expect(saved).toContain(BRAND.url)
    expect(saved).toContain('data-doop-webfonts')
    expect(saved).toContain('family=Space+Grotesk:')
    /* an uploaded family is never also linked from Google Fonts */
    expect(saved).not.toContain('family=Brand+Sans')
  })

  it('finds a family named only through a font token', async () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const human: Actor = { name: 'Kevin', kind: 'user', color: '#2743ee' }
    await actions.createTokens(
      canvasId,
      [{ name: '--font-body', type: 'fontFamily', value: '"Brand Sans", sans-serif' }],
      human,
    )
    const frame = (await actions.createFrame(
      canvasId,
      { name: 'Hero', html: '<html><head></head><body style="font-family:var(--font-body)">Hi</body></html>' },
      agent,
    ))!
    expect(await html(frame.id)).toContain(BRAND.url)
    /* and a token change to a hosted family links it */
    await actions.setTokens(canvasId, [{ name: '--font-body', value: '"Space Grotesk", sans-serif' }], human)
    expect(await html(frame.id)).toContain('family=Space+Grotesk:')
  })

  it('adds them with the done chunk of a stream, not before', async () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const frame = (await actions.createFrame(canvasId, { name: 'Hero' }, agent))!
    await actions.appendFrameHtml(frame.id, DESIGN, agent, { start: true })
    expect(await html(frame.id)).not.toContain(BRAND.url)
    await actions.appendFrameHtml(frame.id, '</body></html>', agent, { done: true })
    expect(await html(frame.id)).toContain(BRAND.url)
  })

  it('adds them when an unfinished stream goes idle', async () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const frame = (await actions.createFrame(canvasId, { name: 'Hero' }, agent))!
    await actions.appendFrameHtml(frame.id, DESIGN, agent, { start: true })
    const viewer = await watchCanvas(canvasId)
    try {
      await goIdle(frame.id)
      /* and open canvases are sent the document with the faces, not just the store */
      await viewer.caughtUp()
      expect(viewer.sentFor(frame.id).some((change) => change.frame.html.includes(BRAND.url))).toBe(true)
    } finally {
      viewer.close()
    }
  })

  it('never sends viewers a script the stream left unfinished', async () => {
    const canvasId = store.createCanvas('fonts', 'kevin').id
    const frame = (await actions.createFrame(canvasId, { name: 'Hero' }, agent))!
    await actions.appendFrameHtml(frame.id, `${DESIGN}<script>document.body.innerHTML = ''; // and then`, agent, {
      start: true,
    })
    const viewer = await watchCanvas(canvasId)
    try {
      await goIdle(frame.id)
      await viewer.caughtUp()
      const last = viewer.sentFor(frame.id).at(-1)!
      expect(last.frame.html).toContain(BRAND.url)
      /* marked partial: viewers heal it, which drops the half-written script */
      expect(last.partial).toBe(true)
      expect(healPartialHtml(last.frame.html)).not.toContain('<script>')
      /* the store keeps what the agent actually sent */
      expect(await html(frame.id)).toContain('<script>')
    } finally {
      viewer.close()
    }
  })
})
