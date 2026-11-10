import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'

let browser: TestBrowser
let page: Page
const marker = 'private-replay-unique-7e9a'
const bytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mioAAAAASUVORK5CYII='
const inline = `data:image/png;doop-resource=${marker};base64,${bytes}`
let sequence = 0
beforeAll(async () => {
  browser = await openBrowser() // Required native check: no skip on missing browser.
  page = await browser.newPage()
}, 30_000)
afterAll(async () => {
  await page?.close()
  await browser?.close()
})

async function reset() {
  await page.goto(fixtureUrl('frameReplay.html'))
  await page.waitForFunction(
    () => window.testReady && window.messages.some((message) => message.type === 'doop:frame-ready'),
  )
}
async function send(html: string, privateMedia: boolean) {
  const reqId = `private-replay-${++sequence}`
  await page.evaluate(
    ({ html, privateMedia, inline, marker, reqId }) => {
      const frame = document.querySelector('iframe')!
      frame.toggleAttribute('data-doop-private-preview', privateMedia)
      frame.contentWindow!.postMessage(
        {
          type: 'doop:html',
          html,
          privateMedia,
          reqId,
          replacements: privateMedia ? [{ inline, canonical: `/a/${marker}.png` }] : [],
        },
        '*',
      )
    },
    { html, privateMedia, inline, marker, reqId },
  )
  await page.waitForFunction(
    (reqId) =>
      window.messages.some(
        (message) => message.type === 'doop:html-result' && (message as { reqId?: string }).reqId === reqId,
      ),
    {},
    reqId,
  )
}
async function flushSnapshot() {
  await page.evaluate(() => {
    window.snapshot()
  })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
function assertPrivateAbsent(events: string) {
  for (const secret of [marker, bytes, 'PRIVATE_INITIAL_9c2', 'PRIVATE_MUTATION_1b3', 'PRIVATE_AFTER_PLAIN_4d5'])
    expect(events).not.toContain(secret)
  expect(events).toContain('Private media is unavailable in replay.')
}

it('real rrweb omits initial private content and later mutations across both privacy transitions', async () => {
  await reset()
  await send(`<h1>PRIVATE_INITIAL_9c2</h1><img src="${inline}">`, true)
  await page.evaluate(() => window.startReplay())
  await page.waitForFunction(() => window.events.some((event) => event.type === 2))
  const child = page.frames().find((frame) => frame !== page.mainFrame())!
  await child.evaluate(() => {
    document.body.append(Object.assign(document.createElement('p'), { textContent: 'PRIVATE_MUTATION_1b3' }))
  })
  await flushSnapshot()
  assertPrivateAbsent(await page.evaluate(() => JSON.stringify(window.events)))
  await send('<h1>PUBLIC_AFTER_PRIVATE_6e7</h1>', false)
  await page.waitForFunction(() => JSON.stringify(window.events).includes('PUBLIC_AFTER_PRIVATE_6e7'))
  await send(`<h1>PRIVATE_AFTER_PLAIN_4d5</h1><img src="${inline}">`, true)
  await child.evaluate(() => {
    document.body.append(Object.assign(document.createElement('p'), { textContent: 'PRIVATE_MUTATION_1b3' }))
  })
  await flushSnapshot()
  const events = await page.evaluate(() => JSON.stringify(window.events))
  expect(events).toContain('PUBLIC_AFTER_PRIVATE_6e7')
  assertPrivateAbsent(events)
})

it('real rrweb redacts initial and mutated static private preview srcdoc bytes', async () => {
  await reset()
  await page.evaluate(
    ({ marker, inline }) => {
      const preview = document.createElement('iframe')
      preview.setAttribute('data-doop-private-preview', '')
      preview.sandbox = ''
      preview.srcdoc = `<h1>PRIVATE_INITIAL_9c2</h1><img src="${inline}">`
      preview.id = marker
      document.body.append(preview)
      window.startReplay()
    },
    { marker: 'static-preview', inline },
  )
  await page.waitForFunction(() => window.events.some((event) => event.type === 2))
  await page.evaluate((inline) => {
    document.querySelector<HTMLIFrameElement>('#static-preview')!.srcdoc =
      `<p>PRIVATE_MUTATION_1b3</p><img src="${inline}">`
  }, inline)
  await flushSnapshot()
  assertPrivateAbsent(await page.evaluate(() => JSON.stringify(window.events)))
})
