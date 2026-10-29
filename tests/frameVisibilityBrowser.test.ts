import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'

type Message = { type: string; reqId?: string; html?: string; ok?: boolean }
type Fixture = { messages: Message[]; testReady: boolean }

describe.skipIf(!findBrowserPath())('layer visibility during text editing', () => {
  let browser: TestBrowser
  let page: Page
  let seq = 0
  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    await page.goto(fixtureUrl('frameReplay.html'))
    await page.waitForFunction(() =>
      (window as unknown as Fixture).messages?.some((m) => m.type === 'doop:frame-ready'),
    )
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  async function send(message: Record<string, unknown>) {
    await page.evaluate(
      (message) => document.querySelector('iframe')!.contentWindow!.postMessage(message, '*'),
      message,
    )
  }
  async function ask(message: Record<string, unknown>) {
    const reqId = `visibility-${++seq}`
    await send({ ...message, reqId })
    await page.waitForFunction((id) => (window as unknown as Fixture).messages.some((m) => m.reqId === id), {}, reqId)
    return page.evaluate((id) => (window as unknown as Fixture).messages.find((m) => m.reqId === id)!, reqId)
  }
  async function finishEdit() {
    await page.evaluate(() => {
      ;(window as unknown as Fixture).messages = []
    })
    await send({ type: 'doop:edit', on: false })
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.type === 'doop:edited'))
    return page.evaluate(() => (window as unknown as Fixture).messages.find((m) => m.type === 'doop:edited')!.html!)
  }

  it('keeps hidden layers on the next text save and restores their original display when shown', async () => {
    await ask({
      type: 'doop:html',
      html: '<section id="target" style="display:flex!important"><p>Text</p></section><p id="other">Other</p>',
    })
    await send({ type: 'doop:edit', on: true })
    const frame = page.frames().find((frame) => frame !== page.mainFrame())!
    await frame.click('#target p')
    await page.keyboard.type(' edited')
    expect((await ask({ type: 'doop:visibility', selector: '#target', hidden: true })).ok).toBe(true)
    expect(await frame.$eval('#target', (el) => getComputedStyle(el).display)).toBe('none')
    expect(await frame.$('[contenteditable]')).toBeNull()
    await frame.click('#other')
    await page.keyboard.type(' later')
    const hidden = await finishEdit()
    expect(hidden).toContain('data-doop-hidden="true"')
    expect(hidden).toContain('data-doop-display="flex !important"')
    expect(hidden).toContain('display: none !important')
    expect(hidden).toContain('edited')
    expect(hidden).toContain('later')

    await send({ type: 'doop:edit', on: true })
    await ask({ type: 'doop:visibility', selector: '#target', hidden: true })
    await ask({ type: 'doop:visibility', selector: '#target', hidden: false })
    const shown = await finishEdit()
    expect(shown).not.toContain('data-doop-hidden')
    expect(shown).not.toContain('data-doop-display')
    expect(shown).toContain('display: flex !important')
    expect(shown).toContain('edited')
  })
})
