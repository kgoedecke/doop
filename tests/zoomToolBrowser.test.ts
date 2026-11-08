import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureServerConfig, openBrowser, type TestBrowser } from './browser'
import { freePort, startServer, type Server } from './harness'

/* Z held is the Zoom tool: a click zooms in, a drag zooms onto its box, Esc
   drops the box, and letting go of Z returns to the tool before it, in
   whichever order Z and the mouse are released */
describe.skipIf(!findBrowserPath())('the Zoom tool', () => {
  let vite: ViteDevServer
  let server: Server
  let browser: TestBrowser
  let page: Page
  beforeAll(async () => {
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
        body: JSON.stringify({ name: 'Zoom Tester', email: 'zoom-tool@test.dev', password: 'password12345' }),
      })
      if (!signup.ok) throw new Error(await signup.text())
      const canvas = await (
        await fetch('/api/canvases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Zoom tool' }),
        })
      ).json()
      await fetch(`/api/canvases/${canvas.id}/frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Board', x: 0, y: 0, width: 800, height: 600, html: '<body></body>' }),
      })
      return canvas.id as string
    })
    await page.goto(`${origin}/c/${canvasId}`)
    await page.waitForSelector('[data-frame-title]')
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
    server?.stop()
  })

  const zoom = () => page.$eval('[aria-label="Zoom level"] span', (el) => parseInt(el.textContent ?? '', 10))
  const zoomCursor = () => page.$eval('.stage', (el) => el.className.includes('cursor-zoom-in!'))
  async function centre() {
    const r = await page.$eval('.stage', (el) => {
      const b = el.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    })
    return r
  }
  /* back to 100% between cases */
  async function reset() {
    await page.keyboard.down('Meta')
    await page.keyboard.press('Digit0')
    await page.keyboard.up('Meta')
    await page.waitForFunction(() => document.querySelector('[aria-label="Zoom level"] span')?.textContent === '100%')
  }

  it('zooms in on a click while Z is held, and lets go of the tool with Z', async () => {
    await reset()
    const at = await centre()
    await page.keyboard.down('KeyZ')
    expect(await zoomCursor()).toBe(true)
    await page.mouse.click(at.x, at.y)
    expect(await zoom()).toBe(200)
    await page.keyboard.up('KeyZ')
    expect(await zoomCursor()).toBe(false)
  })

  it('finishes a drag released after Z, and the next click selects instead of zooming', async () => {
    await reset()
    const at = await centre()
    await page.keyboard.down('KeyZ')
    await page.mouse.move(at.x - 100, at.y - 50)
    await page.mouse.down()
    await page.mouse.move(at.x + 100, at.y + 50, { steps: 5 })
    await page.keyboard.up('KeyZ')
    await page.mouse.up()
    const zoomed = await zoom()
    expect(zoomed).toBeGreaterThan(300)
    expect(await zoomCursor()).toBe(false)
    await page.mouse.click(at.x, at.y)
    expect(await zoom()).toBe(zoomed)
  })

  it('drops the box on Esc without zooming', async () => {
    await reset()
    const at = await centre()
    await page.keyboard.down('KeyZ')
    await page.mouse.move(at.x - 100, at.y - 50)
    await page.mouse.down()
    await page.mouse.move(at.x + 100, at.y + 50, { steps: 5 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.keyboard.up('KeyZ')
    expect(await zoom()).toBe(100)
  })
})
