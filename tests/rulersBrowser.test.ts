import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, HTTPRequest, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import type { Canvas, CanvasGuide, Frame } from '../shared/types'

declare global {
  interface Window {
    rulersHarness: {
      seed: (canvas: Canvas) => void
      viewport: (viewport: { x: number; y: number; zoom: number }) => void
      select: (ids: string[]) => void
      state: () => { rulers: boolean; frames: Frame[]; guides: CanvasGuide[]; selectedGuideId: string | null }
      undo: () => Promise<void>
      redo: () => Promise<void>
    }
  }
}

/* The fixture's stage starts 40px down the page; the camera puts the world
   origin 100px into it, at 100%. */
const STAGE_TOP = 40
const CAMERA = { x: 100, y: 100, zoom: 1 }
const screen = (x: number, y: number): [number, number] => [CAMERA.x + x, STAGE_TOP + CAMERA.y + y]

const FRAME: Frame = {
  id: 'f',
  canvasId: 'c',
  pageId: 'first',
  name: 'Card',
  x: 50,
  y: 50,
  width: 200,
  height: 150,
  html: '<!doctype html><html><body style="margin:0;background:#eee"></body></html>',
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
}

describe.skipIf(!findBrowserPath())('rulers and guides', { timeout: 30_000 }, () => {
  let vite: ViteDevServer
  let browser: Browser
  let page: Page
  const guideRequests: { method: string; id: string; body: Partial<CanvasGuide> | null }[] = []
  let frame = FRAME
  const errors: string[] = []

  async function respond(req: HTTPRequest) {
    const path = new URL(req.url()).pathname
    const guide = path.match(/^\/api\/canvases\/c\/guides\/([\w-]+)$/)
    if (guide) {
      const body = req.postData() ? (JSON.parse(req.postData()!) as Partial<CanvasGuide>) : null
      guideRequests.push({ method: req.method(), id: guide[1]!, body })
      const reply = req.method() === 'PUT' ? { ...body, id: guide[1] } : { ok: true }
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) })
    }
    if (path === '/api/frames/f' && req.method() === 'PATCH') {
      frame = { ...frame, ...JSON.parse(req.postData()!) }
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(frame) })
    }
    return req.continue()
  }

  async function drag(from: [number, number], to: [number, number], { alt = false } = {}) {
    await page.mouse.move(...from)
    await page.mouse.down()
    if (alt) await page.keyboard.down('Alt')
    await page.mouse.move(...to, { steps: 6 })
    await page.mouse.up()
    if (alt) await page.keyboard.up('Alt')
  }
  async function toggleRulers() {
    await page.keyboard.down('Shift')
    await page.keyboard.press('R')
    await page.keyboard.up('Shift')
  }
  const state = () => page.evaluate(() => window.rulersHarness.state())
  const lastGuideRequest = () => guideRequests.at(-1)

  beforeAll(async () => {
    vite = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await vite.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (err) => errors.push(String(err)))
    await page.setRequestInterception(true)
    page.on('request', (req) => void respond(req))
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 })
    await page.goto(`${vite.resolvedUrls!.local[0]}tests/fixtures/rulers.html`)
    await page.waitForFunction(() => !!window.rulersHarness)
    await page.evaluate((f) => {
      window.rulersHarness.seed({
        id: 'c',
        name: 'Rulers',
        frames: [f],
        pages: [{ id: 'first', name: 'Main' }],
        createdAt: 0,
        updatedAt: 0,
      })
    }, FRAME)
    await page.waitForSelector('[aria-label="Canvas tools"]')
    await page.evaluate((vp) => window.rulersHarness.viewport(vp), CAMERA)
  }, 60_000)

  afterAll(async () => {
    await page?.screenshot({ path: '/tmp/doop-rulers.png' })
    await page?.close()
    await browser?.close()
    await vite?.close()
    expect(errors).toEqual([])
  })

  it('toggles the rulers with Shift+R and remembers the choice', async () => {
    expect(await page.$('[data-ruler]')).toBeNull()
    await toggleRulers()
    await page.waitForSelector('[data-ruler="top"]')
    expect(await page.$('[data-ruler="left"]')).not.toBeNull()
    expect(await page.evaluate(() => localStorage.getItem('doop:rulers'))).toBe('1')
    await toggleRulers()
    await page.waitForFunction(() => !document.querySelector('[data-ruler]'))
    expect(await page.evaluate(() => localStorage.getItem('doop:rulers'))).toBe('0')

    /* the zoom menu carries the same switch */
    await page.click('[aria-label="Zoom level"]')
    const item = await page.waitForSelector('xpath/.//*[@role="menuitem"][contains(., "Show rulers")]')
    await item!.click()
    await page.waitForSelector('[data-ruler="top"]')
    expect((await state()).rulers).toBe(true)
  })

  it('paints crisp at the device pixel ratio and highlights the selection', async () => {
    const size = await page.$eval('[data-ruler="top"]', (el) => {
      const canvas = el as HTMLCanvasElement
      return { width: canvas.width, css: canvas.clientWidth, height: canvas.height, cssHeight: canvas.clientHeight }
    })
    expect(size.width).toBe(size.css * 2)
    expect(size.height).toBe(size.cssHeight * 2)

    /* a pixel inside the frame's span on the top ruler, and one well outside it */
    const sample = (worldX: number) =>
      page.$eval(
        '[data-ruler="top"]',
        (el, x) => {
          const canvas = el as HTMLCanvasElement
          const left = canvas.getBoundingClientRect().left
          const px = Math.round((x - left) * 2)
          return Array.from(canvas.getContext('2d')!.getImageData(px, 4, 1, 1).data)
        },
        screen(worldX, 0)[0],
      )
    const before = await sample(140)
    await page.evaluate(() => window.rulersHarness.select(['f']))
    await page.waitForFunction(
      (x, initial) => {
        const canvas = document.querySelector<HTMLCanvasElement>('[data-ruler="top"]')!
        const px = Math.round((x - canvas.getBoundingClientRect().left) * 2)
        const now = Array.from(canvas.getContext('2d')!.getImageData(px, 4, 1, 1).data)
        return now.join() !== initial.join()
      },
      {},
      screen(140, 0)[0],
      before,
    )
    expect(await sample(600)).toEqual(before)
    await page.evaluate(() => window.rulersHarness.select([]))
  })

  it('drags a guide out of the ruler, showing its position, and saves it', async () => {
    const at = screen(300, 360)
    await page.mouse.move(10, at[1])
    await page.mouse.down()
    await page.mouse.move(...at, { steps: 6 })
    expect(await page.$eval('[data-guide-position]', (el) => el.textContent)).toBe('X 300')
    await page.mouse.up()
    await page.waitForSelector('[data-guide][data-axis="v"]')
    await expect.poll(lastGuideRequest).toMatchObject({ method: 'PUT', body: { pageId: 'first', axis: 'v', at: 300 } })
    expect(await page.$('[data-guide-position]')).toBeNull()
    expect((await state()).guides).toEqual([{ id: expect.any(String), pageId: 'first', axis: 'v', at: 300 }])
  })

  it('snaps a moved frame onto the guide, and Alt moves it freely', async () => {
    /* the title sits just above the frame; 46px right puts the right edge at
       296, inside the snap distance of the guide at 300 */
    const title = screen(70, 40)
    await drag(title, [title[0] + 46, title[1]])
    await expect.poll(() => frame.x).toBe(100)
    expect((await state()).frames[0]!.x).toBe(100)
    expect(await page.$$('[data-guide]')).toHaveLength(1)

    /* 6px left leaves the right edge within reach of the guide: only Alt
       keeps it there */
    const moved = screen(120, 40)
    await drag(moved, [moved[0] - 6, moved[1]], { alt: true })
    await expect.poll(() => frame.x).toBe(94)
    const snapBack = screen(114, 40)
    await drag(snapBack, [snapBack[0] + 5, snapBack[1]])
    await expect.poll(() => frame.x).toBe(100)
  })

  it('moves a guide, undoes it, and removes it by dropping it on its ruler', async () => {
    const id = (await state()).guides[0]!.id
    await drag(screen(300, 460), screen(350, 460))
    await expect.poll(lastGuideRequest).toMatchObject({ method: 'PUT', id, body: { at: 350 } })
    expect((await state()).guides[0]!.at).toBe(350)

    await page.evaluate(() => window.rulersHarness.undo())
    await expect.poll(lastGuideRequest).toMatchObject({ method: 'PUT', id, body: { at: 300 } })
    expect((await state()).guides[0]!.at).toBe(300)

    await drag(screen(300, 460), [8, screen(0, 460)[1]])
    await expect.poll(lastGuideRequest).toMatchObject({ method: 'DELETE', id })
    await page.waitForFunction(() => !document.querySelector('[data-guide]'))

    await page.evaluate(() => window.rulersHarness.undo())
    await expect.poll(lastGuideRequest).toMatchObject({ method: 'PUT', id, body: { at: 300 } })
    await page.waitForSelector('[data-guide]')
  })

  it('selects a guide with a click and deletes it with Delete', async () => {
    const id = (await state()).guides[0]!.id
    await page.mouse.click(...screen(300, 460))
    await page.waitForSelector('[data-guide][data-selected]')
    expect((await state()).selectedGuideId).toBe(id)
    await page.keyboard.press('Delete')
    await expect.poll(lastGuideRequest).toMatchObject({ method: 'DELETE', id })
    await page.waitForFunction(() => !document.querySelector('[data-guide]'))
    /* the frame was not taken along with it */
    expect((await state()).frames).toHaveLength(1)
  })

  it('lets go of a guide once it is hidden, so Delete leaves it alone', async () => {
    const at = screen(300, 360)
    await drag([10, at[1]], at)
    await page.waitForSelector('[data-guide]')
    await page.mouse.click(...screen(300, 460))
    await page.waitForSelector('[data-guide][data-selected]')
    await toggleRulers()
    await page.waitForFunction(() => !document.querySelector('[data-guide]'))
    expect((await state()).selectedGuideId).toBeNull()
    const sent = guideRequests.length
    await page.keyboard.press('Delete')
    await toggleRulers()
    await page.waitForSelector('[data-guide]')
    expect(guideRequests).toHaveLength(sent)
    expect((await state()).guides).toHaveLength(1)
  })

  it('hides the rulers and the guides together on a phone-width layout', async () => {
    await page.setViewport({ width: 600, height: 800 })
    await page.waitForFunction(() => !document.querySelector('[data-ruler]'))
    /* no guide is drawn where none snaps */
    expect(await page.$('[data-guide]')).toBeNull()
    await page.setViewport({ width: 1200, height: 800 })
    await page.waitForSelector('[data-ruler="top"]')
    await page.waitForSelector('[data-guide]')
  })
})
