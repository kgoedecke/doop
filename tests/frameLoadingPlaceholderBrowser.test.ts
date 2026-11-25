import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

declare global {
  interface Window {
    heldLoadingHtml?: unknown
  }
}

describe.skipIf(!findBrowserPath())('first canvas HTML placeholder', () => {
  const pages = pagePerTest()

  it.each([
    { label: 'default', enabled: false, theme: 'light', width: 560, color: 'rgba(0, 0, 0, 0)', blocks: 0 },
    { label: 'wide light', enabled: true, theme: 'light', width: 560, color: 'rgb(247, 247, 247)', blocks: 4 },
    { label: 'narrow dark', enabled: true, theme: 'dark', width: 300, color: 'rgb(35, 35, 37)', blocks: 3 },
  ])(
    'holds the $label surface only until the first HTML is applied',
    async ({ enabled, theme, width, color, blocks }) => {
      const page = await pages.open()
      await page.setViewport({ width: 1280, height: 800 })
      await page.evaluateOnNewDocument(
        (enabled, theme) => {
          if (window === window.top) {
            localStorage.setItem('doop-theme', theme)
            if (enabled) localStorage.setItem('doop:frame-loading-placeholder', '1')
            return
          }
          window.addEventListener(
            'message',
            (event) => {
              if (window.heldLoadingHtml || event.source !== parent || event.data?.type !== 'doop:html') return
              event.stopImmediatePropagation()
              window.heldLoadingHtml = event.data
            },
            true,
          )
        },
        enabled,
        theme,
      )
      const frame = {
        ...canvasFrame({ id: 'first', name: 'First', x: 100, y: 100, width, height: 300 }),
        html: '<style>#loaded { color: rgb(18, 78, 150) }</style><main id="loaded">Live</main>',
      }
      await openCanvasPage(page, [frame])
      const el = (await page.waitForSelector('iframe[data-doop-frame]'))!
      const child = (await el.contentFrame())!
      await child.waitForFunction(() => !!window.heldLoadingHtml)
      const geometry = await el.boundingBox()
      const original = await el.evaluateHandle((iframe) => (iframe as HTMLIFrameElement).contentWindow)
      const placeholder = () =>
        child.evaluate(() => {
          const style = getComputedStyle(document.body, '::before')
          return [
            style.backgroundColor,
            style.backgroundImage.match(/linear-gradient/g)?.length ?? 0,
            style.pointerEvents,
          ]
        })
      expect(await placeholder()).toEqual([color, blocks, enabled ? 'none' : 'auto'])
      expect(await child.$('#loaded')).toBeNull()

      // The placeholder follows the HTML morph even once the editor request has timed out.
      if (enabled && theme === 'dark') {
        const releaseAt = await child.evaluate(() => performance.now() + 2200)
        await child.waitForFunction((deadline) => performance.now() >= deadline, {}, releaseAt)
      }
      const held = await child.evaluate(() => window.heldLoadingHtml)
      await el.evaluate(
        (iframe, command) => (iframe as HTMLIFrameElement).contentWindow!.postMessage(command, '*'),
        held,
      )
      const artwork = (await child.waitForSelector('#loaded'))!
      expect(await artwork.evaluate((node) => getComputedStyle(node).color)).toBe('rgb(18, 78, 150)')
      expect(await placeholder()).toEqual(['rgba(0, 0, 0, 0)', 0, 'auto'])
      expect(await el.boundingBox()).toEqual(geometry)
      expect(await el.evaluate((iframe, win) => (iframe as HTMLIFrameElement).contentWindow === win, original)).toBe(
        true,
      )
    },
  )
})
