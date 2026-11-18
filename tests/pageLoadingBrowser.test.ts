import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { ClientMessage, Frame, ServerMessage, WireCanvas, WireFrame } from '../shared/types'

declare global {
  interface Window {
    room: { sent: ClientMessage[]; deliver: (message: ServerMessage) => void }
    openPage: (pageId: string) => void
    flyTo: (frameId: string) => void
    camera: () => { x: number; y: number; zoom: number }
    loadingState: () => {
      activePageId: string
      stalePages: string[]
      selectedId: string | null
      selectedElement: { frameId: string; selector: string } | null
      frames: Record<string, string>
    }
  }
}

/* The editor holds one page's frame HTML at a time from the room: `init`
   carries the opening page's, a page opened later is asked for with
   `page:load` and shown once `page:frames` brings it, never from a blank or
   stale copy. The room is played by the test (tests/fixtures/pageLoading.html). */

const frame = (id: string, pageId: string, html: string): Frame => ({
  id,
  canvasId: 'c',
  pageId,
  name: id,
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  html,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'User',
})

const home = frame('home', 'first', '<h1>Home</h1>')
const target = frame('target', 'second', '<h1 id="one" data-doop-id="one000">One</h1>')

/** The canvas as the room's init sends it: HTML only on `loaded` pages. */
function wireCanvas(loaded: string[], all: Frame[] = [home, target]): WireCanvas {
  const frames: WireFrame[] = all.map(({ html, ...meta }) => (loaded.includes(meta.pageId!) ? { ...meta, html } : meta))
  return {
    id: 'c',
    name: 'Design',
    pages: [
      { id: 'first', name: 'Main' },
      { id: 'second', name: 'Exploration' },
    ],
    frames,
    createdAt: 0,
    updatedAt: 0,
    role: 'edit',
  }
}

describe.skipIf(!findBrowserPath())('pages loaded from the room', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1200, height: 800 })
  })

  /** Open the fixture on `query`, answer its join with an init holding `loaded`. */
  async function open(query: string, loaded: string[], frames?: Frame[]) {
    await page.goto(fixtureUrl(`pageLoading.html${query}`))
    await page.waitForFunction(() => window.room?.sent.some((message) => message.type === 'join'))
    const join = await page.evaluate(() => window.room.sent.find((message) => message.type === 'join'))
    await page.evaluate(
      (canvas, loadedPageIds) =>
        window.room.deliver({
          type: 'init',
          canvas,
          loadedPageIds,
          presences: [],
          activity: [],
          tasks: [],
          feedback: [],
          comments: [],
          decisions: [],
          proposals: [],
          selfColor: '#000',
          serverBuild: 'dev',
        }),
      wireCanvas(loaded, frames),
      loaded,
    )
    return join
  }

  const pageLoads = () =>
    page.evaluate(() => window.room.sent.flatMap((message) => (message.type === 'page:load' ? [message.pageId] : [])))

  async function deliverPage(pageId: string, frames: Frame[]) {
    await page.evaluate(
      (pageId, frames) => window.room.deliver({ type: 'page:frames', pageId, frames }),
      pageId,
      frames,
    )
  }

  it('asks for another page when it opens, and shows it once its frames arrive', async () => {
    const join = await open('', ['first'])
    expect(join).toMatchObject({ type: 'join', canvasId: 'c' })
    await page.waitForSelector('iframe[title="home"]')
    expect(await pageLoads()).toEqual([])

    await page.evaluate(() => window.openPage('second'))
    await page.waitForFunction(() => window.room.sent.some((message) => message.type === 'page:load'))
    expect(await pageLoads()).toEqual(['second'])
    /* nothing of the page is drawn from HTML this browser does not have; the stage says it is on its way */
    expect(await page.$('iframe[title="target"]')).toBeNull()
    await page.waitForSelector('[data-page-loading]')

    await deliverPage('second', [target])
    await page.waitForSelector('iframe[title="target"]')
    expect(await page.$('[data-page-loading]')).toBeNull()
    expect((await page.evaluate(() => window.loadingState())).frames.target).toBe(target.html)

    /* back and forth again: both pages are held now, nothing more is asked for */
    await page.evaluate(() => window.openPage('first'))
    await page.waitForSelector('iframe[title="home"]')
    await page.evaluate(() => window.openPage('second'))
    await page.waitForSelector('iframe[title="target"]')
    expect(await pageLoads()).toEqual(['second'])
  })

  it('reads a held page again after the room sent one of its frames without HTML', async () => {
    await open('', ['first'])
    await page.waitForSelector('iframe[title="home"]')
    await page.evaluate(() => window.openPage('second'))
    await deliverPage('second', [target])
    await page.waitForSelector('iframe[title="target"]')
    await page.evaluate(() => window.openPage('first'))
    await page.waitForSelector('iframe[title="home"]')

    /* an edit made while this browser held the page but the room could not send its HTML */
    const { html: _html, ...meta } = { ...target, name: 'target', updatedAt: 5 }
    await page.evaluate(
      (frame) =>
        window.room.deliver({ type: 'frame:updated', frame, actor: { name: 'Ada', kind: 'user', color: '#f00' } }),
      meta,
    )
    await page.waitForFunction(() => window.loadingState().stalePages.includes('second'))
    await page.evaluate(() => window.openPage('second'))
    await page.waitForFunction(() => window.room.sent.filter((message) => message.type === 'page:load').length === 2)
    expect(await page.$('iframe[title="target"]')).toBeNull()
    await deliverPage('second', [{ ...target, html: '<h1>Edited</h1>', updatedAt: 5 }])
    await page.waitForSelector('iframe[title="target"]')
    expect((await page.evaluate(() => window.loadingState())).frames.target).toBe('<h1>Edited</h1>')
  })

  it('opens an element link to a page this browser has not read yet', async () => {
    await open('', ['first'])
    await page.waitForSelector('iframe[title="home"]')
    await page.evaluate(() => {
      history.pushState(null, '', '?frame=target&element=one000')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForFunction(() => window.loadingState().activePageId === 'second')
    await page.waitForFunction(() => window.room.sent.some((message) => message.type === 'page:load'))
    await deliverPage('second', [target])
    await page.waitForFunction(() => window.loadingState().selectedElement?.selector === '#one')
    expect((await page.evaluate(() => window.loadingState())).selectedId).toBe('target')
  })

  it('asks the room, on joining, for the page the link opens on', async () => {
    const join = await open('?frame=target&element=one000', ['second'])
    expect(join).toMatchObject({ frameId: 'target' })
    await page.waitForFunction(() => window.loadingState().selectedElement?.selector === '#one')
    expect(await pageLoads()).toEqual([])
  })

  it('flies to a frame on a page this browser has not read, and stays on it when the page arrives', async () => {
    const far = { ...frame('far', 'second', '<h1>Far</h1>'), x: 3000, y: 2000 }
    await open('', ['first'], [home, far])
    await page.waitForSelector('iframe[title="home"]')
    const before = await page.evaluate(() => window.camera())

    await page.evaluate(() => window.flyTo('far'))
    await page.waitForFunction(() => window.room.sent.some((message) => message.type === 'page:load'))
    /* the camera glides to the frame's box while its HTML is on its way */
    await new Promise((resolve) => setTimeout(resolve, 900))
    const flown = await page.evaluate(() => window.camera())
    expect(flown).not.toEqual(before)

    await deliverPage('second', [far])
    await page.waitForSelector('iframe[title="far"]')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await page.evaluate(() => window.camera())).toEqual(flown)
  })
})
