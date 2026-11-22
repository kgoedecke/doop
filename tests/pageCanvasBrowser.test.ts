import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import { openCanvasPage, showCanvasPage } from './canvasPageFixture'
import type { Canvas, Frame } from '../shared/types'

declare global {
  interface Window {
    seedPages: (canvas: Canvas) => void
    openPage: (id: string) => void
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

  /* a menu row by its label, ignoring the chord hint after it */
  function menuItem(label: string) {
    return page.waitForFunction(
      (label) =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (el) => el.firstChild?.textContent === label,
        ),
      {},
      label,
    )
  }

  /* right-click an element of the target frame and take its menu's link item:
     the layer menu of an element in the saved HTML keeps it under "Copy/Paste
     as", as Figma's does; a reader's frame menu and a script-made element's
     menu list it at the top */
  async function copyLinkTo(selector: string, { nested = false } = {}) {
    const iframe = (await page.$('iframe[title="target"]'))!
    const doc = (await iframe.contentFrame())!
    const inner = await doc.$eval(selector, (el) => el.getBoundingClientRect().toJSON())
    const outer = await iframe.evaluate((el) => el.getBoundingClientRect().toJSON())
    const zoom = outer.width / 200
    await page.mouse.click(outer.x + (inner.x + 5) * zoom, outer.y + (inner.y + 5) * zoom, { button: 'right' })
    if (nested) await (await (await menuItem('Copy/Paste as')).asElement()!.toElement('div')).click()
    const item = await menuItem('Copy link to element')
    await (await item.asElement()!.toElement('div')).click()
  }

  it('restores pan and zoom when returning to a page', async () => {
    await load(canvas([frame('directory', 'first', 0), frame('target', 'second', 3000)]))
    const initial = await page.evaluate(() => window.pageState().viewport)
    await page.mouse.move(1100, 400)
    await page.keyboard.down('Control')
    await page.mouse.wheel({ deltaY: 30 })
    await page.keyboard.up('Control')
    await page.waitForFunction((zoom) => window.pageState().viewport.zoom !== zoom, {}, initial.zoom)
    const zoomed = await page.evaluate(() => window.pageState().viewport)
    await page.mouse.wheel({ deltaY: 200 })
    await page.waitForFunction((y) => window.pageState().viewport.y !== y, {}, zoomed.y)
    const before = await page.evaluate(() => window.pageState().viewport)

    await page.evaluate(() => window.openPage('second'))
    await page.waitForSelector('iframe[title="target"]')
    await page.evaluate(() => window.openPage('first'))
    await page.waitForSelector('iframe[title="directory"]')
    expect(await page.evaluate(() => window.pageState().viewport)).toEqual(before)

    // A link to the already visited second page must override its saved fit.
    await page.mouse.wheel({ deltaY: -75 })
    await page.waitForFunction((y) => window.pageState().viewport.y !== y, {}, before.y)
    const fromLink = await page.evaluate(() => {
      const viewport = window.pageState().viewport
      history.pushState(null, '', '?frame=target')
      window.dispatchEvent(new PopStateEvent('popstate'))
      return viewport
    })
    await waitState('the direct link overrides the saved view', () => window.pageState().selectedId === 'target')
    expect(await page.evaluate(() => window.pageState().viewport)).toMatchObject({ x: -2500, zoom: 1 })
    await page.evaluate(() => window.openPage('first'))
    await page.waitForSelector('iframe[title="directory"]')
    expect(await page.evaluate(() => window.pageState().viewport)).toEqual(fromLink)
  })

  it('starts at the top of a tall single-column page on first visit', async () => {
    await load(
      canvas([
        { ...frame('directory', 'first', 0), width: 900, height: 4000 },
        { ...frame('continued', 'first', 0), width: 900, y: 4100 },
      ]),
    )
    const top = await page.$eval('iframe[title="directory"]', (el) => el.getBoundingClientRect().top)
    const { zoom } = await page.evaluate(() => window.pageState().viewport)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top).toBeLessThan(200)
    expect(zoom).toBeGreaterThanOrEqual(0.9)
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

  it('opens the web link under a ⌘-click, not the one hovered a moment before', async () => {
    const source = {
      ...frame('links', 'first', 0),
      width: 1200,
      height: 800,
      html: `<style>body{padding:100px;font-size:32px}a{display:block;width:400px;margin:0 0 40px}</style>
        <a id="first" href="https://example.com/first">First</a>
        <a id="second" href="https://example.com/second">Second</a>`,
    }
    await load(canvas([source]), '?frame=links')
    await page.evaluate(() => {
      const opened: string[] = []
      ;(window as unknown as { opened: string[] }).opened = opened
      window.open = (url?: string | URL) => {
        opened.push(String(url))
        return null
      }
    })
    const host = (await page.waitForSelector('iframe[title="links"]'))!
    const doc = (await host.contentFrame())!
    const point = async (selector: string) => {
      const node = (await doc.waitForSelector(selector))!
      const rect = await node.evaluate((el) => {
        const box = el.getBoundingClientRect()
        return { x: box.x + 60, y: box.y + box.height / 2, width: innerWidth, height: innerHeight }
      })
      return host.evaluate((el, { x, y, width, height }) => {
        const box = el.getBoundingClientRect()
        return { x: box.left + (x * box.width) / width, y: box.top + (y * box.height) / height }
      }, rect)
    }
    const first = await point('#first')
    const second = await point('#second')
    const mod = (await page.evaluate(() => /mac/i.test(navigator.platform))) ? 'Meta' : 'Control'
    await page.keyboard.down(mod)
    await page.mouse.move(first.x, first.y)
    await waitState('the first link is outlined', () => !!document.querySelector('[data-link-outline]'))
    // inside the hover throttle: the outline still shows the first link
    await page.mouse.move(second.x, second.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.keyboard.up(mod)
    await page.waitForFunction(() => (window as unknown as { opened: string[] }).opened.length > 0)
    expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([
      'https://example.com/second',
    ])
  })

  it('follows a same-canvas frame link on modifier-click without taking over ordinary selection', async () => {
    const source = {
      ...frame('directory', 'first', 0),
      width: 1200,
      height: 3500,
      html: `<style>body{padding:160px 100px;font-size:32px}a{display:inline-block;min-width:380px}</style>
        <p><a href="/c/c?frame=target&element=h1h1h1"><strong id="app">App research</strong></a></p>
        <p><a id="external" href="https://example.com/c/c?frame=target">External site</a></p>
        <p><a id="missing" href="/c/c?frame=missing">Missing frame</a></p>`,
    }
    const target = { ...frame('target', 'second', 3000), html: '<h1 data-doop-id="h1h1h1">Research</h1>' }
    await load(canvas([source, target, frame('distant', 'second', 12000)]), '?frame=directory')
    const host = (await page.waitForSelector('iframe[title="directory"]'))!
    const directory = (await host.contentFrame())!
    await page.waitForSelector('[data-frame-selection]')
    const point = async (selector: string) => {
      const node = (await directory.waitForSelector(selector))!
      const rect = await node.evaluate((el) => {
        const box = el.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: innerWidth, height: innerHeight }
      })
      return host.evaluate((el, { x, y, width, height }) => {
        const box = el.getBoundingClientRect()
        return { x: box.left + (x * box.width) / width, y: box.top + (y * box.height) / height }
      }, rect)
    }
    const app = await point('#app')
    await page.mouse.move(app.x, app.y)
    await waitState('the link is hovered as an ordinary layer', () => !!document.querySelector('[data-hover-outline]'))
    expect(
      await page.evaluate(() => ({
        cursor: getComputedStyle(document.querySelector('[data-frame-surface]')!).cursor,
        outlined: !!document.querySelector('[data-link-outline]'),
      })),
    ).toEqual({ cursor: 'default', outlined: false })
    // the browser may show the document's cursor under the shield: it wears the canvas's
    await directory.waitForFunction(() => getComputedStyle(document.querySelector('#app')!).cursor === 'default')
    // another tool's cursor reaches the document too
    await page.keyboard.press('h')
    await directory.waitForFunction(() => getComputedStyle(document.querySelector('#app')!).cursor === 'grab')
    await page.keyboard.press('v')
    await directory.waitForFunction(() => getComputedStyle(document.querySelector('#app')!).cursor === 'default')
    // and so does a cursor the Stage changes by itself: ⌥ turns the Zoom tool to zoom-out
    const docCursor = (cursor: string) =>
      directory.waitForFunction(
        (cursor) => getComputedStyle(document.querySelector('#app')!).cursor === cursor,
        {},
        cursor,
      )
    await page.keyboard.down('z')
    await docCursor('zoom-in')
    await page.keyboard.down('Alt')
    await docCursor('zoom-out')
    await page.keyboard.up('Alt')
    await docCursor('zoom-in')
    await page.keyboard.up('z')
    await docCursor('default')
    await page.mouse.click(app.x, app.y)
    await waitState(
      'ordinary click stays in selection',
      () => window.pageState().selectedElement?.frameId === 'directory',
    )
    await page.mouse.click(80, 600)
    await waitState('the canvas is deselected before trying the jump', () => !window.pageState().selectedId)
    const url = page.url()
    const mod = (await page.evaluate(() => /mac/i.test(navigator.platform))) ? 'Meta' : 'Control'
    await page.evaluate(() => {
      const opened: string[] = []
      ;(window as unknown as { opened: string[] }).opened = opened
      window.open = (target?: string | URL) => {
        opened.push(String(target))
        return null
      }
    })
    const opened = () => page.evaluate(() => (window as unknown as { opened: string[] }).opened)
    // hover probes are throttled to one per 40ms with no trailing probe, so each
    // arrival waits for the last one to age out, as a real pointer would
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
    await page.keyboard.down(mod)
    // a web address opens in a new tab and leaves the canvas where it is
    const external = await point('#external')
    await page.mouse.click(external.x, external.y)
    await page.waitForFunction(() => (window as unknown as { opened: string[] }).opened.length > 0)
    expect(await opened()).toEqual(['https://example.com/c/c?frame=target'])
    // a link into this canvas naming a frame that is gone reads as no link and does nothing
    await settle()
    const missing = await point('#missing')
    await page.mouse.move(missing.x, missing.y)
    await waitState(
      'the dead link is hovered as an ordinary layer',
      () => !!document.querySelector('[data-hover-outline]') && !document.querySelector('[data-link-outline]'),
    )
    await page.mouse.click(missing.x, missing.y)
    await settle()
    expect(await opened()).toHaveLength(1)
    await page.mouse.move(app.x, app.y)
    await waitState('with the chord held the app link reads as a link', () => {
      const surface = document.querySelector('[data-frame-surface]')
      return (
        !!surface && getComputedStyle(surface).cursor === 'pointer' && !!document.querySelector('[data-link-outline]')
      )
    })
    await directory.waitForFunction(() => getComputedStyle(document.querySelector('#app')!).cursor === 'pointer')
    await page.mouse.down()
    await page.mouse.move(app.x + 20, app.y)
    await page.mouse.up()
    expect(await page.evaluate(() => window.pageState().activePageId)).toBe('first')
    await page.mouse.click(app.x, app.y)
    await page.keyboard.up(mod)
    await waitState(
      'modifier-click picks the linked element on the destination page',
      () => window.pageState().activePageId === 'second' && window.pageState().selectedElement?.frameId === 'target',
    )
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      selectedId: 'target',
      viewport: { x: -2500, y: 300, zoom: 1 },
    })
    expect(new URL(page.url()).pathname).toBe(new URL(url).pathname)
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
    await page.waitForFunction((sel) => window.pageState().selectedElement?.selector === sel, {}, selector)
    expect(await page.evaluate(() => window.pageState())).toMatchObject({
      activePageId: pageId,
      selectedId: target.id,
      selectedElement: { frameId: target.id, selector },
      elementPanelOpen: true,
      inspectorOpen: false,
      viewport: { x: -2500, y: 300, zoom: 1 },
    })

    // Copy through the element's own menu, then reopen the resulting URL.
    await copyLinkTo('h1', { nested: true })
    await page.waitForFunction(() => window.pageState().notice === 'Element link copied')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    const url = new URL(copied)
    expect(url.pathname).toBe('/c/c')
    expect(url.searchParams.get('frame')).toBe(target.id)
    expect(url.searchParams.get('element')).toBe('h1h1h1')
    expect(url.searchParams.has('selector')).toBe(false)
    await load(canvas([target]), url.search)
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
    await page.waitForFunction(() => window.pageState().selectedElement?.selector === '#hero > p:nth-of-type(1)')
    await copyLinkTo('p', { nested: true })
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

  it('lets a reader copy the link of the element they picked from the frame menu', async () => {
    const target = {
      ...frame('target', 'first', 0),
      html: '<main id="hero"><h1 data-doop-id="h1h1h1">Design</h1></main>',
    }
    await load({ ...canvas([target]), role: 'view' }, '?frame=target&element=h1h1h1')
    await page.waitForFunction(() => window.pageState().selectedElement?.selector === '#hero > h1:nth-of-type(1)')
    await copyLinkTo('h1')
    await page.waitForFunction(() => window.pageState().notice === 'Element link copied')
    const url = new URL(await page.evaluate(() => navigator.clipboard.readText()))
    expect(url.searchParams.get('element')).toBe('h1h1h1')
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
    await copyLinkTo('#chart')
    await page.waitForFunction(() => window.pageState().notice === 'Element link copied')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(new URL(copied).searchParams.get('element')).toBe('chart0')
    await load(canvas([target]), new URL(copied).search)
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
    await page.evaluate(() => history.back())
    await waitState('back to the first link', () => window.pageState().selectedElement?.selector === '#one')
    await page.evaluate(() => {
      history.pushState(null, '', '?frame=target')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitState('frame-only link', () => window.pageState().inspectorOpen && !window.pageState().selectedElement)
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
