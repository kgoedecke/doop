import { beforeEach, describe, expect, it } from 'vitest'
import type { Frame as BrowserFrame, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import { openCanvasPage, showCanvasPage } from './canvasPageFixture'
import type { Canvas, Frame } from '../shared/types'

declare global {
  interface Window {
    seedPages: (canvas: Canvas) => void
    pickElement: (frameId: string, selector: string) => void
    frameHtml: (frameId: string) => string | undefined
    trace: unknown[]
    pageState: () => {
      activePageId: string
      viewport: { x: number; y: number; zoom: number }
      selectedId: string
      selectedElement: { frameId: string; selector: string } | null
      elementPanelOpen: boolean
      inspectorOpen: boolean
      notice?: string
    }
  }
}
const frame = (id: string, pageId: string, x: number): Frame => ({
  id,
  canvasId: 'c',
  pageId,
  name: id,
  x,
  y: 0,
  width: 200,
  height: 200,
  html: '<h1>Design</h1>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'User',
})
const canvas = (frames: Frame[]): Canvas => ({
  id: 'c',
  name: 'Design',
  pages: [
    { id: 'first', name: 'Main' },
    { id: 'second', name: 'Exploration' },
  ],
  frames,
  createdAt: 0,
  updatedAt: 0,
})

/* Each test loads the whole app (hundreds of unbundled modules) in its own body,
   which on a busy CI runner can take longer than the 5 s default test timeout. */
describe.skipIf(!findBrowserPath())('page camera and snapping', { timeout: 30_000 }, () => {
  const pages = pagePerTest({ permissions: ['clipboard-read', 'clipboard-sanitized-write'] })
  let page: Page
  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1200, height: 800 })
  })

  /* a page-state wait that, when it never comes true, says what the page did */
  async function waitState(label: string, check: () => boolean) {
    try {
      await page.waitForFunction(check)
    } catch (error) {
      const trace = await page.evaluate(() => window.trace).catch(() => 'unavailable')
      const state = await page.evaluate(() => window.pageState()).catch(() => 'unavailable')
      throw new Error(`${label}: ${String(error)}\nstate ${JSON.stringify(state)}\ntrace ${JSON.stringify(trace)}`, {
        cause: error,
      })
    }
  }

  async function load(data: Canvas, query = '') {
    await page.goto(fixtureUrl(`pages.html${query}`))
    await page.waitForFunction(() => typeof window.seedPages === 'function')
    await page.evaluate((data) => window.seedPages(data), data)
    await page.waitForSelector('iframe[data-doop-frame]')
  }

  it('lets opted-in frames scroll a marked region without stealing canvas pan or zoom', async () => {
    const controls = '<input id="search" style="width:90px"><input id="toggle" type="checkbox">'
    const interactive = {
      ...frame('interactive', 'first', 0),
      html: `<!-- generated --><!doctype html><!-- tool --><html data-doop-interactive="true"><body>${controls}
        <div data-doop-scroll style="height:60px;overflow:auto;overscroll-behavior:contain"><div style="height:300px">Rows</div></div>
        </body></html>`,
    }
    const normal = { ...frame('normal', 'first', 360), html: controls }
    await load(canvas([interactive, normal]))
    const widget = (await (await page.waitForSelector('iframe[title="interactive"]'))!.contentFrame())!
    const ordinary = (await (await page.waitForSelector('iframe[title="normal"]'))!.contentFrame())!
    // The stage zooms CSS pixels; convert the iframe's local coordinates to screen coordinates.
    const click = async (document: BrowserFrame, selector: string) => {
      const { x, y } = await document.$eval(selector, (el) => {
        const rect = el.getBoundingClientRect()
        return { x: (rect.left + rect.width / 2) / innerWidth, y: (rect.top + rect.height / 2) / innerHeight }
      })
      const box = (await (await document.frameElement())?.boundingBox())!
      await page.mouse.click(box.x + x * box.width, box.y + y * box.height)
    }
    await ordinary.waitForSelector('#toggle')
    await click(ordinary, '#toggle')
    expect(await ordinary.$eval('#toggle', (el) => (el as HTMLInputElement).checked)).toBe(false)

    await widget.waitForSelector('#search')
    await click(widget, '#search')
    await page.keyboard.type('sample')
    expect(await widget.$eval('input', (el) => el.value)).toBe('sample')
    await click(widget, '#toggle')
    expect(await widget.$eval('#toggle', (el) => (el as HTMLInputElement).checked)).toBe(true)
    await page.keyboard.press('Space')
    expect(await widget.$eval('#toggle', (el) => (el as HTMLInputElement).checked)).toBe(false)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.activeElement?.tagName !== 'IFRAME', { timeout: 3000 })
    const startX = await page.evaluate(() => window.pageState().viewport.x)
    await page.keyboard.down('Space')
    const box = (await (await widget.frameElement()).boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 40)
    await page.mouse.down()
    await page.mouse.move(box.x + 80, box.y + 40, { steps: 3 })
    await page.mouse.up()
    await page.keyboard.up('Space')
    await page.waitForFunction((x) => window.pageState().viewport.x > x, { timeout: 3000 }, startX)
    const before = await page.evaluate(() => window.pageState().viewport)
    await click(widget, '[data-doop-scroll]')
    await page.mouse.wheel({ deltaY: 60 })
    await widget.waitForFunction(() => document.querySelector('[data-doop-scroll]')!.scrollTop > 0, { timeout: 3000 })
    expect(await page.evaluate(() => window.pageState().viewport)).toEqual(before)

    await page.keyboard.down('Control')
    await page.mouse.wheel({ deltaY: -10 })
    await page.keyboard.up('Control')
    await page.waitForFunction((zoom) => window.pageState().viewport.zoom !== zoom, { timeout: 3000 }, before.zoom)

    await click(widget, '#toggle')
    const y = await page.evaluate(() => window.pageState().viewport.y)
    await page.mouse.wheel({ deltaY: 30 })
    await page.waitForFunction((start) => window.pageState().viewport.y < start, { timeout: 3000 }, y)

    // Switching tools from the document must not trap Escape inside the iframe.
    await click(widget, '[data-doop-scroll]')
    await page.keyboard.press('h')
    await page.waitForFunction(() => {
      const el = document.querySelector('iframe[title="interactive"]')!
      const r = el.getBoundingClientRect()
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) !== el
    })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.activeElement?.tagName !== 'IFRAME', { timeout: 3000 })
    await click(widget, '#toggle')
    expect(await widget.$eval('#toggle', (el) => (el as HTMLInputElement).checked)).toBe(false)
  })

  it('keeps the pointer anchored during zoom and middle-drag over a rotated live frame', async () => {
    const tilted = {
      ...frame('tilted', 'first', 0),
      width: 280,
      rotation: 90,
      html: '<html data-doop-interactive="true"><body><button>Go</button></body></html>',
    }
    await load(canvas([tilted]))
    const host = (await page.waitForSelector('iframe[title="tilted"]'))!
    await (await host.contentFrame())!.waitForSelector('button')
    const before = (await host.boundingBox())!
    const x = before.x + before.width * 0.25
    const y = before.y + before.height * 0.7
    await page.mouse.move(x, y)
    await page.keyboard.down('Control')
    await page.mouse.wheel({ deltaY: -35 })
    await page.keyboard.up('Control')
    await page.waitForFunction(
      (w) => document.querySelector('iframe[title="tilted"]')!.getBoundingClientRect().width > w + 1,
      {},
      before.width,
    )
    const after = (await host.boundingBox())!
    expect(Math.abs(after.x + after.width * 0.25 - x)).toBeLessThan(2)
    expect(Math.abs(after.y + after.height * 0.7 - y)).toBeLessThan(2)
    const start = await page.evaluate(() => window.pageState().viewport)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(x + 30, y - 20, { steps: 4 })
    await page.mouse.up({ button: 'middle' })
    await page.waitForFunction(
      ({ x, y }) => {
        const p = window.pageState().viewport
        return Math.abs(p.x - x - 30) < 2 && Math.abs(p.y - y + 20) < 2
      },
      { timeout: 3000 },
      start,
    )
  })

  it('centers the linked frame on a different page instead of fitting its distant siblings', async () => {
    await load(
      canvas([frame('original', 'first', 0), frame('target', 'second', 3000), frame('distant', 'second', 12000)]),
      '?frame=target',
    )
    await page.waitForFunction(() => window.pageState().activePageId === 'second')
    await page.waitForFunction(() => window.pageState().viewport.zoom === 1 && window.pageState().viewport.x === -2500)
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: 'second',
      selectedId: 'target',
      viewport: { x: -2500, y: 300, zoom: 1 },
    })
    expect(await page.$('iframe[title="original"]')).toBeNull()
  })

  it.each(['first', 'second'])('selects a linked element after its frame mounts on the %s page', async (pageId) => {
    const target = {
      ...frame('target', pageId, 3000),
      html: '<main id="hero"><h1 data-doop-id="h1h1h1">Design</h1></main>',
    }
    /* the link names the element by id; once found, the selection speaks
       the positional path the Layers panel knows */
    const selector = '#hero > h1:nth-of-type(1)'
    await load(
      canvas([frame('original', 'first', 0), target]),
      `?${new URLSearchParams({ frame: target.id, element: 'h1h1h1' })}`,
    )
    await page.waitForSelector('button[aria-label="Copy link to element"]')
    await page.waitForFunction((sel) => window.pageState().selectedElement?.selector === sel, {}, selector)
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: pageId,
      selectedId: target.id,
      selectedElement: { frameId: target.id, selector },
      elementPanelOpen: true,
      inspectorOpen: false,
      viewport: { x: -2500, y: 300, zoom: 1 },
    })

    // Copy through the actual element toolbar, then reopen the resulting URL.
    await page.locator('button[aria-label="Copy link to element"]').click()
    await page.waitForFunction(() => window.pageState().notice === 'Element link copied')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    const url = new URL(copied)
    expect(url.pathname).toBe('/c/c')
    expect(url.searchParams.get('frame')).toBe(target.id)
    expect(url.searchParams.get('element')).toBe('h1h1h1')
    expect(url.searchParams.has('selector')).toBe(false)
    await load(canvas([target]), url.search)
    await page.waitForSelector('button[aria-label="Copy link to element"]')
    await page.waitForFunction((sel) => window.pageState().selectedElement?.selector === sel, {}, selector)

    // Deselecting still removes the probe and its panel after a deep link.
    await page.mouse.click(100, 100)
    await page.waitForFunction(() => window.pageState().selectedElement === null)
    expect(await page.evaluate(() => window.pageState().elementPanelOpen)).toBe(false)
  })

  it('stamps an element that has no id yet when its link is copied', async () => {
    const target = { ...frame('target', 'first', 0), html: '<main id="hero"><h1>Design</h1><p>Body</p></main>' }
    await load(canvas([target]), '?frame=target')
    await page.evaluate(() => window.pickElement('target', '#hero > p:nth-of-type(1)'))
    await page.waitForSelector('button[aria-label="Copy link to element"]')
    await page.locator('button[aria-label="Copy link to element"]').click()
    await page.waitForFunction(() => window.pageState().notice === 'Element link copied')
    const url = new URL(await page.evaluate(() => navigator.clipboard.readText()))
    const elementId = url.searchParams.get('element')!
    expect(elementId).toMatch(/^[a-z0-9]{6}$/)
    const html = await page.evaluate(() => window.frameHtml('target'))
    expect(html).toContain(`<p data-doop-id="${elementId}">Body</p>`)
    expect(html).toContain('<h1>Design</h1>')
    /* the stamped document answers the link it produced */
    await load(canvas([{ ...target, html: html! }]), url.search)
    await page.waitForFunction(() => window.pageState().selectedElement?.selector === '#hero > p:nth-of-type(1)')
  })

  it('falls back to the frame when no element carries the linked id', async () => {
    await load(
      canvas([frame('target', 'second', 3000)]),
      `?${new URLSearchParams({ frame: 'target', element: 'abcdef' })}`,
    )
    await page.waitForFunction(() => !!window.pageState().notice)
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: 'second',
      selectedId: 'target',
      selectedElement: null,
      elementPanelOpen: false,
      inspectorOpen: true,
      notice: 'This element no longer exists. Showing its frame instead.',
    })
  })

  it('opens the frame alone when the element parameter is not an id', async () => {
    await load(
      canvas([frame('target', 'second', 3000)]),
      `?${new URLSearchParams({ frame: 'target', element: '#chart' })}`,
    )
    await page.waitForFunction(() => window.pageState().inspectorOpen)
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      selectedId: 'target',
      selectedElement: null,
      elementPanelOpen: false,
      inspectorOpen: true,
    })
    expect(await page.evaluate(() => window.pageState().notice)).toBeUndefined()
  })

  it.each(['first', 'second'])('opens links to script-created elements on the %s page', async (pageId) => {
    const target = {
      ...frame('target', pageId, 3000),
      html: `<main></main><script>
        const chart = document.createElement('h1')
        chart.id = 'chart'
        chart.setAttribute('data-doop-id', 'chart0')
        chart.textContent = 'Live chart'
        document.querySelector('main').append(chart)
      </script>`,
    }
    await load(canvas([frame('original', 'first', 0), target]), '?frame=target&element=chart0')
    await page.waitForSelector('button[aria-label="Copy link to element"]', { timeout: 5000 })
    await page.waitForFunction(() => window.pageState().selectedElement?.selector === '#chart')
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: pageId,
      selectedId: target.id,
      selectedElement: { frameId: target.id, selector: '#chart' },
      elementPanelOpen: true,
      inspectorOpen: false,
    })
    expect(await page.evaluate(() => window.pageState().notice)).toBeUndefined()

    /* the live element wears its id, so the link needs no stamp */
    await page.locator('button[aria-label="Copy link to element"]').click()
    await page.waitForFunction(() => window.pageState().notice === 'Element link copied')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(new URL(copied).searchParams.get('element')).toBe('chart0')
    await load(canvas([target]), new URL(copied).search)
    await page.waitForSelector('button[aria-label="Copy link to element"]', { timeout: 5000 })
    await page.waitForFunction(() => window.pageState().selectedElement?.selector === '#chart')
  })

  it('falls back to frame details when a script removes an element from the saved HTML', async () => {
    const target = {
      ...frame('target', 'second', 3000),
      html: '<h1 id="chart" data-doop-id="chart0">Saved chart</h1><script>document.getElementById("chart").remove()</script>',
    }
    await load(canvas([target]), '?frame=target&element=chart0')
    await page.waitForFunction(() => !!window.pageState().notice, { timeout: 5000 })
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: 'second',
      selectedId: target.id,
      selectedElement: null,
      elementPanelOpen: false,
      inspectorOpen: true,
      notice: 'This element no longer exists. Showing its frame instead.',
    })
    expect(await page.$('button[aria-label="Copy link to element"]')).toBeNull()
  })

  it('follows another element link and browser history within the same mounted canvas', async () => {
    const target = {
      ...frame('target', 'first', 0),
      html: '<h1 id="one" data-doop-id="one000">One</h1><h2 id="two" data-doop-id="two000">Two</h2>',
    }
    await load(canvas([target]), '?frame=target&element=one000')
    await waitState('first link', () => window.pageState().selectedElement?.selector === '#one')
    await page.evaluate(() => {
      history.pushState(null, '', '?frame=target&element=two000')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitState('second link', () => window.pageState().selectedElement?.selector === '#two')
    await page.waitForSelector('button[aria-label="Copy link to element"]')
    await page.evaluate(() => history.back())
    await waitState('back to the first link', () => window.pageState().selectedElement?.selector === '#one')
    await page.evaluate(() => {
      history.pushState(null, '', '?frame=target')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitState('frame-only link', () => window.pageState().inspectorOpen && !window.pageState().selectedElement)
    await page.waitForSelector('button[aria-label="Copy link to element"]', { hidden: true })
  })

  it('does not snap a drag to the invisible frame on another page', async () => {
    const visible = frame('visible', 'first', 0)
    await load(canvas([visible, frame('hidden', 'second', 30)]))
    await page.waitForFunction(() => window.pageState().viewport.zoom === 1.25)
    await page.setRequestInterception(true)
    const patches: Record<string, unknown>[] = []
    const onRequest = async (request: import('puppeteer-core').HTTPRequest) => {
      if (request.url().endsWith('/api/frames/visible') && request.method() === 'PATCH') {
        const patch = JSON.parse(request.postData()!)
        patches.push(patch)
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...visible, ...patch }),
        })
      } else await request.continue()
    }
    page.on('request', onRequest)
    try {
      const box = await page.$eval('iframe[title="visible"]', (el) => {
        const rect = el.getBoundingClientRect()
        return { x: rect.x, y: rect.y }
      })
      const response = page.waitForResponse(
        (response) => response.url().endsWith('/api/frames/visible') && response.request().method() === 'PATCH',
      )
      await page.mouse.move(box.x + 50, box.y - 12)
      await page.mouse.down()
      await page.mouse.move(box.x + 85, box.y - 12, { steps: 5 })
      await page.mouse.up()
      await response
      expect(patches.at(-1)).toMatchObject({ x: 28 })
    } finally {
      page.off('request', onRequest)
      await page.setRequestInterception(false)
    }
  })
})

/* The real canvas page (tests/canvasPageFixture.ts): which page a URL opens,
   and the URL following the page. The room's canvas is seeded by the test, so
   a library canvas is one whose canvas carries the server's `landingPageId`. */
describe.skipIf(!findBrowserPath())('pages in the URL', { timeout: 30_000 }, () => {
  const pages = pagePerTest({ permissions: ['clipboard-read', 'clipboard-sanitized-write'] })
  let page: Page
  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1200, height: 800 })
    /* every frame the stage ever mounts, so a page shown for a moment is seen */
    await page.evaluateOnNewDocument(() => {
      const seen = new Set<string>()
      Object.assign(window, { mountedFrames: () => [...seen] })
      new MutationObserver(() => {
        for (const frame of document.querySelectorAll('iframe[data-doop-frame][title]'))
          seen.add((frame as HTMLIFrameElement).title)
      }).observe(document, { childList: true, subtree: true })
    })
  })

  const board: Partial<Canvas> = {
    pages: [
      { id: 'first', name: 'Main' },
      { id: 'second', name: 'Exploration' },
      { id: 'parts', name: 'Components' },
    ],
  }
  const frames = [frame('home', 'first', 0), frame('draft', 'second', 0), frame('button', 'parts', 0)]
  const open = (search = '', canvas = board) => openCanvasPage(page, frames, search, canvas)
  const activePage = () =>
    page.$eval('[data-page-id]:has(button[aria-current="page"])', (row) => row.getAttribute('data-page-id'))
  const mounted = () => page.evaluate(() => (window as unknown as { mountedFrames: () => string[] }).mountedFrames())
  const search = () => page.evaluate(() => location.search)
  async function switchTo(pageId: string) {
    await page.locator(`[data-page-id="${pageId}"] button`).click()
    await page.waitForSelector(`[data-page-id="${pageId}"] button[aria-current="page"]`)
  }

  it('opens the page the URL names, without showing the first page on the way', async () => {
    await open('?page=second')
    expect(await activePage()).toBe('second')
    expect(await mounted()).toEqual(['draft'])
    expect(await search()).toBe('?page=second')
  })

  it('keeps the URL on the open page, in place, and a reload stays there', async () => {
    await open()
    expect(await activePage()).toBe('first')
    expect(await search()).toBe('')
    const entries = await page.evaluate(() => history.length)
    await switchTo('second')
    expect(await search()).toBe('?page=second')
    await switchTo('parts')
    expect(await search()).toBe('?page=parts')
    /* a page switch is not a step Back walks through */
    expect(await page.evaluate(() => history.length)).toBe(entries)

    await showCanvasPage(page, frames, await search(), board)
    expect(await activePage()).toBe('parts')

    /* the default page needs no parameter */
    await switchTo('first')
    expect(await search()).toBe('')
  })

  it('opens the page a history entry names when the browser moves to it', async () => {
    await open()
    await page.evaluate(() => {
      history.pushState(null, '', '?page=second')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await page.waitForSelector('[data-page-id="second"] button[aria-current="page"]')
    await page.evaluate(() => history.back())
    await page.waitForSelector('[data-page-id="first"] button[aria-current="page"]')
    expect(await search()).toBe('')
  })

  it('falls back to the first page for a page that is not there, and drops it from the URL', async () => {
    await open('?page=deleted')
    expect(await activePage()).toBe('first')
    expect(await mounted()).toEqual(['home'])
    expect(await search()).toBe('')
  })

  it("opens a frame link's page over the page the URL also names", async () => {
    await open('?page=first&frame=draft')
    expect(await activePage()).toBe('second')
    expect(await mounted()).toEqual(['draft'])
    expect(await search()).toBe('?frame=draft')
    /* leaving the page leaves the frame link too: it would win on a reload */
    await switchTo('parts')
    expect(await search()).toBe('?page=parts')
  })

  it('opens a library canvas on its components page and a plain canvas on its first', async () => {
    const library = { ...board, landingPageId: 'parts' }
    await open('', library)
    expect(await activePage()).toBe('parts')
    expect(await mounted()).toEqual(['button'])
    expect(await search()).toBe('')
    /* the person's pick holds, and the URL says so, since a bare link opens the components */
    await switchTo('first')
    expect(await search()).toBe('?page=first')
    await showCanvasPage(page, frames, await search(), library)
    expect(await activePage()).toBe('first')

    await showCanvasPage(page, frames, '', board)
    expect(await activePage()).toBe('first')
  })

  it('stays on the open page when someone else changes the pages, unless that page is deleted', async () => {
    await open('?page=second')
    const setPages = (list: { id: string; name: string }[]) =>
      page.evaluate((list) => window.canvasPageHarness.setPages(list), list)
    await setPages([
      { id: 'parts', name: 'Components' },
      { id: 'second', name: 'Renamed' },
      { id: 'first', name: 'Main' },
    ])
    expect(await activePage()).toBe('second')
    expect(await search()).toBe('?page=second')
    /* the open page is deleted: the first page in the list, and a URL that names nothing */
    await setPages([
      { id: 'parts', name: 'Components' },
      { id: 'first', name: 'Main' },
    ])
    await page.waitForSelector('[data-page-id="parts"] button[aria-current="page"]')
    expect(await search()).toBe('')
  })

  it('copies a link to a page from its row menu', async () => {
    await open()
    await page.locator('[data-page-id="second"] button').click({ button: 'right' })
    await page.locator('[role="menuitem"]::-p-text(Copy link to page)').click()
    await page.waitForFunction(() => document.body.textContent?.includes('Page link copied'))
    const url = new URL(await page.evaluate(() => navigator.clipboard.readText()))
    expect(url.pathname).toBe('/c/c')
    expect(url.search).toBe('?page=second')
  })
})
