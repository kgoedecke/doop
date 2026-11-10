import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { Frame } from '../shared/types'
import type { ElementInfo, GeometryEdit } from '../src/lib/frameBridge'

/* the fixture's harness: the same declaration as elementResizeBrowser.test.ts,
   which TypeScript merges only while the two stay identical */
declare global {
  interface Window {
    heldResizeReply: MessageEvent | null
    holdResizeReply: boolean
    elementPanelHarness: {
      seed: (frame: Frame) => void
      remote: (frame: Frame) => void
      select: (selector: string) => void
      selectFrame: () => void
      deselect: () => void
      panelOpen: () => boolean
      picked: () => string[]
      pickAlso: (selector: string) => void
      nudge: (dx: number, dy: number) => boolean
      setTool: (tool: 'select' | 'hand') => void
      setZoom: (zoom: number) => void
      undo: () => Promise<void>
      geometry: (selector: string, edit: GeometryEdit) => Promise<ElementInfo | null>
      redo: () => Promise<void>
    }
  }
}

const HTML = `<!doctype html><html><head><style>
  body { margin: 0; padding: 40px }
  #box { width: 200px; height: 100px; background: #ddd }
  #turned { width: 100px; height: 50px; margin-top: 80px; transform: rotate(90deg); background: #fcf }
  #stretched { width: 100px; height: 50px; margin-top: 120px; transform: rotate(90deg) scale(2, 1); background: #cff }
</style></head><body>
  <div id="box"></div>
  <div id="turned"></div>
  <div id="stretched"></div>
</body></html>`

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }

describe.skipIf(!findBrowserPath())('element rotate zones', () => {
  let browser: TestBrowser
  let page: Page
  let saved: Frame
  let saves = 0
  const errors: string[] = []

  const box = (selector: string) =>
    page.$eval(selector, (el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } as Box
    })
  const zone = (corner: string) => box(`[data-rotate-handle="${corner}"]`)
  const centre = async () => {
    const b = await box('[data-resize-handles]')
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  }
  const swung = (c: { x: number; y: number }, from: { x: number; y: number }, degrees: number) => {
    const rad = (degrees * Math.PI) / 180
    const dx = from.x - c.x
    const dy = from.y - c.y
    return { x: c.x + dx * Math.cos(rad) - dy * Math.sin(rad), y: c.y + dx * Math.sin(rad) + dy * Math.cos(rad) }
  }
  function frameDoc() {
    return page.$('iframe').then((h) => h!.contentFrame())
  }
  async function computedRotate(selector: string) {
    const frame = (await frameDoc())!
    return frame.$eval(selector, (el) => getComputedStyle(el).rotate)
  }
  async function select(selector: string) {
    await page.evaluate((s) => window.elementPanelHarness.select(s), selector)
    await page.waitForSelector(`[data-rotate-handle]`)
  }
  async function turn(corner: string, degrees: number, { shift = false, escape = false } = {}) {
    const z = await zone(corner)
    const from = { x: z.left + z.width / 2, y: z.top + z.height / 2 }
    const c = await centre()
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    if (shift) await page.keyboard.down('Shift')
    const mid = swung(c, from, degrees / 2)
    const to = swung(c, from, degrees)
    await page.mouse.move(mid.x, mid.y)
    await page.mouse.move(to.x, to.y, { steps: 4 })
    if (escape) await page.keyboard.press('Escape')
    await page.mouse.up()
    if (shift) await page.keyboard.up('Shift')
  }
  async function reset() {
    await page.evaluate(() => window.elementPanelHarness.deselect())
    await page.waitForFunction(() => !document.querySelector('[data-resize-handles]'))
    const updatedAt = saved.updatedAt + 1
    saved = { ...saved, html: HTML.replace(/<body\b/, `<body data-test-reset="${updatedAt}"`), updatedAt }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    await page.evaluate(() => window.elementPanelHarness.selectFrame())
    const frame = (await frameDoc())!
    await frame.waitForFunction((version) => document.body.dataset.testReset === String(version), {}, updatedAt)
  }

  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.setViewport({ width: 1000, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      if (new URL(request.url()).pathname === '/api/frames/f' && request.method() === 'PATCH') {
        saves += 1
        saved = { ...saved, ...JSON.parse(request.postData()!) }
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) })
      } else await request.continue()
    })
    await page.goto(fixtureUrl('elementPanel.html'))
    await page.waitForFunction(() => !!window.elementPanelHarness)
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Turn',
      x: 40,
      y: 60,
      width: 600,
      height: 500,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
      html: HTML,
    }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    await page.evaluate(() => window.elementPanelHarness.selectFrame())
    await page.waitForSelector('iframe')
    await page.evaluate(() => window.elementPanelHarness.setTool('select'))
  }, 60_000)

  afterAll(async () => {
    await page?.screenshot({ path: '/tmp/doop-element-rotate.png' })
    await page?.close()
    await browser?.close()
    expect(errors).toEqual([])
  })

  it('wears a rotate zone outside each corner, clear of the grips, with the rotate cursor', async () => {
    await reset()
    await select('#box')
    expect(
      await page.$$eval('[data-rotate-handle]', (els) => els.map((e) => e.getAttribute('data-rotate-handle'))),
    ).toEqual(['nw', 'ne', 'se', 'sw'])
    const furniture = await box('[data-resize-handles]')
    const se = await zone('se')
    const grip = await box('[data-resize-handle="se"]')
    expect(se.left).toBeGreaterThanOrEqual(grip.right)
    expect(se.top).toBeGreaterThanOrEqual(grip.bottom)
    expect(se.left).toBeGreaterThan(furniture.right)
    const cursor = await page.$eval(
      '[data-rotate-handle="se"]',
      (el) => decodeURIComponent(getComputedStyle(el).cursor).match(/data-cursor="([^"]+)"/)?.[1],
    )
    expect(cursor).toBe('rotate')
  }, 20_000)

  it('turns the element about its centre, previewing live and saving once on release', async () => {
    await reset()
    await select('#box')
    const before = saves
    await turn('se', 90)
    await expect.poll(() => computedRotate('#box')).toMatch(/^(89\.\d+|90(\.\d+)?)deg$/)
    await expect.poll(() => saves).toBe(before + 1)
    expect(saved.html).toMatch(/rotate: (89\.\d+|90(\.\d+)?)deg/)
    /* the furniture turned with it: the box's own size, not its bounds */
    expect(await page.$eval('[data-resize-handles]', (el) => (el as HTMLElement).style.transform)).toMatch(
      /^translate\(-50%, -50%\) rotate\((89\.\d+|90(\.\d+)?)deg\)$/,
    )
    expect(await page.$eval('[data-element-size]', (el) => el.textContent)).toBe('200 × 100')
    await page.evaluate(() => window.elementPanelHarness.undo())
    await expect.poll(() => computedRotate('#box')).toBe('none')
  }, 20_000)

  it('snaps to fifteen degrees with Shift', async () => {
    await reset()
    await select('#box')
    await turn('ne', 50, { shift: true })
    await expect.poll(() => computedRotate('#box')).toBe('45deg')
    await expect.poll(() => saved.html).toContain('rotate: 45deg')
  }, 20_000)

  it('puts the element back on Escape and saves nothing', async () => {
    await reset()
    await select('#box')
    const before = saves
    await turn('sw', 60, { escape: true })
    await new Promise((r) => setTimeout(r, 300))
    expect(await computedRotate('#box')).toBe('none')
    expect(saves).toBe(before)
  }, 20_000)

  it("reads a turned element's scale each way, so a stretched one gets the right box", async () => {
    await reset()
    await select('#stretched')
    await page.waitForFunction(
      () => document.querySelector('[data-resize-handles]')?.getAttribute('data-element-rotation') === '90',
    )
    expect(await page.$eval('[data-element-size]', (el) => el.textContent)).toBe('200 × 50')
    const furniture = await box('[data-resize-handles]')
    /* turned a quarter, the 200×50 box stands 50 wide and 200 tall on screen */
    expect(furniture.width).toBeCloseTo(50, 0)
    expect(furniture.height).toBeCloseTo(200, 0)
  }, 20_000)

  it('resizes a turned element along its own axes, from grips that turned with it', async () => {
    await reset()
    await select('#turned')
    await page.waitForFunction(
      () => document.querySelector('[data-resize-handles]')?.getAttribute('data-element-rotation') === '90',
    )
    /* turned a quarter, the east grip sits under the box's centre: pulling
       it down on screen pulls the element's width */
    const grip = await box('[data-resize-handle="e"]')
    const from = { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2 }
    const c = await centre()
    expect(from.y).toBeGreaterThan(c.y)
    expect(Math.abs(from.x - c.x)).toBeLessThan(2)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x, from.y + 20)
    await page.mouse.move(from.x, from.y + 40, { steps: 4 })
    await page.mouse.up()
    const frame = (await frameDoc())!
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#turned')!).width === '140px')
    await expect.poll(() => saved.html).toContain('width: 140px')
    expect(await page.$eval('[data-element-size]', (el) => el.textContent)).toBe('140 × 50')
  }, 20_000)
  it.each(['transform: scale(2, 1)', 'scale: 2 1'])(
    'uses bounds without invalid grips under a nonuniform ancestor (%s)',
    async (parentStyle) => {
      await reset()
      const doc = (await frameDoc())!
      await doc.$eval(
        '#turned',
        (el, style) => {
          const parent = document.createElement('div')
          parent.setAttribute('style', style)
          el.parentElement!.insertBefore(parent, el)
          parent.appendChild(el)
        },
        parentStyle,
      )
      await page.evaluate(() => window.elementPanelHarness.select('#turned'))
      await page.waitForSelector('[data-element-outline]')
      expect(await page.$('[data-resize-handles]')).toBeNull()
      expect(await page.$('[data-rotate-handle]')).toBeNull()
      const actual = await doc.$eval('#turned', (el) => {
        const r = el.getBoundingClientRect()
        return { width: r.width, height: r.height }
      })
      const outline = await box('[data-element-outline]')
      expect(outline.width).toBeCloseTo(actual.width, 0)
      expect(outline.height).toBeCloseTo(actual.height, 0)
    },
    20_000,
  )
})
