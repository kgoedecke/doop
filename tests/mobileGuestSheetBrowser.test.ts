import { symlinkSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { Client, startServer, type Server } from './harness'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

describe.skipIf(!findBrowserPath())('mobile guest canvas', () => {
  const pages = pagePerTest()

  it('reveals the canvas controls when the account sheet is swiped down and hides them again on swipe up', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 390, height: 664, isMobile: true, hasTouch: true })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    const frame = canvasFrame({ id: 'hero', name: 'Hero', x: 0, y: 0, width: 240, height: 360 })
    await openCanvasPage(page, [frame], '?fixtureGuest', { role: 'view' })
    const handle = await page.waitForSelector('button[aria-controls="guest-account-actions"]', { visible: true })
    const zoom = await page.waitForSelector('button[aria-label="Zoom in"]')
    const cursor = await page.waitForSelector('button[aria-label="Select"]')
    async function swipe(distance: number) {
      const point = await handle!.clickablePoint()
      const touch = await page.touchscreen.touchStart(point.x, point.y)
      await touch.move(point.x, point.y + distance)
      await touch.end()
    }
    expect(await zoom!.isVisible()).toBe(false)
    expect(await cursor!.isVisible()).toBe(false)
    await swipe(60)
    await page.waitForSelector('[aria-controls="guest-account-actions"][aria-expanded="false"]')
    await zoom!.tap()
    await cursor!.tap()
    expect(await cursor!.evaluate((button) => button.getAttribute('aria-pressed'))).toBe('true')
    await swipe(-60)
    await page.waitForSelector('[aria-controls="guest-account-actions"][aria-expanded="true"]')
    expect(await zoom!.isVisible()).toBe(false)
    expect(await cursor!.isVisible()).toBe(false)
  }, 30_000)
})

describe.skipIf(!findBrowserPath())('shared canvas guest authentication', () => {
  const pages = pagePerTest()
  let server: Server
  let url: string

  beforeAll(async () => {
    server = await startServer({
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'only-used-for-this-isolated-browser-test',
    })
    symlinkSync(inject('browserRig')!.builtDir, path.join(server.dataDir, 'dist'), 'junction')
    const owner = new Client(server)
    await owner.signUp('owner@example.test', 'Owner')
    const canvas = await (await owner.post('/api/canvases', { name: 'Shared design' })).json()
    await owner.patch(`/api/canvases/${canvas.id}`, { linkAccess: 'view' })
    url = `${server.base}/c/${canvas.id}`
  }, 60_000)
  afterAll(() => server?.stop())

  it('serves the native handoff in the initial HTML even for a desktop-mode iPad', async () => {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15' },
    })
    expect(await response.text()).toContain(
      `app-argument=doop://canvas/${url.split('/').pop()}?server=${encodeURIComponent(server.base)}`,
    )
  })

  it('keeps the entered fields and verification result across rotation, canvas shortcuts and a signed-out session check', async () => {
    const page = await pages.open()
    await page.setViewport({ width: 820, height: 1080 })
    await page.goto(url)
    await page.locator('#guest-account-actions button::-p-text(Sign up)').click()
    await page.type('[autocomplete="name"]', 'Reader')
    await page.type('[autocomplete="email"]', 'reader@example.test')
    await page.type('[autocomplete="new-password"]', 'reading-is-great')
    await page.keyboard.down('Meta')
    await page.keyboard.press('k')
    await page.keyboard.up('Meta')
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')
    expect(await page.$$('[role="dialog"]')).toHaveLength(1)
    await page.setViewport({ width: 1080, height: 820 })
    await page.waitForSelector('[data-guest-auth="signup"]', { visible: true })
    expect(await page.$eval('input[autocomplete="email"]', (input) => input.value)).toBe('reader@example.test')

    await page.setRequestInterception(true)
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/auth/sign-up/email') {
        void request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ token: null, user: { name: 'Reader', email: 'reader@example.test', id: 'reader' } }),
        })
      } else if (new URL(request.url()).pathname !== '/api/auth/get-session') {
        void request.continue()
      }
    })
    const recheck = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/auth/get-session')
    const checked = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/get-session')
    await page.locator('form button[type=submit]').click()
    const pending = await recheck
    await page.waitForFunction(() =>
      document
        .querySelector('[role="dialog"]')
        ?.textContent?.includes('we sent a verification link to reader@example.test'),
    )
    await pending.continue()
    expect(await (await checked).json()).toBeNull()
    expect(await page.$('[role="dialog"] input[autocomplete="email"]')).toBeTruthy()
    await page.keyboard.press('Escape')
    await page.waitForSelector('[role="dialog"]', { hidden: true })
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-guest-auth') === 'signup')
  }, 30_000)
})
