import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { Frame } from '../shared/types'

/* the rulers fixture mounts the real Stage; its harness is declared in
   rulersBrowser.test.ts */

const HTML = '<!doctype html><html><body style="margin:0;background:#eee"></body></html>'
const frame = (id: string, y: number, height: number): Frame => ({
  id,
  canvasId: 'c',
  pageId: 'first',
  name: id,
  x: 0,
  y,
  width: 400,
  height,
  html: HTML,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
})

describe.skipIf(!findBrowserPath())('frame size badge', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page
  const errors: string[] = []

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (err) => errors.push(String(err)))
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(fixtureUrl('rulers.html'))
    await page.waitForFunction(() => !!window.rulersHarness)
    /* `below` starts just under `above`, where the badge lands when zoomed out */
    await page.evaluate(
      (frames) => {
        window.rulersHarness.seed({
          id: 'c',
          name: 'Badge',
          frames,
          pages: [{ id: 'first', name: 'Main' }],
          createdAt: 0,
          updatedAt: 0,
        })
      },
      [frame('above', 0, 200), frame('below', 220, 400)],
    )
    await page.waitForSelector('[aria-label="Canvas tools"]')
    await page.evaluate(() => window.rulersHarness.viewport({ x: 100, y: 100, zoom: 0.25 }))
  }, 60_000)

  afterAll(() => {
    expect(errors).toEqual([])
  })

  it('paints above a later frame it overlaps', async () => {
    await page.evaluate(() => window.rulersHarness.select(['above']))
    const badge = await page.waitForSelector('[data-frame-size]')
    /* the badge never takes the pointer, so hit-testing skips it; let it for
       the probe, so the topmost painted element at its centre is found */
    const top = await badge!.evaluate((el) => {
      const node = el as HTMLElement
      node.style.pointerEvents = 'auto'
      const r = node.getBoundingClientRect()
      const hit = () => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      const onBadge = hit() === node
      node.style.visibility = 'hidden'
      const underneath = !!hit()?.closest('[data-frame-surface]')
      node.style.visibility = ''
      node.style.pointerEvents = ''
      return { onBadge, underneath }
    })
    expect(top).toEqual({ onBadge: true, underneath: true })
  })
})
