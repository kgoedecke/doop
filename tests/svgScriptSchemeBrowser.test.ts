import { expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser } from './browser'

it.skipIf(!findBrowserPath())(
  'removes browser-normalized script schemes from the standalone SVG and retains safe links/CSP',
  async () => {
    const browser = await openBrowser()
    try {
      const page = await browser.newPage()
      await page.goto(fixtureUrl('frameRaster.html'))
      await page.waitForFunction(() => typeof (window as unknown as { svgText?: unknown }).svgText === 'function')
      const svg = await page.evaluate(() =>
        (window as unknown as { svgText: (opts: { html: string }) => Promise<string> }).svgText({
          html:
            '<a id="tab" href="java&#9;script:go()">tab</a><a id="lf" href="java&#10;script:go()">LF</a>' +
            '<a id="cr" href="vb&#13;script:go()">CR</a><a id="safe" href="https://doop.design/safe">safe</a>',
        }),
      )
      expect(svg).toContain("default-src 'none'")
      const view = await browser.newPage()
      await view.goto('data:image/svg+xml,' + encodeURIComponent(svg))
      const links = await view.evaluate(() =>
        ['tab', 'lf', 'cr', 'safe'].map((id) => document.getElementById(id)?.getAttribute('href')),
      )
      expect(links).toEqual([null, null, null, 'https://doop.design/safe'])
    } finally {
      await browser.close()
    }
  },
  30_000,
)
