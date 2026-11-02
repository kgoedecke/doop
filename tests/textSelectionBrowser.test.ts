import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Frame, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'

type Message = { type: string; reqId?: string }
type Fixture = { messages: Message[] }

describe.skipIf(!findBrowserPath())('text selection while editing', () => {
  let browser: TestBrowser
  let page: Page
  let frame: Frame
  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    await page.goto(fixtureUrl('frameReplay.html'))
    await page.waitForFunction(() =>
      (window as unknown as Fixture).messages?.some((m) => m.type === 'doop:frame-ready'),
    )
    await page.evaluate(() =>
      document.querySelector('iframe')!.contentWindow!.postMessage(
        {
          type: 'doop:html',
          reqId: 'selection-html',
          html: '<p id="text" style="font:24px/1.4 Arial;margin:0;white-space:pre-wrap">Live counter of requests</p>',
        },
        '*',
      ),
    )
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.reqId === 'selection-html'))
    await page.evaluate(() =>
      document.querySelector('iframe')!.contentWindow!.postMessage({ type: 'doop:edit', on: true }, '*'),
    )
    frame = page.frames().find((f) => f !== page.mainFrame())!
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  async function drag(fromFraction: number, toFraction: number) {
    const iframe = (await page.$('iframe'))!.boundingBox()
    const text = await frame.$eval('#text', (el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const r = range.getBoundingClientRect()
      return { left: r.left, width: r.width, mid: r.top + r.height / 2 }
    })
    const box = (await iframe)!
    const y = box.y + text.mid
    await page.mouse.move(box.x + text.left + text.width * fromFraction, y)
    await page.mouse.down()
    await page.mouse.move(box.x + text.left + text.width * toFraction, y, { steps: 8 })
    await page.mouse.up()
  }
  const selected = () => frame.evaluate(() => getSelection()!.toString())

  it('keeps a drag selection inside the text being edited', async () => {
    await frame.click('#text')
    expect(await frame.$('#text[contenteditable]')).not.toBeNull()
    await drag(0.05, 0.6)
    expect((await selected()).length).toBeGreaterThan(3)
  })

  it('replaces an existing selection with the next drag', async () => {
    await frame.click('#text')
    expect(await frame.$('#text[contenteditable]')).not.toBeNull()
    await drag(0.02, 0.3)
    const first = await selected()
    expect(first.length).toBeGreaterThan(0)
    /* starting outside the first range: a press inside it would begin a
       native drag of the selected text instead of a new selection */
    await drag(0.6, 0.95)
    const second = await selected()
    expect(second.length).toBeGreaterThan(0)
    expect('Live counter of requests'.indexOf(second)).toBeGreaterThanOrEqual(first.length)
  })

  it('still places a caret on a plain click', async () => {
    await frame.click('#text')
    expect(await selected()).toBe('')
  })
})
