import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'

/* A bundler writes a stylesheet's url()s relative to the sheet, which sits
   in another directory than the page. The snippet must resolve them against
   the sheet, or every font 404s and the frame renders in a fallback face. */
describe.skipIf(!findBrowserPath())('design-sync stylesheet urls', () => {
  const pages = pagePerTest()

  it('resolves url()s against their stylesheet, so its fonts are inlined', async () => {
    const page = await pages.open()
    const upload = page.waitForRequest((request) => request.url().includes('/ingest/') && request.method() === 'POST')
    await page.goto(fixtureUrl('syncCss.html'))
    await page.waitForFunction(() => 'doopSync' in window)
    await page.evaluate(() => (window as unknown as { doopSync: { capture(): void } }).doopSync.capture())

    const { html } = JSON.parse((await upload).postData()!) as { html: string }
    expect(html).toContain('url("data:font/woff2;base64,')
    expect(html).not.toContain('nunito-sans-bold-italic.woff2')
    expect(html).toContain(`url("${fixtureUrl('raster/blue.svg')}")`)
    expect(html).toContain(`url("${fixtureUrl('raster/banner%20(1).svg')}")`)
    expect(html).toContain('content: "url(icon.svg)"')
    expect(html).toContain(`url("${fixtureUrl('raster/bare.svg')}")`)
    expect(html).toContain(`url("${fixtureUrl('raster/single.svg')}")`)
    expect(html).toContain(`url("${fixtureUrl('raster/upper.svg')}")`)
    expect(html).toContain('url(""), url("data:image/svg+xml,%3Csvg%2F%3E")')
    expect(html).toContain('url("#probe-mask")')
    expect(html).toContain(`url("${fixtureUrl('raster/q.svg')}?a\\\\b")`)
    expect(html).toContain('url("../inline.svg")')
  })
})
