import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import { startServer, type Server } from './harness'

const PORT = 4989

describe.skipIf(!findBrowserPath())('page list controls and keyboard history', () => {
  let vite: ViteDevServer
  let server: Server
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    vite = await createServer({
      logLevel: 'error',
      server: {
        port: 0,
        proxy: {
          '/api': { target: `http://localhost:${PORT}` },
          '/ws': { target: `ws://localhost:${PORT}`, ws: true },
        },
      },
    })
    await vite.listen()
    const origin = vite.resolvedUrls!.local[0]!.replace(/\/$/, '')
    server = await startServer(PORT, { BETTER_AUTH_URL: origin })
    browser = await getBrowser()
    page = await browser.newPage()
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
    await page.waitForSelector('[role="tab"][data-state="active"]')
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
    server?.stop()
  })

  async function shortcut(redo = false) {
    await page.keyboard.down('Meta')
    if (redo) await page.keyboard.down('Shift')
    await page.keyboard.press('z')
    if (redo) await page.keyboard.up('Shift')
    await page.keyboard.up('Meta')
  }

  it('drags pages, double-clicks to rename, and restores a deleted page and frame with Cmd+Z', async () => {
    const framePlus = await page.$eval('button[aria-label="New frame"] svg', (el) => el.outerHTML)
    const typography = (element: Element) => {
      const style = getComputedStyle(element)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.letterSpacing, style.textTransform]
    }
    const frameTypography = await page.$eval('[data-slot="frame-section-heading"]', typography)
    expect(await page.$('[data-page-id]')).toBeNull()
    await page.click('[role="tab"][data-state="inactive"]')
    await page.waitForSelector('button[aria-label="Add page"]')
    expect(await page.$('input[placeholder="Search layers"]')).toBeNull()
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
    await page.click('[role="tab"][data-state="inactive"]')
    await page.click('button[aria-label="New frame"]')
    await page.waitForSelector('iframe[data-doop-frame]')
    expect(selectedColor).toBe(
      await page.$eval('[role="treeitem"][aria-selected="true"]', (row) => getComputedStyle(row).backgroundColor),
    )
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-doop-frame]').length === 0)
    await page.click('[role="tab"][data-state="inactive"]')
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
})
