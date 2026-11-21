import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

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
  getFrameVersion: async () => ({
    html: '<img src="https://api.iconify.design/mdi/star.svg">',
    width: 100,
    height: 100,
  }),
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))

vi.useFakeTimers({ now: 1_000_000 })
const ORIGIN = 'https://doop.test'
stubEnv('BETTER_AUTH_URL', ORIGIN)
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { iconData } = await import('../server/iconData.ts')
const { withIconAssets } = await import('../server/frameIcons.ts')

/**
 * Frame HTML that hotlinks Iconify is saved, and streamed to viewers, pointed
 * at Doop's stored copies, and saving it starts the icon downloads, so a
 * canvas full of icons never bursts the public API from viewers' browsers.
 */

const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
const HOTLINK = 'https://api.iconify.design/mdi/home.svg?color=%23ff0000&amp;height=24'
const LOCAL = `${ORIGIN}/a/iconify/mdi/home.svg?color=%23ff0000&amp;height=24`

const sent: { frameId: string; html: string }[] = []
actions.wire(
  (_canvasId, msg) => {
    if (msg.type === 'frame:updated') sent.push({ frameId: msg.frame.id, html: msg.frame.html })
  },
  () => {},
)

const warmed = vi.spyOn(iconData, 'get')
beforeEach(() => {
  sent.length = 0
  warmed.mockReset().mockResolvedValue({ body: '' })
})
afterAll(() => unstubAllEnvs())

describe('withIconAssets', () => {
  it('rewrites slash and colon hotlinks in attributes, srcsets and CSS, keeping the query as written', () => {
    const html = [
      `<img src="${HOTLINK}">`,
      '<img srcset="https://api.iconify.design/mdi:menu.svg 1x, https://api.iconify.design/mdi/menu.svg?height=48 2x">',
      '<i style="mask:url(https://api.iconify.design/lucide/x.svg) no-repeat"></i>',
      "<style>.a{background:url('https://api.iconify.design/lucide/check.svg?color=white')}</style>",
    ].join('')
    expect(withIconAssets(html, ORIGIN)).toBe(
      [
        `<img src="${LOCAL}">`,
        `<img srcset="${ORIGIN}/a/iconify/mdi/menu.svg 1x, ${ORIGIN}/a/iconify/mdi/menu.svg?height=48 2x">`,
        `<i style="mask:url(${ORIGIN}/a/iconify/lucide/x.svg) no-repeat"></i>`,
        `<style>.a{background:url('${ORIGIN}/a/iconify/lucide/check.svg?color=white')}</style>`,
      ].join(''),
    )
  })

  it('leaves URLs the icon route would refuse, and other hosts, as written', () => {
    const html = [
      '<img src="https://api.iconify.design/mdi/home.svg?unknown=1">',
      '<img src="https://api.iconify.design/mdi/home.svg?color=not-a-color">',
      '<img src="https://api.iconify.design/mdi.json?icons=home">',
      '<img src="https://evil.test/api.iconify.design/mdi/home.svg">',
    ].join('')
    expect(withIconAssets(html, ORIGIN)).toBe(html)
  })
})

describe('icons on frame writes', () => {
  it('points a created frame at the stored copies and starts their download', () => {
    const canvasId = store.createCanvas('icons', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero', html: `<img src="${HOTLINK}">` }, agent)!
    expect(store.getFrame(frame.id)!.html).toBe(`<img src="${LOCAL}">`)
    expect(warmed).toHaveBeenCalledWith('mdi:home')
  })

  it('rewrites an edit, and a version restore', async () => {
    const canvasId = store.createCanvas('icons', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero', html: '<p>hi</p>' }, agent)!
    actions.updateFrame(frame.id, { html: '<img src="https://api.iconify.design/lucide:x.svg">' }, agent)
    expect(store.getFrame(frame.id)!.html).toBe(`<img src="${ORIGIN}/a/iconify/lucide/x.svg">`)
    await actions.restoreFrameVersion(frame.id, 'v1', agent)
    expect(store.getFrame(frame.id)!.html).toBe(`<img src="${ORIGIN}/a/iconify/mdi/star.svg">`)
    expect(warmed).toHaveBeenCalledWith('mdi:star')
  })

  it('sends viewers rewritten partials mid-stream and stores the rewrite with the done chunk', () => {
    const canvasId = store.createCanvas('icons', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, agent)!
    actions.appendFrameHtml(frame.id, `<body><img src="${HOTLINK}">`, agent, { start: true })
    const partial = sent.filter((m) => m.frameId === frame.id).at(-1)!
    expect(partial.html).toContain(LOCAL)
    expect(partial.html).not.toContain('api.iconify.design')
    actions.appendFrameHtml(frame.id, '</body>', agent, { done: true })
    expect(store.getFrame(frame.id)!.html).toBe(`<body><img src="${LOCAL}"></body>`)
    expect(warmed).toHaveBeenCalledWith('mdi:home')
  })

  it('stores the rewrite when an unfinished stream goes idle', () => {
    const canvasId = store.createCanvas('icons', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, agent)!
    actions.appendFrameHtml(frame.id, `<body><img src="${HOTLINK}">`, agent, { start: true })
    vi.advanceTimersByTime(31_000)
    expect(store.getFrame(frame.id)!.html).toContain(LOCAL)
  })

  it('survives a failed download: the frame saves and the viewer request retries later', () => {
    warmed.mockRejectedValue(new Error('rate limited'))
    const canvasId = store.createCanvas('icons', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Hero', html: `<img src="${HOTLINK}">` }, agent)!
    expect(store.getFrame(frame.id)!.html).toBe(`<img src="${LOCAL}">`)
  })
})
