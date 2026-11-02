import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot.ts'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser.ts'

type Inspect = { classes: string[]; backgroundColor: string; padding: number[] } | null
type Message = { type: string; reqId?: string; info?: Inspect }
/* the replay fixture collects every frame message on window.messages; the
   cast is inlined because puppeteer serialises each callback's source */
type Fixture = { messages: Message[]; testReady: boolean }

// Agent design systems (design.how's "glaze", "quartz") scope every rule under
// a class on <body>. The runtime morphs incoming HTML into its bootstrap
// document, so the body's own attributes have to travel too or the whole
// stylesheet matches nothing and the frame renders as browser defaults.
describe.skipIf(!findBrowserPath())('frame runtime body attributes', () => {
  let browser: TestBrowser
  let page: Page
  let seq = 0
  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    await page.goto(fixtureUrl('frameReplay.html'))
    await page.waitForFunction(
      () =>
        (window as unknown as Fixture).testReady &&
        (window as unknown as Fixture).messages.some((m) => m.type === 'doop:frame-ready'),
      {
        timeout: 60_000,
      },
    )
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  async function ask<T extends Message>(message: Record<string, unknown>, reply: string): Promise<T> {
    const reqId = `req-${++seq}`
    await page.evaluate((message) => document.querySelector('iframe')!.contentWindow!.postMessage(message, '*'), {
      ...message,
      reqId,
    })
    await page.waitForFunction(
      (reply, reqId) => (window as unknown as Fixture).messages.some((m) => m.type === reply && m.reqId === reqId),
      {},
      reply,
      reqId,
    )
    return page.evaluate(
      (reply, reqId) => (window as unknown as Fixture).messages.find((m) => m.type === reply && m.reqId === reqId) as T,
      reply,
      reqId,
    )
  }
  const render = (html: string) => ask({ type: 'doop:html', html }, 'doop:html-result')
  const inspectBody = async () =>
    (await ask<Message>({ type: 'doop:inspect', selector: 'body' }, 'doop:inspect-result')).info

  it('applies styles scoped under a body class', async () => {
    await render(
      '<!doctype html><html><head><style>.glaze{background:rgb(1, 2, 3);padding:7px}</style></head>' +
        '<body class="glaze"><h1>Scoped</h1></body></html>',
    )
    const body = await inspectBody()
    expect(body?.classes).toEqual(['glaze'])
    expect(body?.backgroundColor).toBe('rgb(1, 2, 3)')
    expect(body?.padding).toEqual([7, 7, 7, 7])
  })

  it('keeps inline body styles and drops attributes the next design no longer carries', async () => {
    await render('<!doctype html><html><body style="background:rgb(4, 5, 6)"><p>Inline</p></body></html>')
    const inline = await inspectBody()
    expect(inline?.classes).toEqual([])
    expect(inline?.backgroundColor).toBe('rgb(4, 5, 6)')

    await render('<!doctype html><html><body><p>Plain</p></body></html>')
    const plain = await inspectBody()
    expect(plain?.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  })
})
