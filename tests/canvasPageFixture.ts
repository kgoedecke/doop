import type { Page } from 'puppeteer-core'
import type { Canvas, CanvasPageInfo, Frame } from '../shared/types'
import { fixtureUrl } from './browser'

declare global {
  interface Window {
    canvasPageHarness: {
      seed: (frames: Frame[], canvas?: Partial<Canvas>) => void
      /** the page list as the room would send it after someone's edit */
      setPages: (pages: CanvasPageInfo[]) => void
    }
  }
}

/** A frame on canvas `c`, the one the fixture opens. */
export function canvasFrame(frame: Pick<Frame, 'id' | 'name' | 'x' | 'y' | 'width' | 'height'>): Frame {
  return { canvasId: 'c', html: '<body></body>', createdAt: 0, updatedAt: 0, updatedBy: 'Tester', ...frame }
}

/**
 * Open the real canvas page on `frames` with no backend behind it, for tests
 * whose subject is what the browser does with the page: the room's socket
 * never opens, the session is a signed-in person, and every other API call is
 * answered with an empty object. `search` is the page URL's query, as a deep
 * link carries it. `canvas` is anything else the room's canvas would carry:
 * its pages, or the `landingPageId` the server sends for a library canvas.
 */
export async function openCanvasPage(
  page: Page,
  frames: Frame[],
  search = '',
  canvas: Partial<Canvas> = {},
): Promise<void> {
  await prepareCanvasPage(page)
  await showCanvasPage(page, frames, search, canvas)
}

/** The stubs alone, for a test that has something to do before the page loads. */
export async function prepareCanvasPage(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'WebSocket', {
      value: class {
        readyState = 0
        static OPEN = 1
        close() {}
      },
    })
  })
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return void request.continue()
    const body =
      path === '/api/auth/get-session'
        ? { user: { id: 'u', name: 'Tester', email: 'tester@test.dev' }, session: { id: 's', userId: 'u' } }
        : path === '/api/canvases/c/fonts'
          ? []
          : {}
    void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

/** Load the fixture, or load it again, on a prepared page. */
export async function showCanvasPage(
  page: Page,
  frames: Frame[],
  search = '',
  canvas: Partial<Canvas> = {},
): Promise<void> {
  await page.goto(fixtureUrl(`canvasPage.html${search}`))
  await page.waitForFunction(() => !!window.canvasPageHarness && !!document.querySelector('.stage'))
  await page.evaluate((frames, canvas) => window.canvasPageHarness.seed(frames, canvas), frames, canvas)
  await page.waitForSelector('[data-frame-title]')
}
