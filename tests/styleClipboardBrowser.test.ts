import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'

describe.skipIf(!findBrowserPath())('canonical computed-style clipboard in the actual opaque frame', () => {
  let browser: TestBrowser
  beforeAll(async () => {
    browser = await openBrowser()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
  })
  it('keeps private bytes out of RPC/clipboard/output and admits owned image/fonts without replacing existing font identities', async () => {
    const page = await browser.newPage()
    try {
      await page.goto(fixtureUrl('styleClipboard.html'))
      await page.waitForFunction(
        () => typeof (window as unknown as { styleScenario?: unknown }).styleScenario === 'function',
      )
      const result = await page.evaluate(() =>
        (
          window as unknown as {
            styleScenario: () => Promise<{
              values: Record<string, string>
              copied: boolean
              retained: string
              pasted: boolean
              calls: { entries: { sourceFrameId: string; sourceVersion: number; css: string }[] }[]
              updates: unknown[]
              html: string
            }>
          }
        ).styleScenario(),
      )
      expect(result.copied).toBe(true)
      expect(result.pasted).toBe(true)
      expect(result.values['background-image']).toContain('/a/source.png')
      for (const value of [
        JSON.stringify(result.values),
        result.retained,
        result.html,
        JSON.stringify(result.updates),
      ]) {
        expect(value).not.toContain('doop-resource=')
        expect(value).not.toContain('base64,iVBOR')
      }
      expect(result.calls).toHaveLength(1)
      expect(result.calls[0]!.entries[0]).toMatchObject({ sourceFrameId: 'frame', sourceVersion: 7 })
      expect(result.calls[0]!.entries[0]!.css).toContain('/a/source.woff2')
      expect(result.updates).toHaveLength(1)
      expect(result.html).toContain('/a/owned.png')
      expect(result.html).toContain('/a/owned.woff2')
      expect(result.html).toContain('/a/existing.woff2')
      expect(result.html).not.toContain('/a/source.')
      expect(result.html).toMatch(/font-family:\s*["']?Private-/)
    } finally {
      await page.close()
    }
  }, 30_000)
})
