import type { Page } from 'puppeteer-core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Frame } from '../shared/types'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

function captureFrameUpdates(page: Page) {
  const updates: { path: string; patch: Partial<Frame> }[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'PATCH' && path.startsWith('/api/frames/'))
      updates.push({ path, patch: JSON.parse(request.postData()!) })
  })
  return updates
}

describe.skipIf(!findBrowserPath())('Design panel drafts', () => {
  const pages = pagePerTest()
  let page: Page
  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1600, height: 900 })
  })

  it.each(['canvas', 'Layers'])('saves the draft to the original element when picking from %s', async (route) => {
    const board = canvasFrame({ id: 'f', name: 'Board', x: 0, y: 0, width: 320, height: 240 })
    board.html =
      '<body><div id="a" style="height:60px;background:red">A</div><div id="b" style="height:80px;background:blue">B</div></body>'
    await openCanvasPage(page, [board])
    await page.click('[data-row-key="f"]')
    await page.click('[data-row-key="f|#a"]')
    const fill = 'input[aria-label="Fill color"]'
    await page.waitForSelector(fill)
    const updates = captureFrameUpdates(page)
    await page.click(fill, { count: 3 })
    await page.keyboard.sendCharacter('FFFF00')

    if (route === 'canvas') {
      const frame = (await (await page.waitForSelector('iframe[title="Board"]'))!.contentFrame())!
      await frame.click('#b')
    } else {
      await page.click('[data-row-key="f|#b"]')
    }
    await page.waitForFunction(
      (field) => document.querySelector<HTMLInputElement>(field)?.value === '#0000ff',
      {},
      fill,
    )
    await expect.poll(() => updates).toMatchObject([{ path: '/api/frames/f', patch: { html: expect.any(String) } }])
    const colors = await page.evaluate((html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      return ['#a', '#b'].map((selector) => doc.querySelector<HTMLElement>(selector)!.style.backgroundColor)
    }, updates[0]!.patch.html!)
    expect(colors).toEqual(['rgb(255, 255, 0)', 'blue'])
  })

  it('saves a frame width to the original frame when picking another frame title', async () => {
    const one = canvasFrame({ id: 'one', name: 'One', x: 0, y: 40, width: 200, height: 120 })
    const two = canvasFrame({ id: 'two', name: 'Two', x: 280, y: 40, width: 240, height: 120 })
    await openCanvasPage(page, [one, two])
    const title = (name: string) => `div:has(iframe[title="${name}"]) > [data-frame-title]`
    await page.click(title('One'))
    const width = 'input[aria-label="Width"]'
    await page.waitForSelector(width)
    const updates = captureFrameUpdates(page)
    await page.click(width, { count: 3 })
    await page.keyboard.sendCharacter('220')

    await page.click(title('Two'))
    await page.waitForFunction((field) => document.querySelector<HTMLInputElement>(field)?.value === '240', {}, width)
    await expect.poll(() => updates).toMatchObject([{ path: '/api/frames/one', patch: { width: 220 } }])
  })

  it.each(['title', 'surface'])(
    'saves a layer rename to the original frame when pressing another frame %s',
    async (where) => {
      const one = canvasFrame({ id: 'one', name: 'One', x: 0, y: 40, width: 200, height: 120 })
      const two = canvasFrame({ id: 'two', name: 'Two', x: 280, y: 40, width: 240, height: 120 })
      await openCanvasPage(page, [one, two])
      await page.click('[data-row-key="one"]', { count: 2 })
      const rename = '[role="tree"] input'
      await page.waitForSelector(rename)
      const updates = captureFrameUpdates(page)
      await page.keyboard.sendCharacter('Renamed')

      if (where === 'title') await page.click('div:has(iframe[title="Two"]) > [data-frame-title]')
      else {
        const box = (await (await page.waitForSelector('iframe[title="Two"]'))!.boundingBox())!
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      }
      await page.waitForSelector(rename, { hidden: true })
      await expect.poll(() => updates).toMatchObject([{ path: '/api/frames/one', patch: { name: 'Renamed' } }])
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
    },
  )

  it('saves the page background when a frame title closes the Page panel', async () => {
    const frame = canvasFrame({ id: 'f', name: 'Board', x: 0, y: 40, width: 200, height: 120 })
    await openCanvasPage(page, [frame], '', { pages: [{ id: 'home', name: 'Home' }] })
    await page.click('[aria-label="Page settings"]')
    const background = 'input[aria-label="Background"]'
    await page.waitForSelector(background)
    await page.click(background, { count: 3 })
    await page.keyboard.sendCharacter('112233')
    const colors: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/canvases/c/pages/home/background')
        colors.push(JSON.parse(request.postData()!).color)
    })

    await page.click('[data-frame-title]')
    await page.waitForSelector('input[aria-label="Width"]')
    await expect.poll(() => colors).toEqual(['#112233'])
  })
})
