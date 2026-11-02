import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureServerConfig, openBrowser, type TestBrowser } from './browser'
import { freePort, startServer, type Server } from './harness'

describe.skipIf(!findBrowserPath())('page list controls and keyboard history', () => {
  let vite: ViteDevServer
  let server: Server
  let browser: TestBrowser
  let page: Page
  beforeAll(async () => {
    /* vite needs the server's port for its proxy and the server needs vite's
       origin as BETTER_AUTH_URL, so the port is picked before either starts */
    const port = await freePort()
    vite = await createServer(
      fixtureServerConfig({
        proxy: {
          '/api': { target: `http://localhost:${port}` },
          '/ws': { target: `ws://localhost:${port}`, ws: true },
        },
      }),
    )
    await vite.listen()
    const origin = vite.resolvedUrls!.local[0]!.replace(/\/$/, '')
    server = await startServer({ PORT: String(port), BETTER_AUTH_URL: origin })
    browser = await openBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(origin)
    const canvasId = await page.evaluate(async () => {
      const signup = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Pages Tester', email: 'page-controls@test.dev', password: 'password12345' }),
      })
      if (!signup.ok) throw new Error(await signup.text())
      const canvas = await (
        await fetch('/api/canvases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Page interactions' }),
        })
      ).json()
      return canvas.id
    })
    await page.goto(`${origin}/c/${canvasId}`)
    /* the Layers heading paints before the canvas's pages arrive; the first
       assertion counts page rows, so wait for the list itself */
    await page.waitForSelector('[data-slot="frame-section-heading"]')
    await page.waitForSelector('[data-page-id]')
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
    server?.stop()
  })

  async function shortcut(redo = false) {
    // The WebSocket can paint the result before the HTTP response releases
    // history's busy guard. Wait for this shortcut's own request to finish
    // before sending the next one, including when an earlier save is in flight.
    const completed = page
      .waitForRequest(
        (request) =>
          ['PUT', 'PATCH', 'POST', 'DELETE'].includes(request.method()) &&
          /^\/api\/(canvases|frames)\//.test(new URL(request.url()).pathname),
      )
      .then(async (request) => {
        const response =
          request.response() ?? (await page.waitForResponse((response) => response.request() === request))
        await response.text()
        expect(response.ok()).toBe(true)
      })
    await page.keyboard.down('Meta')
    if (redo) await page.keyboard.down('Shift')
    await page.keyboard.press('z')
    if (redo) await page.keyboard.up('Shift')
    await page.keyboard.up('Meta')
    await completed
    await page.evaluate(() => new Promise(requestAnimationFrame))
  }

  it('drags pages, double-clicks to rename, and restores a deleted page and frame with Cmd+Z', async () => {
    // Exercise the ordering that made this test race on CI: broadcasts land first.
    await page.emulateNetworkConditions({ offline: false, download: -1, upload: -1, latency: 150 })
    const framePlus = await page.$eval('button[aria-label="New frame"] svg', (el) => el.outerHTML)
    const typography = (element: Element) => {
      const style = getComputedStyle(element)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.letterSpacing, style.textTransform]
    }
    const frameTypography = await page.$eval('[data-slot="frame-section-heading"]', typography)
    /* pages sit above the frames, Figma-style, with the search underneath both */
    expect(await page.$$('[data-page-id]')).toHaveLength(1)
    await page.waitForSelector('button[aria-label="Add page"]')
    expect(await page.$('input[placeholder="Search layers"]')).not.toBeNull()
    expect(await page.$('[data-slot="frame-section-heading"]')).not.toBeNull()
    expect(await page.$eval('button[aria-label="Add page"] svg', (el) => el.outerHTML)).toBe(framePlus)
    expect(await page.$eval('[data-slot="page-section-heading"]', typography)).toEqual(frameTypography)
    await page.click('button[aria-label="Add page"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-page-id]').length === 2)
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('button[aria-label="Add page"]')!.disabled,
    )
    expect(await page.$$('[aria-label^="Rename "]')).toHaveLength(0)
    expect(await page.$$('[aria-label^="Move Page"]')).toHaveLength(0)
    expect(await page.$$('button[aria-label^="Delete "]')).toHaveLength(0)
    const rows = await page.$$('[data-page-id]')
    const first = await rows[0]!.boundingBox()
    const second = await rows[1]!.boundingBox()
    await page.mouse.move(second!.x + 50, second!.y + second!.height / 2)
    await page.mouse.down()
    await page.mouse.move(first!.x + 50, first!.y + 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.textContent?.includes('Page 2'))
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('button[aria-label="Add page"]')!.disabled,
    )
    await page.click('[data-page-id] > button:first-of-type', { count: 2 })
    await page.waitForSelector('input[aria-label="Page name"]')
    /* the row being renamed is the active one (a grey fill); the input reads
       as ink on its own white surface, not as text on the row's fill */
    expect(
      await page.$eval('input[aria-label="Page name"]', (input) => [
        getComputedStyle(input).color === getComputedStyle(document.body).color,
        getComputedStyle(input).backgroundColor !== getComputedStyle(input.closest('[data-page-id]')!).backgroundColor,
      ]),
    ).toEqual([true, true])
    await page.type('input[aria-label="Page name"]', 'Ideas')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.textContent?.includes('Ideas'))
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('button[aria-label="Add page"]')!.disabled,
    )
    const selectedColor = await page.$eval(
      '[data-page-id] button[aria-current="page"]',
      (button) => getComputedStyle(button.parentElement!).backgroundColor,
    )
    await page.click('button[aria-label="New frame"]')
    await page.waitForSelector('iframe[data-doop-frame]')
    await page.waitForSelector('[role="treeitem"][aria-selected="true"]')
    expect(selectedColor).toBe(
      await page.$eval('[role="treeitem"][aria-selected="true"]', (row) => getComputedStyle(row).backgroundColor),
    )
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-doop-frame]').length === 0)
    await page.screenshot({ path: '/tmp/doop-pages-controls.png' })
    await page.click('[data-page-id] button[aria-current="page"]', { button: 'right' })
    await page.waitForSelector('[role="menuitem"]')
    await page.click('[role="menuitem"]:last-child')
    await page.waitForFunction(() => document.querySelectorAll('[data-page-id]').length === 1)
    await shortcut()
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.textContent?.includes('Ideas'))
    expect(await page.$eval('[data-page-id]', (row) => row.textContent)).toContain('Ideas')
    expect(await page.$('iframe[data-doop-frame]')).toBeNull()
    await shortcut()
    await page.waitForSelector('iframe[data-doop-frame]')
    expect(await page.$eval('[aria-current="page"]', (button) => button.textContent)).toBe('Ideas')
    await shortcut(true)
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-doop-frame]').length === 0)
    await shortcut(true)
    await page.waitForFunction(() => document.querySelectorAll('[data-page-id]').length === 1)
    await page.click('[data-page-id] button[aria-current="page"]', { button: 'right' })
    await page.waitForSelector('[role="menuitem"]')
    expect(await page.$eval('[role="menuitem"]:last-child', (item) => item.getAttribute('aria-disabled'))).toBe('true')
    await page.click('[role="menuitem"]:first-child')
    await page.waitForSelector('input[aria-label="Page name"]')
    await page.type('input[aria-label="Page name"]', 'Main')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('[data-page-id]')?.textContent?.includes('Main'))
  }, 20_000)

  it('moves a selected frame through the page picker and undoes the move', async () => {
    /* runs on whatever single page the previous test left (or the fresh
       canvas's own), so it reads the destination's name instead of assuming it */
    const pageCount = (await page.$$('[data-page-id]')).length
    await page.click('button[aria-label="Add page"]')
    await page.waitForFunction((n) => document.querySelectorAll('[data-page-id]').length === n + 1, {}, pageCount)
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('button[aria-label="Add page"]')!.disabled,
    )
    const source = await page.$eval(
      '[aria-current="page"]',
      (button) => button.closest<HTMLElement>('[data-page-id]')!.dataset.pageId!,
    )
    const destination = await page.$eval(
      '[data-page-id] > button:first-of-type:not([aria-current="page"])',
      (button) => button.textContent!,
    )
    await page.click('button[aria-label="New frame"]')
    await page.waitForSelector('iframe[data-doop-frame]')
    /* the room's broadcast can paint the frame before the create response
       selects it, and the picker only shows for a selection */
    await page.waitForSelector('[aria-label="Move selection to page"]:not([disabled])')
    await page.click('[aria-label="Move selection to page"]')
    await page.waitForSelector('[role="option"]')
    expect(await page.$$('[role="option"]')).toHaveLength(1)
    expect(await page.$eval('[role="option"]', (option) => option.textContent)).toBe(destination)
    /* keys in the open list stay with it: ⌫ must not delete the frame being
       moved, nor a letter switch the canvas tool */
    await page.keyboard.press('Backspace')
    await page.keyboard.press('r')
    expect(await page.$$('iframe[data-doop-frame]')).toHaveLength(1)
    expect(await page.$eval('button[aria-label="Rectangle"]', (b) => b.getAttribute('aria-pressed'))).toBe('false')
    expect(await page.$('[role="option"]')).not.toBeNull()
    await page.screenshot({ path: '/tmp/doop-page-move.png' })
    await page.click('[role="option"]')
    await page.waitForFunction(
      (name) => document.querySelector('[aria-current="page"]')?.textContent === name,
      {},
      destination,
    )
    await page.waitForSelector('iframe[data-doop-frame]')
    await shortcut()
    await page.waitForFunction(
      (id) => document.querySelector(`[data-page-id="${id}"] [aria-current="page"]`),
      {},
      source,
    )
    await page.waitForSelector('iframe[data-doop-frame]')
    await shortcut(true)
    await page.waitForFunction(
      (name) => document.querySelector('[aria-current="page"]')?.textContent === name,
      {},
      destination,
    )
    await page.waitForSelector('iframe[data-doop-frame]')
  }, 20_000)
})
