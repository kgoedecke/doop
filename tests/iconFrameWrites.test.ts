import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

/* Frame writes mirror into Postgres and broadcast; only the saved and sent
   HTML matter here. The stream idle sweep is a module-level interval, so the
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
  saveFrameVersion: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))
/* the bucket, in memory: nothing is ever stored, so every warm reaches Iconify */
vi.mock('../server/storage.ts', () => ({
  getObject: async () => null,
  putObject: async () => {},
}))

vi.useFakeTimers({ now: 1_000_000 })
const { env } = await import('../server/env.ts')
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

/**
 * Frame HTML that hotlinks Iconify is saved, and streamed to viewers, pointed
 * at Doop's copies, and saving it starts fetching them: a canvas full of icons
 * never bursts api.iconify.design from viewers' browsers (it answers with 429
 * and the icons stay blank until a reload).
 */

const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
const HOTLINK = 'https://api.iconify.design/mdi/home.svg?color=%23ff0000&amp;height=24'
const HOSTED = `${env.BETTER_AUTH_URL}/icons/iconify/mdi/home.svg?color=%23ff0000&amp;height=24`

const sent: { frameId: string; html: string }[] = []
actions.wire(
  (_canvasId, msg) => {
    if (msg.type === 'frame:updated') sent.push({ frameId: msg.frame.id, html: msg.frame.html })
  },
  () => {},
)

/* Iconify, answering whatever it is asked once `answer` is called */
let fetched: string[] = []
let answer: () => void = () => {}
beforeEach(() => {
  sent.length = 0
  fetched = []
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  answer = release
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url)
    await released
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } })
  })
})
afterEach(() => {
  answer()
  vi.unstubAllGlobals()
})

/* let the warm's bucket lookups and fetches run */
const settle = () => vi.advanceTimersByTimeAsync(1)

describe('icons on frame writes', () => {
  it('points a created frame at Doop’s copies, slash and colon forms, and starts fetching them', async () => {
    const canvasId = store.createCanvas('icons', 'kevin').id
    const html = `<img src="${HOTLINK}"><i style="mask:url(https://api.iconify.design/lucide:x.svg)"></i>`
    const frame = actions.createFrame(canvasId, { name: 'Hero', html }, agent)!
    expect(store.getFrame(frame.id)!.html).toBe(
      `<img src="${HOSTED}"><i style="mask:url(${env.BETTER_AUTH_URL}/icons/iconify/lucide/x.svg)"></i>`,
    )
    await settle()
    expect(fetched.sort()).toEqual([
      'https://api.iconify.design/lucide/x.svg',
      'https://api.iconify.design/mdi/home.svg?color=%23ff0000&height=24',
    ])
  })

  it('rewrites an edit', () => {
    const canvasId = store.createCanvas('icons', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero', html: '<p>hi</p>' }, agent)!
    actions.updateFrame(frame.id, { html: `<img src="${HOTLINK}">` }, agent)
    expect(store.getFrame(frame.id)!.html).toBe(`<img src="${HOSTED}">`)
  })

  it('sends viewers rewritten partials before the stream’s top settles, and stores the rewrite at the end', () => {
    const canvasId = store.createCanvas('icons', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, agent)!
    actions.appendFrameHtml(frame.id, `<img src="${HOTLINK}">`, agent, { start: true })
    const partial = sent.filter((m) => m.frameId === frame.id).at(-1)!
    expect(partial.html).toBe(`<img src="${HOSTED}">`)
    actions.appendFrameHtml(frame.id, '<p>done</p>', agent, { done: true })
    expect(store.getFrame(frame.id)!.html).toBe(`<img src="${HOSTED}"><p>done</p>`)
  })

  it('warms two icons at a time, leaving the route’s other fetch slots to viewers', async () => {
    const canvasId = store.createCanvas('icons', 'kevin').id
    const html = ['a', 'b', 'c', 'd', 'e'].map((name) => `<img src="https://api.iconify.design/mdi/${name}.svg">`)
    actions.createFrame(canvasId, { name: 'Hero', html: html.join('') }, agent)
    await settle()
    expect(fetched).toHaveLength(2)
    answer()
    await settle()
    expect(fetched).toHaveLength(5)
  })

  it('saves the frame when Iconify fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('error code: 1015', { status: 429 }))
    const canvasId = store.createCanvas('icons', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero', html: `<img src="${HOTLINK}">` }, agent)!
    await settle()
    expect(store.getFrame(frame.id)!.html).toBe(`<img src="${HOSTED}">`)
  })
})
