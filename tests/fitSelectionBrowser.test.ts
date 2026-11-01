import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureServerConfig, openBrowser, type TestBrowser } from './browser'
import { freePort, startServer, type Server } from './harness'

/* ⇧2 fits the selection into the part of the stage the panels leave open,
   not the whole window under them */
describe.skipIf(!findBrowserPath())('zoom to selection with the panels open', () => {
  let vite: ViteDevServer
  let server: Server
  let browser: TestBrowser
  let page: Page
  let origin: string
  let canvasId: string
  let frameId: string
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
    origin = vite.resolvedUrls!.local[0]!.replace(/\/$/, '')
    server = await startServer({ PORT: String(port), BETTER_AUTH_URL: origin })
    browser = await openBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1600, height: 1000 })
    await page.goto(origin)
    ;({ canvasId, frameId } = await page.evaluate(async () => {
      const signup = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Fit Tester', email: 'fit-selection@test.dev', password: 'password12345' }),
      })
      if (!signup.ok) throw new Error(await signup.text())
      const canvas = await (
        await fetch('/api/canvases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Fit selection' }),
        })
      ).json()
      const frame = await (
        await fetch(`/api/canvases/${canvas.id}/frames`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Wide', x: 0, y: 0, width: 1440, height: 900, html: '<body></body>' }),
        })
      ).json()
      return { canvasId: canvas.id as string, frameId: frame.id as string }
    }))
    await page.goto(`${origin}/c/${canvasId}`)
    await page.waitForSelector('[data-frame-title]')
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
    server?.stop()
  })

  /** the open stage: right of the tool rail (which follows the Layers
   *  panel), left of the islands (which follow the Inspector and Agents) */
  async function openArea() {
    return page.evaluate(() => ({
      left: document.querySelector('[aria-label="Canvas tools"]')!.getBoundingClientRect().right,
      right: document.querySelector('[aria-label="Account"]')!.getBoundingClientRect().left,
    }))
  }

  /** select the frame with the Inspector and Agents open, press ⇧2 and
   *  return where the frame landed */
  async function fitWithPanelsOpen() {
    /* a title click selects the frame and opens the Inspector */
    await page.click('[data-frame-title]')
    if (await page.$('[aria-label^="Agents"]')) await page.click('[aria-label^="Agents"]')
    await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Resize"]').length >= 2)
    await page.keyboard.down('Shift')
    await page.keyboard.press('Digit2')
    await page.keyboard.up('Shift')
    await new Promise((r) => setTimeout(r, 300))
    return page.$eval('[data-frame-surface]', (el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right }
    })
  }

  it('keeps the fitted frame clear of the side panels and centred between them', async () => {
    const frame = await fitWithPanelsOpen()
    const area = await openArea()
    expect(frame.left).toBeGreaterThan(area.left)
    expect(frame.right).toBeLessThan(area.right)
    expect(Math.abs((frame.left + frame.right) / 2 - (area.left + area.right) / 2)).toBeLessThan(40)
  })

  it('fits a linked frame beside the Inspector the link opens', async () => {
    await page.goto(`${origin}/c/${canvasId}?frame=${frameId}`)
    await page.waitForSelector('[aria-label="Account"]')
    /* the link opens the Inspector, whose header offers to close it */
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="panel"]').length >= 2)
    await new Promise((r) => setTimeout(r, 300))
    const frame = await page.$eval('[data-frame-surface]', (el) => el.getBoundingClientRect().right)
    const area = await openArea()
    expect(frame).toBeLessThan(area.right)
  })

  it('docked: the stage fills the gap between the columns and fits there', async () => {
    await page.evaluate(() => localStorage.setItem('doop:panel-layout', 'docked'))
    await page.reload()
    await page.waitForSelector('[data-frame-title]')
    const frame = await fitWithPanelsOpen()
    const area = await openArea()
    const stage = await page.$eval('.stage', (el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top }
    })
    /* the columns butt against the stage on both sides, under the bar */
    expect(Math.abs(stage.left - area.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(stage.right - area.right)).toBeLessThanOrEqual(1)
    expect(stage.top).toBe(50)
    expect(frame.left).toBeGreaterThan(stage.left)
    expect(frame.right).toBeLessThan(stage.right)
    expect(Math.abs((frame.left + frame.right) / 2 - (stage.left + stage.right) / 2)).toBeLessThan(2)
  })
})
