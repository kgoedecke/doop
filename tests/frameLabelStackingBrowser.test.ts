import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { Frame } from '../shared/types'

/* the elementPanel fixture's harness, as far as this file uses it (the full
   declaration lives in elementResizeBrowser.test.ts) */
type Harness = { seed: (frames: Frame | Frame[]) => void; setZoom: (zoom: number) => void }
type HarnessWindow = { elementPanelHarness: Harness }

const HTML = '<!doctype html><html><body style="margin:0;background:#ddd"></body></html>'

function frame(id: string, x: number, y: number, width: number, height: number): Frame {
  return {
    id,
    canvasId: 'c',
    name: id,
    x,
    y,
    width,
    height,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'Tester',
    html: HTML,
  }
}

describe.skipIf(!findBrowserPath())('frame name stacking', () => {
  let browser: TestBrowser
  let page: Page
  const errors: string[] = []

  /** The frame whose name is drawn at the centre of `id`'s name, or null. */
  function nameOnTop(id: string) {
    return page.evaluate((id) => {
      const titles = [...document.querySelectorAll<HTMLElement>('[data-frame-title]')]
      const title = titles.find((t) => t.textContent?.includes(id))
      if (!title) return 'missing'
      const r = title.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + 4, r.top + r.height / 2)
      return hit?.closest('[data-frame-title]')?.textContent ?? null
    }, id)
  }

  async function seed(frames: Frame[], zoom = 1) {
    await page.evaluate((zoom) => (window as unknown as HarnessWindow).elementPanelHarness.setZoom(zoom), zoom)
    await page.evaluate((frames) => (window as unknown as HarnessWindow).elementPanelHarness.seed(frames), frames)
    await page.waitForFunction((n) => document.querySelectorAll('[data-frame-title]').length === n, {}, frames.length)
  }

  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.setViewport({ width: 1000, height: 900 })
    await page.goto(fixtureUrl('elementPanel.html'))
    await page.waitForFunction(() => !!(window as unknown as { elementPanelHarness?: unknown }).elementPanelHarness)
  }, 60_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    expect(errors).toEqual([])
  })

  it("draws a later frame's name over an earlier frame", async () => {
    // a second, smaller image pasted on top of the first: its name lands over the first image
    await seed([frame('first', 40, 60, 600, 500), frame('second', 200, 200, 200, 200)])
    expect(await nameOnTop('second')).toBe('second')
  })

  it("lets a later frame cover an earlier frame's name", async () => {
    await seed([frame('small', 200, 200, 200, 200), frame('big', 40, 60, 600, 500)])
    expect(await nameOnTop('small')).toBeNull()
  })

  it('keeps the name 12px type a fixed gap above the frame at every zoom', async () => {
    for (const zoom of [0.25, 1, 3]) {
      await seed([frame('only', 100, 100, 400, 300)], zoom)
      const box = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-frame-title]')!
        const title = el.getBoundingClientRect()
        const box = el.parentElement!.getBoundingClientRect()
        const text = el.querySelector('span')!.getBoundingClientRect()
        return {
          left: title.left - box.left,
          gap: box.top - title.bottom,
          right: box.right - title.right,
          textHeight: text.height,
        }
      })
      expect(box.left).toBeCloseTo(0, 0)
      expect(box.gap).toBeCloseTo(6, 0)
      expect(box.right).toBeGreaterThanOrEqual(-0.5)
      // 12px type on an 18px line, the same on screen whatever the zoom
      expect(box.textHeight).toBeCloseTo(18, 0)
    }
  })
})
