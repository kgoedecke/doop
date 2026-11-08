import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'

type Message = { type: string; reqId?: string; ok?: boolean }
type Fixture = { messages: Message[] }

/* The live document follows a rename's stamp: the id the saved document
   gives the element, and a rolled-back stamp coming off again. */
describe.skipIf(!findBrowserPath())('layer renames in the live frame', () => {
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

  async function ask(message: Record<string, unknown>) {
    const reqId = `rename-${++seq}`
    await page.evaluate((message) => document.querySelector('iframe')!.contentWindow!.postMessage(message, '*'), {
      ...message,
      reqId,
    })
    await page.waitForFunction((id) => (window as unknown as Fixture).messages.some((m) => m.reqId === id), {}, reqId)
    return page.evaluate((id) => (window as unknown as Fixture).messages.find((m) => m.reqId === id)!, reqId)
  }
  const attrs = (selector: string) =>
    page
      .frames()
      .find((frame) => frame !== page.mainFrame())!
      .$eval(selector, (el) => ({ name: el.getAttribute('data-doop-name'), id: el.getAttribute('data-doop-id') }))

  it('stamps the id with the name, keeps one the element wears, and takes a rolled-back stamp off', async () => {
    await ask({ type: 'doop:html', html: '<p id="a">Text</p><p id="b" data-doop-id="keep00">Other</p>' })
    expect((await ask({ type: 'doop:rename', selector: '#a', name: 'Lead', elementId: 'abc123' })).ok).toBe(true)
    expect(await attrs('#a')).toEqual({ name: 'Lead', id: 'abc123' })
    /* an element already carrying an id keeps it */
    await ask({ type: 'doop:rename', selector: '#b', name: 'Aside', elementId: 'zzz999' })
    expect(await attrs('#b')).toEqual({ name: 'Aside', id: 'keep00' })
    /* the failed first rename rolls its stamp back with the name */
    await ask({ type: 'doop:rename', selector: '#a', name: null, elementId: null })
    expect(await attrs('#a')).toEqual({ name: null, id: null })
    /* undo and redo reach the element by its id, without a stamp */
    await ask({ type: 'doop:rename', selector: '[data-doop-id="keep00"]', name: null })
    expect(await attrs('#b')).toEqual({ name: null, id: 'keep00' })
  })
})
