import type { Page } from 'puppeteer-core'
import { openIsolatedPage, type IsolatedPage } from '../screenshot.ts'
import { assertPublicNetworkUrl, guardPublicPageRequests } from '../publicUrl.ts'
import { storybookPage, CAPTURE_ROOT_ATTR, type StoryAnswer, type StoryCommand } from '../../shared/storybookCapture.ts'
import type { StoryTab } from '../../shared/storybookAcquire.ts'

/**
 * A story page in the server's renderer: a public Storybook, every request through the
 * renderer's public-network guard, one isolated page per component (the renderer closes a page
 * held past its lease). Spec: .context/specs/storybook-import.md.
 */

const VIEWPORT = { width: 1280, height: 900 }
const NAVIGATION_TIMEOUT_MS = 45_000
/* a fidelity screenshot of something enormous says nothing a smaller one would not */
const MAX_SCREENSHOT_PIXELS = 4_000_000

export interface ServerStoryTab extends StoryTab {
  close(): Promise<void>
}

export async function openStoryTab(): Promise<ServerStoryTab> {
  const isolated: IsolatedPage = await openIsolatedPage()
  const page: Page = isolated.page
  try {
    await guardPublicPageRequests(page)
    await page.setViewport(VIEWPORT)
    /* tsx annotates nested functions with __name, which the page does not have */
    await page.evaluateOnNewDocument('globalThis.__name = (target) => target')
  } catch (error) {
    await isolated.close()
    throw error
  }
  return {
    async open(url) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS })
      /* a redirect can land somewhere private */
      await assertPublicNetworkUrl(page.url())
    },
    run(command: StoryCommand): Promise<StoryAnswer> {
      return page.evaluate(storybookPage, command)
    },
    async screenshot() {
      const root = await page.$(`[${CAPTURE_ROOT_ATTR}]`)
      const box = await root?.boundingBox()
      if (!root || !box || box.width * box.height > MAX_SCREENSHOT_PIXELS || box.width < 1 || box.height < 1)
        return undefined
      const png = await root.screenshot({ type: 'png' })
      return Buffer.from(png)
    },
    async colorScheme(dark) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }])
    },
    close: () => isolated.close(),
  }
}
