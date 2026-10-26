import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import type { Canvas, ElementComment, Frame } from '../shared/types'

declare global {
  interface Window {
    drawingHarness: {
      seed: (canvas: Canvas) => void
      comments: (comments: ElementComment[]) => void
      viewport: (viewport: { x: number; y: number; zoom: number }) => void
      camera: () => { x: number; y: number; zoom: number }
      peer: (cursor: { x: number; y: number }) => void
      page: (id: string) => void
      selectFrames: (ids: string[]) => void
      state: () => {
        frames: Frame[]
        tool: string
        selectedIds: string[]
        selectedElement: { frameId: string; selector: string } | null
      }
      undo: () => Promise<void>
      redo: () => Promise<void>
      pick: (el: { frameId: string; selector: string } | null) => void
    }
    delayedLayerProbe: MessageEvent | null
  }
}

describe.skipIf(!findBrowserPath())('drawing on the canvas', { timeout: 30_000 }, () => {
  let vite: ViteDevServer
  let browser: Browser
  let page: Page
  let saved: Frame[] = []
  let nextId = 0
  let patchRequests = 0
  const errors: string[] = []

  beforeAll(async () => {
    vite = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await vite.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', (err) => errors.push(String(err)))
    await page.setRequestInterception(true)
    page.on('request', async (req) => {
      const path = new URL(req.url()).pathname
      if (path === '/api/canvases/c/frames' && req.method() === 'POST') {
        const frame = {
          ...JSON.parse(req.postData()!),
          id: `drawn-${++nextId}`,
          canvasId: 'c',
          createdAt: 0,
          updatedAt: 0,
        }
        saved.push(frame)
        await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(frame) })
      } else if (path.startsWith('/api/frames/') && req.method() === 'PATCH') {
        patchRequests++
        const id = path.split('/').at(-1)
        const frame = { ...saved.find((f) => f.id === id), ...JSON.parse(req.postData()!) }
        saved = saved.map((f) => (f.id === id ? frame : f))
        await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(frame) })
      } else if (path.startsWith('/api/frames/') && req.method() === 'DELETE') {
        saved = saved.filter((f) => f.id !== path.split('/').at(-1))
        await req.respond({ status: 200, contentType: 'application/json', body: '{}' })
      } else await req.continue()
    })
  }, 60_000)

  beforeEach(async () => {
    await page.mouse.reset()
    await page.keyboard.up('Shift')
    saved = []
    nextId = 0
    patchRequests = 0
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(`${vite.resolvedUrls!.local[0]}tests/fixtures/drawing.html`)
    await page.waitForFunction(() => !!window.drawingHarness)
    await page.evaluate(() =>
      window.drawingHarness.seed({
        id: 'c',
        name: 'Draw',
        frames: [],
        pages: [
          { id: 'first', name: 'Main' },
          { id: 'second', name: 'Other' },
        ],
        createdAt: 0,
        updatedAt: 0,
      }),
    )
    await page.waitForSelector('[aria-label="Canvas tools"]')
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 2 }))
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
    expect(errors).toEqual([])
  })

  async function drag(from: [number, number], to: [number, number]) {
    await page.mouse.move(...from)
    await page.mouse.down()
    await page.mouse.move(...to, { steps: 5 })
    await page.mouse.up()
  }
  async function waitForFrames(count: number) {
    await page.waitForFunction((n) => window.drawingHarness.state().frames.length === n, {}, count)
    return page.evaluate(() => window.drawingHarness.state().frames)
  }

  async function seedFrames(frames: Frame[]) {
    saved = frames
    await page.evaluate(
      (frames) =>
        window.drawingHarness.seed({
          id: 'c',
          name: 'Draw',
          frames,
          pages: [
            { id: 'first', name: 'Main' },
            { id: 'second', name: 'Other' },
          ],
          createdAt: 0,
          updatedAt: 0,
        }),
      frames,
    )
  }

  async function visibleDrawing(title: string, selector = '[data-doop-drawing]') {
    const handle = await page.waitForSelector(`iframe[title="${title}"]`)
    const iframe = (await handle!.contentFrame())!
    await iframe.waitForSelector(selector)
    const readOuter = () =>
      handle!.evaluate((el) => {
        const box = el.getBoundingClientRect()
        const css = getComputedStyle(el)
        /* the iframe undoes the world's layout zoom, so its CSS width is the
           design width and the box over it is the canvas zoom */
        return { x: box.x, y: box.y, scale: box.width / Number.parseFloat(css.width) }
      })
    let result: { x: number; y: number; width: number; height: number } | null = null
    // The inner rect is in design px whatever the layout zoom; only a viewport
    // still moving between the two reads could mix two states.
    await expect
      .poll(
        async () => {
          const outer = await readOuter()
          const inner = await iframe.$eval(selector, (el) => {
            const box = el.getBoundingClientRect()
            return { x: box.x, y: box.y, width: box.width, height: box.height }
          })
          const after = await readOuter()
          if ((['x', 'y', 'scale'] as const).some((key) => outer[key] !== after[key])) return false
          result = {
            x: outer.x + inner.x * outer.scale,
            y: outer.y + inner.y * outer.scale,
            width: inner.width * outer.scale,
            height: inner.height * outer.scale,
          }
          return true
        },
        { timeout: 10_000 },
      )
      .toBe(true)
    return result!
  }

  it('draws a frame with reverse drag at a panned/zoomed viewport, then adds editable shapes inside it', async () => {
    await page.click('[aria-label="Frame"]')
    await drag([700, 500], [200, 200])
    const [frame] = await waitForFrames(1)
    expect(frame).toMatchObject({ name: 'Frame', x: 80, y: 70, width: 250, height: 150, pageId: 'first' })
    await page.keyboard.press('r')
    await drag([240, 240], [400, 320])
    await page.waitForFunction(() =>
      window.drawingHarness.state().frames[0]?.html.includes('data-doop-drawing="rectangle"'),
    )
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ x: 80, y: 70, width: 250, height: 150 })
    await page.keyboard.press('o')
    await drag([460, 240], [540, 280])
    await page.waitForFunction(() =>
      window.drawingHarness.state().frames[0]?.html.includes('data-doop-drawing="circle"'),
    )
    const iframe = await (await page.$('iframe'))!.contentFrame()
    await iframe!.waitForSelector('[data-doop-drawing="circle"]')
    expect(
      await iframe!.$eval('[data-doop-drawing="circle"]', (el) => ({
        width: getComputedStyle(el).width,
        height: getComputedStyle(el).height,
      })),
    ).toEqual({ width: '40px', height: '40px' })
    await page.evaluate(() => window.drawingHarness.undo())
    expect(saved[0]!.html).not.toContain('data-doop-drawing="circle"')
    expect(saved[0]!.html).toContain('data-doop-drawing="rectangle"')
    await page.evaluate(() => window.drawingHarness.redo())
    expect(saved[0]!.html).toContain('data-doop-drawing="circle"')
  })

  it('creates standalone transparent circles, constrained rectangles and SVG paths', async () => {
    await page.click('[aria-label="Circle"]')
    await drag([220, 200], [320, 260])
    expect((await waitForFrames(1))[0]).toMatchObject({ width: 50, height: 50 })
    expect(await page.$eval('iframe', (el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await page.keyboard.press('r')
    await page.keyboard.down('Shift')
    await drag([450, 200], [600, 270])
    await page.keyboard.up('Shift')
    expect((await waitForFrames(2))[1]).toMatchObject({ width: 75, height: 75 })
    await page.click('[aria-label="Vector path"]')
    await page.mouse.click(220, 420)
    await page.mouse.click(320, 380)
    await page.mouse.click(420, 450)
    await page.keyboard.press('Enter')
    expect((await waitForFrames(3))[2]!.html).toContain('M 2 22 L 52 2 L 102 37')
    await page.keyboard.press('p')
    await page.mouse.click(600, 420)
    await page.mouse.click(700, 420)
    await page.mouse.click(700, 520)
    await page.mouse.click(600, 420)
    expect((await waitForFrames(4))[3]!.html).toContain(' Z"')
    await page.keyboard.press('p')
    await page.mouse.click(800, 420)
    await page.mouse.click(900, 500, { count: 2, delay: 60 })
    expect((await waitForFrames(5))[4]!.html).toContain('M 2 2 L 52 42')
    await page.screenshot({ path: '/tmp/doop-drawing-desktop.png' })
  })

  it('types literal multiline text without triggering shortcuts, and cancels empty or escaped drafts', async () => {
    await page.keyboard.press('t')
    await page.mouse.click(220, 200)
    await page.waitForSelector('textarea[data-drawing-input]')
    await page.keyboard.type('<b>Rectangle & circle</b>')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Second line')
    expect(await page.evaluate(() => window.drawingHarness.state().tool)).toBe('text')
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    const [frame] = await waitForFrames(1)
    expect(frame!.html).toContain('&lt;b&gt;Rectangle &amp; circle&lt;/b&gt;\nSecond line')
    await page.keyboard.press('t')
    await page.mouse.click(800, 400)
    await page.keyboard.type('discard me')
    await page.keyboard.press('Escape')
    expect(await page.$('textarea[data-drawing-input]')).toBeNull()
    expect(saved).toHaveLength(1)
    await page.keyboard.press('t')
    await page.mouse.click(800, 400)
    await page.mouse.click(800, 500)
    expect(await page.$('textarea[data-drawing-input]')).toBeNull()
    expect(saved).toHaveLength(1)
  })

  it('draws smooth Bézier curves by dragging anchors, including a curved closed path', async () => {
    await page.click('[aria-label="Vector path"]')
    await drag([220, 300], [220, 180])
    await drag([520, 300], [520, 420])
    await page.keyboard.press('Enter')
    const [curve] = await waitForFrames(1)
    expect(curve).toMatchObject({ x: 88, y: 73, width: 154, height: 49 })
    expect(curve!.html).toContain('M 2 47 C 2 -13 152 -13 152 47')
    await page.keyboard.press('p')
    await drag([650, 300], [700, 220])
    await page.mouse.click(850, 300)
    await drag([850, 500], [800, 540])
    await drag([650, 300], [620, 230])
    const closed = (await waitForFrames(2))[1]!
    expect(closed.html.match(/ C /g)).toHaveLength(3)
    expect(closed.html).toContain(' Z"')
    await page.screenshot({ path: '/tmp/doop-canvas-curves.png' })
    await page.evaluate(() => window.drawingHarness.undo())
    await waitForFrames(1)
    await page.evaluate(() => window.drawingHarness.redo())
    expect((await waitForFrames(2))[1]!.html).toBe(closed.html)
  })

  it('drags a circle into a frame, into another frame, and back onto the canvas with undo/redo', async () => {
    await page.click('[aria-label="Frame"]')
    await drag([200, 200], [500, 500])
    await waitForFrames(1)
    await page.keyboard.press('f')
    await drag([650, 200], [950, 500])
    await waitForFrames(2)
    await page.keyboard.press('o')
    await drag([250, 570], [330, 650])
    await waitForFrames(3)
    await page.mouse.move(290, 610)
    await page.mouse.down()
    await page.mouse.move(350, 360, { steps: 5 })
    await page.waitForSelector('[data-drawing-drop-target="drawn-1"]')
    await page.screenshot({ path: '/tmp/doop-canvas-drop.png' })
    await page.mouse.up()
    const inserted = await waitForFrames(2)
    expect(inserted[0]!.html).toContain('data-doop-drawing="circle"')
    expect(inserted[0]!.html).toContain('left: 55px; top: 60px; width: 40px; height: 40px;')
    await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.frameId === 'drawn-1')
    await page.waitForSelector('[data-comment-ui] button')
    // Deselect first: a shape can be grabbed directly, not only after a prior pick.
    await page.mouse.click(1100, 550)
    await drag([350, 360], [750, 360])
    await page.waitForFunction(() =>
      window.drawingHarness.state().frames[1]?.html.includes('data-doop-drawing="circle"'),
    )
    expect(saved[0]!.html).not.toContain('data-doop-drawing')
    await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.frameId === 'drawn-2')
    await page.waitForSelector('[data-comment-ui] button')
    await page.mouse.click(1100, 550)
    await drag([750, 360], [500, 600])
    const outside = (await waitForFrames(3))[2]!
    expect(outside).toMatchObject({ x: 210, y: 250, width: 40, height: 40, name: 'Circle' })
    expect(saved[1]!.html).not.toContain('data-doop-drawing')
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.drawingHarness.undo())
    const restored = await waitForFrames(3)
    expect(restored[2]).toMatchObject({ x: 105, y: 255, width: 40, height: 40 })
    expect(restored.slice(0, 2).every((f) => !f.html.includes('data-doop-drawing'))).toBe(true)
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.drawingHarness.redo())
    expect((await waitForFrames(3))[2]).toMatchObject({ x: 210, y: 250, width: 40, height: 40 })
  })

  it.each([0.5, 2, 3])('snaps the path preview and closes at the first anchor at zoom %s', async (zoom) => {
    await page.evaluate((zoom) => window.drawingHarness.viewport({ x: 40, y: 20, zoom }), zoom)
    await page.click('[aria-label="Vector path"]')
    await page.mouse.click(220, 250)
    await page.mouse.click(420, 250)
    await page.mouse.click(420, 450)
    await page.mouse.move(226, 250)
    await page.waitForSelector('[data-path-snap="close"]')
    expect(await page.$eval('[data-path-snap]', (el) => el.getBoundingClientRect().width)).toBeCloseTo(14, 1)
    expect(await page.$eval('[data-path-preview] path', (el) => el.getAttribute('d'))).toMatch(/Z$/)
    await page.mouse.move(230, 250)
    expect(await page.$('[data-path-snap]')).toBeNull()
    await page.mouse.click(226, 250)
    const [path] = await waitForFrames(1)
    expect(path!.html).toContain(' Z"')
    expect(await page.$('[data-path-preview]')).toBeNull()
  })

  it('snaps to intermediate anchors and lets Alt place a point freely', async () => {
    await page.click('[aria-label="Vector path"]')
    await page.mouse.click(220, 250)
    await page.mouse.click(420, 250)
    await page.mouse.click(420, 450)
    await page.mouse.move(426, 250)
    await page.waitForSelector('[data-path-anchor="1"][data-snapped="true"]')
    await page.mouse.click(426, 250)
    await page.keyboard.down('Alt')
    await page.mouse.move(226, 250)
    expect(await page.$('[data-path-snap]')).toBeNull()
    await page.mouse.click(226, 250)
    await page.keyboard.up('Alt')
    await page.keyboard.press('Enter')
    expect((await waitForFrames(1))[0]!.html).toContain('M 2 2 L 102 2 L 102 102 L 102 2 L 5 2')
  })

  async function editorPoint(index: number, handle?: string) {
    const selector = handle ? `[data-path-handle="${index}-${handle}"]` : `[data-path-edit-anchor="${index}"]`
    await page.waitForSelector(selector)
    return page.$eval(selector, (el) => {
      const rect = el.getBoundingClientRect()
      return [rect.x + rect.width / 2, rect.y + rect.height / 2] as [number, number]
    })
  }

  async function waitForPathSave(before: string) {
    await page.waitForFunction(
      (before) =>
        window.drawingHarness
          .state()
          .frames.map((f) => f.html)
          .join() !== before,
      {},
      before,
    )
    await page.waitForFunction(() => !document.querySelector('[data-path-editor] button:disabled'))
  }

  it('edits anchors and handles, converts curves, deletes points, and undoes each change', async () => {
    await page.click('[aria-label="Vector path"]')
    await drag([220, 300], [220, 220])
    await drag([420, 300], [420, 380])
    await page.mouse.click(420, 450)
    await page.keyboard.press('Enter')
    await waitForFrames(1)
    await visibleDrawing('Vector path')
    await page.mouse.click(320, 300, { count: 2, delay: 60 })
    const original = saved[0]!
    const first = await editorPoint(0)
    await drag(first, [first[0] - 60, first[1] + 30])
    await waitForPathSave(original.html)
    const moved = await editorPoint(0)
    expect(moved[0]).toBeCloseTo(first[0] - 60, 1)
    expect(moved[1]).toBeCloseTo(first[1] + 30, 1)
    await page.evaluate(() => window.drawingHarness.undo())
    await page.waitForFunction(() => !document.body.textContent?.includes('Saving path…'))
    await page.waitForFunction(
      (x) => Math.abs(document.querySelector('[data-path-edit-anchor="0"]')!.getBoundingClientRect().x + 9 - x) < 0.1,
      {},
      first[0],
    )
    await page.evaluate(() => window.drawingHarness.redo())
    await page.waitForFunction(
      (x) => Math.abs(document.querySelector('[data-path-edit-anchor="0"]')!.getBoundingClientRect().x + 9 - x) < 0.1,
      {},
      moved[0],
    )
    let before = saved.map((f) => f.html).join()
    const handle = await editorPoint(0, 'handleOut')
    await drag(handle, [handle[0] + 40, handle[1] + 20])
    await waitForPathSave(before)
    before = saved.map((f) => f.html).join()
    await page.click('[data-path-editor] button', { count: 1 })
    await waitForPathSave(before)
    expect(await page.$('[data-path-handle="0-handleOut"]')).toBeNull()
    await page.click('[data-path-editor] button')
    await page.waitForSelector('[data-path-handle="0-handleOut"]')
    await page.waitForFunction(() => !document.body.textContent?.includes('Saving path…'))
    await page.screenshot({ path: '/tmp/doop-path-editing.png' })
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => document.querySelectorAll('[data-path-edit-anchor]').length === 2)
    await page.evaluate(() => window.drawingHarness.undo())
    await page.waitForFunction(() => document.querySelectorAll('[data-path-edit-anchor]').length === 3)
    await page.keyboard.press('Escape')
    expect(await page.$('[data-path-editor]')).toBeNull()
    expect(saved[0]!.html).not.toContain('data-v-path-hidden')
  })

  it('selects asymmetric handles and anchors without changing the path or saving', async () => {
    await page.click('[aria-label="Vector path"]')
    await drag([220, 300], [220, 220])
    await drag([420, 300], [420, 380])
    await page.mouse.click(560, 450)
    await page.keyboard.press('Enter')
    await waitForFrames(1)
    await visibleDrawing('Vector path')
    await page.mouse.click(320, 300, { count: 2, delay: 60 })
    const opposite = await editorPoint(1, 'handleIn')
    const handle = await editorPoint(1, 'handleOut')
    const original = saved[0]!.html
    await page.keyboard.down('Alt')
    await drag(handle, [handle[0] + 40, handle[1] + 20])
    await page.keyboard.up('Alt')
    await waitForPathSave(original)
    const incoming = await editorPoint(1, 'handleIn')
    expect(incoming[0]).toBeCloseTo(opposite[0], 1)
    expect(incoming[1]).toBeCloseTo(opposite[1], 1)
    const before = saved[0]!.html
    const requests = patchRequests
    const preview = await page.$eval('[data-path-editor] path', (el) => el.getAttribute('d'))
    await page.mouse.click(...incoming)
    await page.mouse.click(...(await editorPoint(1, 'handleOut')))
    await page.mouse.click(...(await editorPoint(1)))
    expect(await page.$eval('[data-path-editor] path', (el) => el.getAttribute('d'))).toBe(preview)
    await page.keyboard.press('Enter')
    expect(await page.$('[data-path-editor]')).toBeNull()
    expect(saved[0]!.html).toBe(before)
    expect(patchRequests).toBe(requests)
  })

  it.each([false, true])(
    'edits transformed paths without moving their other endpoint (standalone: %s)',
    async (standalone) => {
      const frame: Frame = {
        id: 'curve',
        updatedBy: 'User',
        canvasId: 'c',
        pageId: 'first',
        name: 'Curve frame',
        x: 30,
        y: 30,
        width: 400,
        height: 300,
        createdAt: 0,
        updatedAt: 0,
        html: '<svg id="pen" data-doop-drawing="path" viewBox="0 0 140 100" style="position:fixed;left:60px;top:60px;width:140px;height:100px;transform:rotate(20deg) scale(1.2)"><path d="M 10 50 C 30 0 80 100 120 50" stroke="black" fill="none" stroke-width="2" /></svg>',
      }
      if (standalone) frame.html = `<body data-doop-canvas-element="true">${frame.html}</body>`
      await seedFrames([frame])
      const rect = await visibleDrawing('Curve frame')
      await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { count: 2, delay: 60 })
      const first = await editorPoint(0)
      const last = await editorPoint(1)
      await page.mouse.move(...first)
      await page.mouse.down()
      await page.mouse.move(first[0] - 30, first[1] + 40, { steps: 5 })
      await page.keyboard.press('Escape')
      await page.mouse.up()
      expect(saved[0]!.html).toBe(frame.html)
      expect(await editorPoint(0)).toEqual(first)
      await drag(first, [first[0] - 30, first[1] + 40])
      await page.waitForFunction((before) => window.drawingHarness.state().frames[0]!.html !== before, {}, frame.html)
      await page.waitForFunction(() => !document.body.textContent?.includes('Saving path…'))
      if (!standalone) expect(saved[0]).toMatchObject({ x: 30, y: 30, width: 400, height: 300 })
      const after = await editorPoint(1)
      expect(after[0]).toBeCloseTo(last[0], 1)
      expect(after[1]).toBeCloseTo(last[1], 1)
      await page.keyboard.press('Escape')
    },
  )

  it('keeps a Layers pick when a save refreshes the element being text-edited', async () => {
    await seedFrames([
      {
        id: 'copy',
        updatedBy: 'User',
        canvasId: 'c',
        pageId: 'first',
        name: 'Copy',
        x: 30,
        y: 30,
        width: 400,
        height: 300,
        createdAt: 0,
        updatedAt: 0,
        html: '<p id="a">Alpha</p><p id="b">Beta</p>',
      },
    ])
    const handle = await page.waitForSelector('iframe[title="Copy"]')
    const iframe = (await handle!.contentFrame())!
    await iframe.waitForSelector('#b')
    /* the runtime reports the element being text-edited when editing starts,
       and again after every save while it stays active */
    const reportActive = () =>
      iframe.evaluate(() =>
        parent.postMessage(
          {
            type: 'doop:active',
            hit: { selector: '#a', tag: 'p', text: 'Alpha', snippet: '', rect: { x: 0, y: 0, width: 100, height: 20 } },
          },
          '*',
        ),
      )
    await reportActive()
    await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.selector === '#a')
    const beta = { frameId: 'copy', selector: '#b' }
    await page.evaluate((el) => window.drawingHarness.pick(el), beta)
    /* let the frame resolve the pick into its outline before the save lands */
    await new Promise((r) => setTimeout(r, 300))
    await reportActive()
    await new Promise((r) => setTimeout(r, 200))
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement)).toEqual(beta)
  })

  it('snaps edited anchors, allows Alt to bypass snapping, and cancels on pointer cancellation', async () => {
    await page.click('[aria-label="Vector path"]')
    await page.mouse.click(220, 300)
    await page.mouse.click(420, 300)
    await page.mouse.click(420, 450)
    await page.keyboard.press('Enter')
    await waitForFrames(1)
    await visibleDrawing('Vector path')
    await page.mouse.click(320, 350, { count: 2, delay: 60 })
    const first = await editorPoint(0)
    const target = await editorPoint(1)
    await page.mouse.move(...first)
    await page.mouse.down()
    await page.mouse.move(target[0] + 6, target[1], { steps: 5 })
    await page.waitForSelector('[data-path-edit-snap]')
    expect(await editorPoint(0)).toEqual(target)
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })))
    await page.mouse.up()
    expect(await editorPoint(0)).toEqual(first)
    const before = saved[0]!.html
    await page.keyboard.down('Alt')
    await drag(first, [target[0] + 6, target[1]])
    await page.keyboard.up('Alt')
    await waitForPathSave(before)
    expect((await editorPoint(0))[0]).toBeCloseTo(target[0] + 6, 1)
    await page.evaluate(() => window.drawingHarness.page('second'))
    expect(await page.$('[data-path-editor]')).toBeNull()
  })

  it('cancels interrupted gestures and lets Space pan without drawing', async () => {
    await page.keyboard.press('r')
    await page.mouse.move(220, 200)
    await page.mouse.down()
    await page.mouse.move(320, 300)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.keyboard.press('r')
    await page.mouse.down()
    await page.mouse.move(420, 400)
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })))
    await page.mouse.up()
    await page.keyboard.down('Space')
    await drag([220, 200], [320, 300])
    await page.keyboard.up('Space')
    expect(saved).toHaveLength(0)
    await page.mouse.down()
    await page.mouse.move(420, 400)
    await page.evaluate(() => window.drawingHarness.page('second'))
    await page.mouse.up()
    expect(saved).toHaveLength(0)
    await page.mouse.click(400, 300)
    expect((await waitForFrames(1))[0]!.pageId).toBe('second')
  })

  it('leaves editing keys in unrelated fields alone while a vector path is unfinished', async () => {
    await page.click('[aria-label="Vector path"]')
    await page.mouse.click(220, 200)
    await page.mouse.click(320, 280)
    for (const kind of ['input', 'textarea', 'contenteditable']) {
      await page.evaluate((kind) => {
        document.querySelector('#outside-field')?.remove()
        const field = document.createElement(kind === 'contenteditable' ? 'div' : kind)
        field.id = 'outside-field'
        field.style.cssText = 'position:fixed;top:0;left:0;width:200px;height:30px;z-index:100;background:white;'
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = 'AB'
        else {
          field.contentEditable = 'true'
          field.textContent = 'AB'
        }
        field.addEventListener('keydown', (event) => {
          field.dataset.keys = `${field.dataset.keys ?? ''}${event.key},`
        })
        document.body.append(field)
        field.focus()
      }, kind)
      await page.keyboard.press('End')
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Home')
      await page.keyboard.press('Delete')
      expect(
        await page.$eval('#outside-field', (field) =>
          field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : field.textContent,
        ),
      ).toBe('')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Escape')
      expect(await page.$eval('#outside-field', (field) => field.getAttribute('data-keys'))).toContain(
        'Backspace,Home,Delete,Enter,Escape,',
      )
      expect(await page.evaluate(() => window.drawingHarness.state().tool)).toBe('path')
      expect(saved).toHaveLength(0)
    }
    await page.evaluate(() => document.querySelector('#outside-field')?.remove())
    await page.keyboard.press('Enter')
    const [path] = await waitForFrames(1)
    expect(path!.html).toContain('M 2 2 L 52 42')
  })

  it('cancels moving an element on Escape, pointer cancellation, and page changes', async () => {
    await page.click('[aria-label="Circle"]')
    await drag([250, 300], [330, 380])
    const [original] = await waitForFrames(1)
    for (const reason of ['escape', 'pointer', 'page']) {
      await page.mouse.move(290, 340)
      await page.mouse.down()
      await page.mouse.move(700, 300, { steps: 4 })
      await page.waitForSelector('iframe[title="Moving drawing"]')
      if (reason === 'escape') await page.keyboard.press('Escape')
      else if (reason === 'pointer')
        await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })))
      else await page.evaluate(() => window.drawingHarness.page('second'))
      await page.mouse.up()
      expect(await page.$('iframe[title="Moving drawing"]')).toBeNull()
      expect(saved).toEqual([original])
    }
  })

  const layerFrame = (body: string): Frame => ({
    id: 'layers',
    canvasId: 'c',
    pageId: 'first',
    name: 'Layers',
    x: 70,
    y: 50,
    width: 700,
    height: 500,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'User',
    html: `<!doctype html><html><head><style>body { margin: 0 }</style></head><body>${body}</body></html>`,
  })
  const rectangle =
    '<div id="rect" style="position:absolute;left:50px;top:60px;width:100px;height:80px;background:coral"></div>'

  it.each(['none', 'frame', 'multiple'])(
    'constrains a layer drag with Shift held before pressing (selection: %s)',
    async (selection) => {
      const source = layerFrame(rectangle)
      const other = { ...source, id: 'other', name: 'Other', x: 850 }
      await seedFrames([source, other])
      await page.evaluate((selection) => {
        window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 })
        window.drawingHarness.selectFrames(
          selection === 'none' ? [] : selection === 'frame' ? ['layers'] : ['other', 'layers'],
        )
      }, selection)
      const before = await visibleDrawing('Layers', '#rect')
      await page.keyboard.down('Shift')
      await drag([before.x + 40, before.y + 40], [before.x + 100, before.y + 60])
      await page.keyboard.up('Shift')
      await expect.poll(() => saved[0]?.html).not.toBe(source.html)
      const after = await visibleDrawing('Layers', '#rect')
      expect(after.x - before.x).toBeCloseTo(60, 0)
      expect(after.y).toBeCloseTo(before.y, 0)
      expect(saved[0]).toMatchObject({ x: source.x, y: source.y })
      expect(saved[1]).toEqual(other)
      expect(await page.evaluate(() => window.drawingHarness.state().selectedElement?.selector)).toBe('#rect')
    },
  )

  it('keeps Shift-click frame selection without moving or prematurely selecting its layer', async () => {
    const source = layerFrame(rectangle)
    const other = { ...source, id: 'other', name: 'Other', x: 850 }
    await seedFrames([source, other])
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 })
      window.drawingHarness.selectFrames(['other'])
    })
    const rect = await visibleDrawing('Layers', '#rect')
    await page.keyboard.down('Shift')
    await page.mouse.move(rect.x + 40, rect.y + 40)
    await page.mouse.down()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(await page.evaluate(() => window.drawingHarness.state().selectedIds)).toEqual(['other'])
    await page.mouse.up()
    await page.waitForFunction(() => window.drawingHarness.state().selectedIds.includes('layers'))
    expect(await page.evaluate(() => window.drawingHarness.state().selectedIds)).toEqual(['other', 'layers'])
    await page.mouse.click(rect.x + 40, rect.y + 40)
    await page.keyboard.up('Shift')
    await page.waitForFunction(() => !window.drawingHarness.state().selectedIds.includes('layers'))
    expect(await page.evaluate(() => window.drawingHarness.state().selectedIds)).toEqual(['other'])
    expect(saved).toMatchObject([source, other])
  })

  it.each(['svg', 'drawing'])('constrains a %s vertically when Shift is held before the drag', async (kind) => {
    const content =
      kind === 'svg'
        ? '<svg id="rect" style="position:absolute;left:50px;top:60px" width="100" height="80"><rect width="100" height="80" fill="coral"/></svg>'
        : rectangle.replace('id="rect"', 'id="rect" data-doop-drawing="rectangle"')
    const source = layerFrame(content)
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const before = await visibleDrawing('Layers', '#rect')
    await page.keyboard.down('Shift')
    await drag([before.x + 40, before.y + 40], [before.x + 60, before.y + 100])
    await page.keyboard.up('Shift')
    await expect.poll(() => saved[0]?.html).not.toBe(source.html)
    await expect.poll(async () => (await visibleDrawing('Layers', '#rect')).y).toBeCloseTo(before.y + 60, 0)
    const after = await visibleDrawing('Layers', '#rect')
    expect(after.x).toBeCloseTo(before.x, 0)
    expect(after.y - before.y).toBeCloseTo(60, 0)
    expect(saved[0]).toMatchObject({ x: source.x, y: source.y })
  })

  it.each(['timer', 'reply'])('keeps the drag selection when an earlier click has a pending %s', async (pending) => {
    const source = layerFrame(
      rectangle + rectangle.replace('id="rect"', 'id="second"').replace('left:50px', 'left:250px'),
    )
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const first = await visibleDrawing('Layers', '#rect')
    const second = await visibleDrawing('Layers', '#second')
    // Start with a settled selection so no initial locate response can cancel
    // the next click's probe before this test controls its delivery.
    await page.mouse.click(first.x + 40, first.y + 40)
    await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.selector === '#rect')
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 350)))
    await page.evaluate(() => {
      window.delayedLayerProbe = null
      window.addEventListener(
        'message',
        function hold(event) {
          if (event.data?.type !== 'doop:probe-result' || event.data.hit?.selector !== '#rect') return
          window.removeEventListener('message', hold, true)
          window.delayedLayerProbe = event
          event.stopImmediatePropagation()
        },
        true,
      )
    })
    await page.mouse.click(first.x + 40, first.y + 40)
    if (pending === 'reply') await page.waitForFunction(() => !!window.delayedLayerProbe)
    await page.mouse.move(second.x + 40, second.y + 40)
    await page.mouse.down()
    await page.mouse.move(second.x + 100, second.y + 60, { steps: 3 })
    await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.selector === '#second')
    await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
      const event = window.delayedLayerProbe
      if (event) window.dispatchEvent(new MessageEvent('message', { data: event.data, source: event.source }))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement?.selector)).toBe('#second')
    if (pending === 'timer') expect(await page.evaluate(() => !!window.delayedLayerProbe)).toBe(false)
    await page.mouse.up()
    await expect.poll(() => saved[0]?.html).not.toBe(source.html)
    await expect.poll(async () => (await visibleDrawing('Layers', '#second')).x).toBeCloseTo(second.x + 60, 0)
    const outline = await page.$eval('[data-resize-handles]', (el) => el.getBoundingClientRect().toJSON() as DOMRect)
    expect(outline.x).toBeCloseTo(second.x + 60, 0)
  })

  it.each([0.5, 1, 2])('drags an HTML rectangle directly at zoom %s, saving once with undo/redo', async (zoom) => {
    const source = layerFrame(rectangle + '<p id="sibling" style="margin:0">Keep me</p>')
    await seedFrames([source])
    await page.evaluate((zoom) => window.drawingHarness.viewport({ x: 40, y: 20, zoom }), zoom)
    const before = await visibleDrawing('Layers', '#rect')
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 25, { steps: 5 })
    await expect.poll(async () => (await visibleDrawing('Layers', '#rect')).x).toBeCloseTo(before.x + 40, 0)
    expect(patchRequests).toBe(0)
    await page.mouse.up()
    await expect.poll(() => patchRequests).toBe(1)
    const moved = await visibleDrawing('Layers', '#rect')
    expect(moved.y).toBeCloseTo(before.y + 25, 0)
    expect(saved[0]).toMatchObject({ x: source.x, y: source.y, width: source.width, height: source.height })
    expect(saved[0]!.html).toContain('<p id="sibling" style="margin:0">Keep me</p>')
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement?.selector)).toBe('#rect')
    if (zoom === 1) await page.screenshot({ path: '/tmp/doop-layer-drag.png' })
    await page.evaluate(() => window.drawingHarness.undo())
    await expect.poll(async () => (await visibleDrawing('Layers', '#rect')).x).toBeCloseTo(before.x, 0)
    await page.evaluate(() => window.drawingHarness.redo())
    await expect.poll(async () => (await visibleDrawing('Layers', '#rect')).x).toBeCloseTo(moved.x, 0)
  })

  it('moves a transformed layer in screen space without changing its transform or siblings', async () => {
    const source =
      layerFrame(`<section style="position:absolute;left:100px;top:80px;transform:rotate(20deg) scale(1.2);transform-origin:0 0">
      <div id="rect" style="width:100px;height:80px;background:coral;transform:rotate(10deg);translate:10px 5px"></div>
      <div id="sibling" style="width:50px;height:40px;background:blue"></div></section>`)
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const before = await visibleDrawing('Layers', '#rect')
    const sibling = await visibleDrawing('Layers', '#sibling')
    await drag(
      [before.x + before.width / 2, before.y + before.height / 2],
      [before.x + before.width / 2 + 60, before.y + before.height / 2 + 35],
    )
    await expect.poll(() => patchRequests).toBe(1)
    const after = await visibleDrawing('Layers', '#rect')
    expect(after.x - before.x).toBeCloseTo(60, 0)
    expect(after.y - before.y).toBeCloseTo(35, 0)
    expect(after.width).toBeCloseTo(before.width, 0)
    expect(await visibleDrawing('Layers', '#sibling')).toEqual(sibling)
    expect(saved[0]!.html).toContain('transform: rotate(10deg)')
  })

  it.each(['escape', 'pointer', 'blur', 'page', 'remote'])(
    'cancels an HTML layer drag on %s without saving',
    async (reason) => {
      const source = layerFrame(rectangle)
      await seedFrames([source])
      await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
      const before = await visibleDrawing('Layers', '#rect')
      await page.mouse.move(before.x + 40, before.y + 40)
      await page.mouse.down()
      await page.mouse.move(before.x + 100, before.y + 70, { steps: 5 })
      await expect.poll(async () => (await visibleDrawing('Layers', '#rect')).x).toBeCloseTo(before.x + 60, 0)
      if (reason === 'escape') await page.keyboard.press('Escape')
      else if (reason === 'pointer')
        await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })))
      else if (reason === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      else if (reason === 'page') await page.evaluate(() => window.drawingHarness.page('second'))
      else await seedFrames([{ ...source, html: source.html.replace('</body>', '<p>Remote edit</p></body>') }])
      await page.mouse.up()
      if (reason === 'page')
        await page.evaluate(() => {
          window.drawingHarness.page('first')
          window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 })
        })
      // Switching pages also fits the viewport; compare the layer in frame pixels.
      await page.waitForSelector('iframe[title="Layers"]')
      const restored = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
      await restored.waitForFunction(() => document.querySelector('#rect')?.getBoundingClientRect().x === 50)
      expect(patchRequests).toBe(0)
      if (reason === 'remote') expect(saved[0]!.html).toContain('Remote edit')
    },
  )

  it.each([false, true])(
    'drags a selected group from its child (drawing: %s) and constrains movement with Shift',
    async (drawing) => {
      const child = drawing ? rectangle.replace('id="rect"', 'id="rect" data-doop-drawing="rectangle"') : rectangle
      const source = layerFrame(
        `<div id="group" style="position:absolute;left:40px;top:40px;width:250px;height:200px;background:#eee">${child}</div>`,
      )
      await seedFrames([source])
      await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
      const group = await visibleDrawing('Layers', '#group')
      await page.mouse.click(group.x + 20, group.y + 20)
      await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.selector === '#group')
      const before = await visibleDrawing('Layers', '#rect')
      await page.mouse.move(before.x + 40, before.y + 40)
      await page.mouse.down()
      await page.keyboard.down('Shift')
      await page.mouse.move(before.x + 110, before.y + 60, { steps: 5 })
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await expect.poll(async () => (await visibleDrawing('Layers', '#group')).x).toBeCloseTo(group.x + 70, 0)
      const after = await visibleDrawing('Layers', '#rect')
      expect(after.x - before.x).toBeCloseTo(70, 0)
      expect(after.y).toBeCloseTo(before.y, 0)
    },
  )

  it.each([
    '<svg id="rect" width="100" height="80"><rect width="100" height="80" fill="coral"/></svg>',
    '<p id="rect" style="width:100px;height:80px;margin:0"><span>Text layer</span></p>',
    '<img id="rect" width="100" height="80" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E">',
  ])('freely drags absolutely positioned SVG, text and image layers: %s', async (content) => {
    await seedFrames([layerFrame('<style>#rect { position: absolute }</style>' + content)])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const before = await visibleDrawing('Layers', '#rect')
    await drag([before.x + 15, before.y + 10], [before.x + 55, before.y + 40])
    await expect.poll(() => patchRequests).toBe(1)
    const after = await visibleDrawing('Layers', '#rect')
    expect(after.x - before.x).toBeCloseTo(40, 0)
    expect(after.y - before.y).toBeCloseTo(30, 0)
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement?.selector)).toBe('#rect')
  })

  const flowImage =
    '<img id="photo" width="80" height="60" style="display:block" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E">'
  const flowBoxes = `<div style="display:flex;align-items:flex-start;gap:40px;padding:20px">
    <div id="from" style="width:160px;padding:20px;background:#eee">${flowImage}</div>
    <div id="into" style="width:160px;padding:20px;background:#ddd"><p style="margin:0;height:30px">Destination</p></div>
  </div>`

  it.each([0.5, 1, 2])(
    'reparents an image with a live insertion bar and growing container at zoom %s',
    async (zoom) => {
      const source = layerFrame(flowBoxes)
      await seedFrames([source])
      await page.evaluate((zoom) => window.drawingHarness.viewport({ x: 0, y: 0, zoom }), zoom)
      const photo = await visibleDrawing('Layers', '#photo')
      const into = await visibleDrawing('Layers', '#into')
      await page.mouse.move(photo.x + photo.width / 2, photo.y + photo.height / 2)
      await page.mouse.down()
      await page.mouse.move(into.x + into.width / 2, into.y + into.height - 15 * zoom, { steps: 5 })
      await page.waitForSelector('[data-element-drop-indicator]')
      expect(patchRequests).toBe(0)
      const indicator = await page.$eval(
        '[data-element-drop-indicator]',
        (el) => el.getBoundingClientRect().toJSON() as DOMRect,
      )
      expect(indicator.height).toBeCloseTo(2, 1)
      expect(indicator.x).toBeCloseTo(into.x, 0)
      if (zoom === 1) await page.screenshot({ path: '/tmp/doop-layout-drop.png' })
      await page.mouse.up()
      await expect.poll(() => patchRequests).toBe(1)
      const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
      await iframe.waitForSelector('#into > img:last-child')
      expect((await visibleDrawing('Layers', '#into')).height - into.height).toBeCloseTo(60 * zoom, 0)
      expect(await page.evaluate(() => window.drawingHarness.state().selectedElement?.selector)).toBe('#photo')
      expect(await iframe.$eval('#photo', (el) => getComputedStyle(el).translate)).toBe('none')
      expect(await page.$('[data-element-drop-indicator]')).toBeNull()
      await page.evaluate(() => window.drawingHarness.undo())
      await iframe.waitForSelector('#from > img')
      expect((await visibleDrawing('Layers', '#into')).height).toBeCloseTo(into.height, 0)
      await page.evaluate(() => window.drawingHarness.redo())
      await iframe.waitForSelector('#into > img')
    },
  )

  it.each([
    ['block', '', false, false],
    ['column', 'display:flex;flex-direction:column;gap:16px', false, false],
    ['row', 'display:flex;gap:16px', true, false],
    ['reverse row', 'display:flex;flex-direction:row-reverse;gap:16px', true, true],
    ['RTL row', 'display:flex;direction:rtl;gap:16px', true, true],
    ['grid', 'display:grid;grid-template-columns:80px 80px;gap:16px', true, false],
    ['wrapped row', 'display:flex;flex-wrap:wrap;gap:16px;width:180px', true, false],
  ] as const)('reorders DOM siblings in a %s layout', async (_name, css, horizontal, reverse) => {
    const source = layerFrame(`<div id="list" style="padding:20px;${css}">
      <div id="one" style="width:80px;height:60px;background:coral;flex-shrink:0">One</div>
      <div id="two" style="width:80px;height:60px;background:skyblue;flex-shrink:0">Two</div>
      <div id="three" style="width:80px;height:60px;background:tan;flex-shrink:0">Three</div>
    </div>`)
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    const one = await visibleDrawing('Layers', '#one')
    const three = await visibleDrawing('Layers', '#three')
    await page.mouse.move(one.x + 30, one.y + 30)
    await page.mouse.down()
    await page.mouse.move(
      horizontal ? three.x + (reverse ? 5 : three.width - 5) : three.x + 30,
      horizontal ? three.y + 30 : three.y + three.height - 5,
      { steps: 5 },
    )
    await page.waitForSelector('[data-element-drop-indicator]')
    await page.mouse.up()
    await expect.poll(() => patchRequests).toBe(1)
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForFunction(() => document.querySelector('#list')?.lastElementChild?.id === 'one')
    expect(await iframe.$$eval('#list > div', (els) => els.map((el) => el.id))).toEqual(['two', 'three', 'one'])
  })

  it('moves an absolutely positioned image into an empty container and puts it in flow', async () => {
    await seedFrames([
      layerFrame(`<style>#photo {position:absolute!important;left:20px;top:20px;translate:10px 5px}</style>
      ${flowImage}<div id="into" style="margin:150px 0 0 250px;padding:20px;width:160px;min-height:20px;background:#ddd"></div>`),
    ])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    const photo = await visibleDrawing('Layers', '#photo')
    const into = await visibleDrawing('Layers', '#into')
    await drag([photo.x + 30, photo.y + 20], [into.x + 50, into.y + 30])
    await expect.poll(() => patchRequests).toBe(1)
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('#into > img')
    expect(await iframe.$eval('#photo', (el) => getComputedStyle(el).position)).toBe('relative')
    expect((await visibleDrawing('Layers', '#into')).height).toBe(100)
  })

  it.each(['escape', 'pointer', 'blur', 'remote', 'locked', 'outside', 'same slot'])(
    'does not commit a layout drop on %s',
    async (reason) => {
      const source = layerFrame(
        reason === 'locked' ? flowBoxes.replace('id="into"', 'id="into" data-doop-locked') : flowBoxes,
      )
      await seedFrames([source])
      await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
      const photo = await visibleDrawing('Layers', '#photo')
      const into = await visibleDrawing('Layers', '#into')
      await page.mouse.move(photo.x + 30, photo.y + 20)
      await page.mouse.down()
      await page.mouse.move(
        reason === 'outside' ? 1100 : reason === 'same slot' ? photo.x + 40 : into.x + 50,
        reason === 'same slot' ? photo.y + 30 : into.y + 40,
        { steps: 5 },
      )
      if (!['locked', 'outside'].includes(reason)) await page.waitForSelector('[data-element-drop-indicator]')
      if (reason === 'escape') await page.keyboard.press('Escape')
      if (reason === 'pointer')
        await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })))
      if (reason === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      if (reason === 'remote')
        await seedFrames([{ ...source, html: source.html.replace('</body>', '<p>Remote</p></body>') }])
      await page.mouse.up()
      await expect.poll(async () => (await visibleDrawing('Layers', '#photo')).x).toBeCloseTo(photo.x, 0)
      expect(patchRequests).toBe(0)
      expect(await page.$('[data-element-drop-indicator]')).toBeNull()
    },
  )

  it('uses the release position when an earlier target reply is delayed', async () => {
    await seedFrames([
      layerFrame(flowBoxes + '<div id="last" style="margin:40px;padding:30px;min-height:40px;background:#eee"></div>'),
    ])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    const photo = await visibleDrawing('Layers', '#photo')
    const into = await visibleDrawing('Layers', '#into')
    const last = await visibleDrawing('Layers', '#last')
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.evaluate(() => {
      window.addEventListener(
        'message',
        function delay(event) {
          if (event.data?.type !== 'doop:move-target') return
          event.stopImmediatePropagation()
          window.removeEventListener('message', delay, true)
          setTimeout(
            () => window.dispatchEvent(new MessageEvent('message', { data: event.data, source: event.source })),
            250,
          )
        },
        true,
      )
    })
    await page.mouse.move(photo.x + 30, photo.y + 20)
    await page.mouse.down()
    await page.mouse.move(into.x + 50, into.y + 40, { steps: 3 })
    await page.mouse.move(last.x + 50, last.y + 40)
    await page.mouse.up()
    await expect.poll(() => patchRequests).toBe(1)
    await iframe.waitForSelector('#last > img')
  })

  it('keeps a path-selected image selected when it enters a div containing plain text', async () => {
    await seedFrames([
      layerFrame(`<div style="padding:20px">${flowImage.replace(' id="photo"', '')}</div>
      <div id="into" style="margin:30px;padding:30px;width:180px;min-height:60px;background:#ddd">Plain text</div>`),
    ])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    const photo = await visibleDrawing('Layers', 'img')
    const into = await visibleDrawing('Layers', '#into')
    await drag([photo.x + 30, photo.y + 20], [into.x + 80, into.y + 70])
    await expect.poll(() => patchRequests).toBe(1)
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('#into > img')
    const selector = await page.evaluate(() => window.drawingHarness.state().selectedElement!.selector)
    expect(await iframe.$eval(selector, (el) => el.tagName)).toBe('IMG')
    expect(await iframe.$eval('#into', (el) => el.textContent)).toBe('Plain text')
  })

  it.each(['translateX(-50%)', 'translate(-50%, 20px) rotate(20deg) scale(1.2)'])(
    'removes imported transform translation while retaining rotation and scale: %s',
    async (transform) => {
      await seedFrames([
        layerFrame(`<p id="text" style="position:absolute;left:100px;top:30px;width:100px;height:40px;margin:0;transform:${transform}">Imported text</p>
        <div id="into" style="margin:180px 0 0 250px;padding:20px;width:180px;min-height:80px;background:#ddd"></div>`),
      ])
      await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
      const text = await visibleDrawing('Layers', '#text')
      const into = await visibleDrawing('Layers', '#into')
      const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
      const matrix = () =>
        iframe.$eval('#text', (el) => {
          const value = getComputedStyle(el).transform
          const m = new DOMMatrix(value === 'none' ? undefined : value)
          return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }
        })
      const before = await matrix()
      await drag([text.x + text.width / 2, text.y + text.height / 2], [into.x + 80, into.y + 60])
      await expect.poll(() => patchRequests).toBe(1)
      await iframe.waitForSelector('#into > #text')
      const after = await matrix()
      expect(after).toEqual({ ...before, e: 0, f: 0 })
      if (transform === 'translateX(-50%)')
        expect((await visibleDrawing('Layers', '#text')).x).toBeCloseTo(into.x + 20, 0)
    },
  )

  it.each(['outside', 'already last in DOM'])(
    'matches CSS order when dropping after the last visible flex item (%s)',
    async (start) => {
      const inside = start !== 'outside'
      await seedFrames([
        layerFrame(`${inside ? '' : flowImage}<div id="into" style="display:flex;gap:20px;margin:100px 20px;padding:20px;min-height:60px;background:#ddd">
        <div id="one" style="order:1;width:80px;height:60px;flex-shrink:0">One</div>
        <div id="two" style="order:1;width:80px;height:60px;flex-shrink:0">Two</div>${inside ? flowImage : ''}</div>`),
      ])
      await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
      const photo = await visibleDrawing('Layers', '#photo')
      const two = await visibleDrawing('Layers', '#two')
      await drag([photo.x + 30, photo.y + 20], [two.x + two.width - 5, two.y + 30])
      await expect.poll(() => patchRequests).toBe(1)
      const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
      await iframe.waitForSelector('#into > img:last-child')
      await iframe.waitForFunction(() => getComputedStyle(document.querySelector('#photo')!).order === '1')
      const moved = await visibleDrawing('Layers', '#photo')
      const previous = await visibleDrawing('Layers', '#two')
      expect(moved.x).toBeCloseTo(previous.x + previous.width + 20, 0)
      await page.evaluate(() => window.drawingHarness.undo())
      await expect.poll(async () => (await visibleDrawing('Layers', '#photo')).x).toBeCloseTo(photo.x, 0)
    },
  )

  it.each(['doop:move-hit', 'doop:style-gesture', 'doop:move-target'])(
    'keeps fast layer drags and cancellation correct while %s is delayed',
    async (message) => {
      for (const cancel of [false, true]) {
        const source = layerFrame(rectangle)
        await seedFrames([source])
        await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
        const before = await visibleDrawing('Layers', '#rect')
        const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
        await iframe.evaluate((message) => {
          delete document.body.dataset.replied
          window.addEventListener(
            'message',
            function delay(event) {
              if (event.data?.type !== message || (message === 'doop:style-gesture' && event.data.phase !== 'begin'))
                return
              event.stopImmediatePropagation()
              window.removeEventListener('message', delay, true)
              setTimeout(() => {
                window.dispatchEvent(new MessageEvent('message', { data: event.data, source: event.source }))
                document.body.dataset.replied = 'true'
              }, 250)
            },
            true,
          )
        }, message)
        const savesBefore = patchRequests
        await page.mouse.move(before.x + 40, before.y + 40)
        await page.mouse.down()
        await page.mouse.move(before.x + 100, before.y + 70, { steps: 3 })
        if (cancel) await page.keyboard.press('Escape')
        await page.mouse.up()
        await iframe.waitForFunction(() => document.body.dataset.replied === 'true')
        await expect
          .poll(async () => (await visibleDrawing('Layers', '#rect')).x)
          .toBeCloseTo(before.x + (cancel ? 0 : 60), 0)
        await expect.poll(() => patchRequests).toBe(savesBefore + (cancel ? 0 : 1))
      }
    },
  )

  it('still enters text editing on double-click and moves the whole frame from its title', async () => {
    const source = layerFrame('<p id="text" style="width:100px;height:80px;margin:50px">Edit me</p>')
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const text = await visibleDrawing('Layers', '#text')
    await page.mouse.click(text.x + 20, text.y + 10, { count: 2, delay: 60 })
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('style[data-v-edit]')
    await iframe.click('#text')
    await iframe.waitForSelector('#text[contenteditable]')
    await page.keyboard.press('Escape')
    await iframe.waitForFunction(() => !document.querySelector('style[data-v-edit]'))
    const before = await page.$eval('iframe[title="Layers"]', (el) => el.getBoundingClientRect().toJSON() as DOMRect)
    await drag([before.x + 20, before.y - 14], [before.x + 80, before.y + 16])
    await expect.poll(() => saved[0]?.x).toBe(source.x + 60)
    expect(saved[0]?.y).toBe(source.y + 30)
  })

  it.each(['scale(2)', 'rotate(30deg) scale(1.5)'])(
    'preserves transformed shape geometry across moves: %s',
    async (transform) => {
      const source: Frame = {
        id: 'source',
        updatedBy: 'User',
        canvasId: 'c',
        pageId: 'first',
        name: 'Source',
        x: 20,
        y: 20,
        width: 250,
        height: 250,
        createdAt: 0,
        updatedAt: 0,
        html: `<div id="transformed" data-doop-drawing="rectangle" data-name="Rectangle" style="position:fixed;left:80px;top:80px;width:60px;height:40px;background:red;transform:${transform}"></div>`,
      }
      const destination = { ...source, id: 'destination', name: 'Destination', x: 330, width: 220, html: '' }
      await seedFrames([source, destination])
      const initial = await visibleDrawing('Source')
      let current = initial
      for (const [title, to] of [
        ['Source', [current.x + current.width / 2 + 40, current.y + current.height / 2 + 20]],
        ['Destination', [850, 300]],
        ['Rectangle', [500, 650]],
        ['Source', [300, 300]],
      ] as [string, [number, number]][]) {
        const beforeHtml = saved.map((f) => f.html).join()
        const from: [number, number] = [current.x + current.width / 2, current.y + current.height / 2]
        await page.mouse.move(...from)
        await page.mouse.down()
        await page.mouse.move(...to, { steps: 5 })
        const preview = await visibleDrawing('Moving drawing')
        await page.mouse.up()
        expect(preview.width).toBeCloseTo(initial.width, 1)
        expect(preview.height).toBeCloseTo(initial.height, 1)
        await page
          .waitForFunction(
            (before) =>
              window.drawingHarness
                .state()
                .frames.map((f) => f.html)
                .join() !== before,
            {},
            beforeHtml,
          )
          .catch(async (err: unknown) => {
            const state = await page.evaluate(() => ({
              ...window.drawingHarness.state(),
              editing: document.body.textContent?.includes('Click any text to edit'),
            }))
            throw new Error(`${transform}: moving to ${title}: ${JSON.stringify(state)}`, { cause: err })
          })
        await page.waitForFunction(
          (name) =>
            window.drawingHarness.state().frames.some((f) => f.name === name && f.html.includes('data-doop-drawing')),
          {},
          title,
        )
        const target = await page.waitForSelector(`iframe[title="${title}"]`)
        const iframe = (await target!.contentFrame())!
        const html = saved.find((f) => f.name === title)!.html
        const position = await page.evaluate((html) => {
          const el = new DOMParser()
            .parseFromString(html, 'text/html')
            .querySelector<HTMLElement>('[data-doop-drawing]')!
          return { left: el.style.left, top: el.style.top }
        }, html)
        await iframe.waitForFunction(
          (position) => {
            const el = document.querySelector<HTMLElement>('[data-doop-drawing]')
            return el?.style.left === position.left && el.style.top === position.top
          },
          {},
          position,
        )
        current = await visibleDrawing(title)
        expect(current.width).toBeCloseTo(initial.width, 1)
        expect(current.height).toBeCloseTo(initial.height, 1)
        // Regular frame chrome adds a design-pixel border around its iframe.
        expect(Math.abs(current.x + current.width / 2 - to[0])).toBeLessThanOrEqual(2.1)
        expect(Math.abs(current.y + current.height / 2 - to[1])).toBeLessThanOrEqual(2.1)
        expect(await iframe.$eval('[data-doop-drawing]', (el) => getComputedStyle(el).width)).toBe('60px')
      }
      await page.screenshot({ path: '/tmp/doop-transformed-drawing.png' })
    },
  )

  it('measures drawing geometry consistently once the world settles at the zoom', async () => {
    await page.click('[aria-label="Frame"]')
    await drag([200, 200], [600, 600])
    await waitForFrames(1)
    await page.click('[aria-label="Circle"]')
    await drag([250, 300], [330, 380])
    await waitForFrames(1)
    await page.waitForFunction(() => window.drawingHarness.state().frames[0]?.html.includes('data-doop-drawing'))
    const initial = await visibleDrawing('Frame')
    const iframe = (await (await page.$('iframe[title="Frame"]'))!.contentFrame())!
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 3 }))
    // the settled zoom is the world's CSS zoom, which the iframe element undoes;
    // the document inside keeps its design viewport, so nothing in there changes
    await page.waitForFunction(() => (document.querySelector('.world') as HTMLElement).style.zoom === '3')
    const designWidth = await page.evaluate(() => window.drawingHarness.state().frames[0]!.width)
    expect(await iframe.evaluate(() => [innerWidth, document.documentElement.style.zoom])).toEqual([designWidth, ''])
    const zoomed = await visibleDrawing('Frame')
    expect(zoomed.width).toBeCloseTo(initial.width * 1.5, 1)
    expect(zoomed.height).toBeCloseTo(initial.height * 1.5, 1)
  })

  it('lays the drag preview out at design px while the world is zoomed', async () => {
    const source: Frame = {
      id: 'source',
      updatedBy: 'User',
      canvasId: 'c',
      pageId: 'first',
      name: 'Source',
      x: 20,
      y: 20,
      width: 250,
      height: 250,
      createdAt: 0,
      updatedAt: 0,
      html: '<div data-doop-drawing="rectangle" data-name="Rectangle" style="position:absolute;left:40px;top:40px;width:60px;height:40px;background:red"></div>',
    }
    await seedFrames([source])
    await page.evaluate(async () => {
      window.drawingHarness.viewport({ x: 0, y: 0, zoom: 2 })
      const world = document.querySelector<HTMLElement>('.world')!
      while (world.style.zoom !== '2') await new Promise((r) => requestAnimationFrame(r))
    })
    const drawing = await visibleDrawing('Source')
    await page.mouse.move(drawing.x + drawing.width / 2, drawing.y + drawing.height / 2)
    await page.mouse.down()
    await page.mouse.move(drawing.x + drawing.width / 2 + 60, drawing.y + drawing.height / 2 + 30, { steps: 5 })
    const handle = await page.waitForSelector('iframe[title="Moving drawing"]')
    const preview = (await handle!.contentFrame())!
    await preview.waitForSelector('[data-doop-drawing]')
    const inside = await preview.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))
    const moving = await visibleDrawing('Moving drawing')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    // Chromium takes the world's 2x layout zoom as the preview's pixel density,
    // as it does for frames, so the drawing keeps its design width and sharpness
    expect(inside).toEqual({ width: 60, dpr: 2 })
    expect(moving.width).toBeCloseTo(drawing.width, 1)
  })

  it('keeps a peer cursor on its spot while the world switches layout zoom', async () => {
    await page.evaluate(() => {
      window.drawingHarness.peer({ x: 200, y: 150 })
      window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 })
    })
    await page.waitForFunction(() => (document.querySelector('.world') as HTMLElement).style.zoom === '1')
    // sample every frame across the switch: the cursor's transition used to
    // replay its translate from the old zoom while the world snapped
    const maxError = await page.evaluate(async () => {
      const world = document.querySelector<HTMLElement>('.world')!
      const stage = world.parentElement!.getBoundingClientRect()
      const cursor = () => document.querySelector('path[d^="M1 1 L16"]')!.closest('div')!
      let worst = 0
      let sampling = true
      const tick = () => {
        if (!sampling) return
        const vp = window.drawingHarness.camera()
        worst = Math.max(worst, Math.abs(cursor().getBoundingClientRect().left - stage.left - (vp.x + 200 * vp.zoom)))
        requestAnimationFrame(tick)
      }
      tick()
      window.drawingHarness.viewport({ x: -50, y: 0, zoom: 2.4 })
      // Chromium lays the world out at the whole zoom above the camera's
      while (world.style.zoom !== '3') await new Promise((r) => requestAnimationFrame(r))
      await new Promise((r) => setTimeout(r, 150))
      sampling = false
      return worst
    })
    expect(maxError).toBeLessThan(1)
  })

  it('grabs the visibly top drawing through stacking contexts instead of reverse DOM order', async () => {
    const source: Frame = {
      id: 'stacked',
      updatedBy: 'User',
      canvasId: 'c',
      pageId: 'first',
      name: 'Stacked',
      x: 20,
      y: 20,
      width: 400,
      height: 300,
      createdAt: 0,
      updatedAt: 0,
      html: `<div style="position:relative;z-index:10"><div id="front" data-doop-drawing="rectangle" style="position:fixed;left:60px;top:60px;width:100px;height:100px;background:red"></div></div>
      <div id="back" data-doop-drawing="rectangle" style="position:fixed;left:60px;top:60px;width:100px;height:100px;background:blue;z-index:5"></div>`,
    }
    await seedFrames([source])
    const front = await visibleDrawing('Stacked', '#front')
    await drag([front.x + 30, front.y + 30], [front.x + 70, front.y + 50])
    await page.waitForFunction((before) => window.drawingHarness.state().frames[0]!.html !== before, {}, source.html)
    const positions = await page.evaluate(() => {
      const doc = new DOMParser().parseFromString(window.drawingHarness.state().frames[0]!.html, 'text/html')
      return ['front', 'back'].map((id) => {
        const el = doc.getElementById(id)!
        return [el.style.left, el.style.top]
      })
    })
    expect(positions).toEqual([
      ['80px', '70px'],
      ['60px', '60px'],
    ])
  })

  it.each([false, true])('handles a drag that ends before its iframe hit test returns (cancel: %s)', async (cancel) => {
    const source: Frame = {
      id: 'slow',
      canvasId: 'c',
      pageId: 'first',
      name: 'Slow',
      updatedBy: 'User',
      x: 20,
      y: 20,
      width: 250,
      height: 250,
      createdAt: 0,
      updatedAt: 0,
      html: '<div data-doop-drawing="rectangle" data-name="Rectangle" style="position:fixed;left:60px;top:60px;width:100px;height:100px;background:red"></div>',
    }
    await seedFrames([source])
    const rect = await visibleDrawing('Slow')
    const iframe = (await (await page.$('iframe[title="Slow"]'))!.contentFrame())!
    await iframe.evaluate(() =>
      window.addEventListener(
        'message',
        (event) => {
          if (event.data?.type !== 'doop:drawing-hit' || event.data.delayed) return
          event.stopImmediatePropagation()
          setTimeout(() => {
            window.dispatchEvent(
              new MessageEvent('message', { data: { ...event.data, delayed: true }, source: event.source }),
            )
            document.body.dataset.replied = 'true'
          }, 250)
        },
        true,
      ),
    )
    await page.mouse.move(rect.x + 40, rect.y + 40)
    await page.mouse.down()
    await page.mouse.move(900, 600)
    if (cancel) await page.keyboard.press('Escape')
    await page.mouse.up()
    await iframe.waitForFunction(() => document.body.dataset.replied === 'true')
    if (cancel) {
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      )
      expect(saved).toEqual([source])
      expect(await page.$('iframe[title="Moving drawing"]')).toBeNull()
    } else {
      const result = await waitForFrames(2)
      expect(result[0]!.html).not.toContain('data-doop-drawing')
      expect(result[1]).toMatchObject({ width: 100, height: 100, name: 'Rectangle' })
    }
  })

  it('does not grab a drawing behind non-drawing content', async () => {
    const source: Frame = {
      id: 'covered',
      canvasId: 'c',
      pageId: 'first',
      name: 'Covered',
      updatedBy: 'User',
      x: 20,
      y: 20,
      width: 400,
      height: 300,
      createdAt: 0,
      updatedAt: 0,
      html: '<div data-doop-drawing="rectangle" style="position:fixed;left:60px;top:60px;width:100px;height:100px;background:red"></div><div id="cover" style="position:fixed;left:60px;top:60px;width:100px;height:100px;background:black;z-index:10">Cover</div>',
    }
    await seedFrames([source])
    const covered = await visibleDrawing('Covered')
    await drag([covered.x + 30, covered.y + 30], [covered.x + 70, covered.y + 50])
    await expect.poll(() => patchRequests).toBe(1)
    expect(saved[0]).toMatchObject({ x: 20, y: 20 })
    const cover = await visibleDrawing('Covered', '#cover')
    expect(cover.x - covered.x).toBeCloseTo(40, 0)
    expect(cover.y - covered.y).toBeCloseTo(20, 0)
    expect(await visibleDrawing('Covered')).toEqual(covered)
    expect(saved).toHaveLength(1)
  })

  it('preserves canvas comments and lets comment pins interrupt drawing without creating a shape', async () => {
    await page.keyboard.press('c')
    await page.mouse.click(220, 200)
    await page.waitForSelector('textarea[placeholder="Leave a comment here…"]')
    expect(await page.$eval('.stage', (el) => getComputedStyle(el).cursor)).toContain('url(')
    await page.keyboard.press('Escape')
    await page.evaluate(() =>
      window.drawingHarness.comments([
        {
          id: 'comment',
          canvasId: 'c',
          pageId: 'first',
          x: 200,
          y: 160,
          from: 'Alice',
          text: 'Keep this',
          selector: '',
          snippet: '',
          at: 0,
        },
      ]),
    )
    await page.click('[aria-label="Rectangle"]')
    await page.click('[title="Alice: Keep this"]')
    const reply = 'textarea[placeholder="Reply… (@doop to ask the agent)"]'
    await page.waitForSelector(reply)
    await page.click(reply)
    await page.keyboard.type('Reply text')
    expect(await page.$eval(reply, (el) => el.value)).toBe('Reply text')
    expect(await page.$eval(reply, (el) => getComputedStyle(el).cursor)).not.toBe('crosshair')
    expect(saved).toHaveLength(0)
    await page.click('[aria-label="Vector path"]')
    await page.mouse.click(800, 200)
    await page.mouse.click(900, 220)
    await page.click('[title="Alice: Keep this"]')
    await page.waitForSelector(reply)
    await page.click(reply)
    await page.keyboard.press('Enter')
    expect(await page.$eval('[data-drawing-hint]', (el) => el.textContent)).not.toContain('Finish path')
    expect(saved).toHaveLength(0)
  })

  it('keeps all tools reachable on phones, clear of zoom, and accepts touch drawing', async () => {
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    // Changing mobile emulation reloads the page in Chromium.
    await page.waitForFunction(() => !!window.drawingHarness)
    await page.evaluate(() =>
      window.drawingHarness.seed({
        id: 'c',
        name: 'Draw',
        frames: [],
        pages: [{ id: 'first', name: 'Main' }],
        createdAt: 0,
        updatedAt: 0,
      }),
    )
    await page.waitForSelector('[aria-label="Canvas tools"]')
    expect(await page.evaluate(() => window.innerWidth)).toBe(390)
    const boxes = await page.evaluate(() => {
      const tools = document.querySelector('[aria-label="Canvas tools"]')!.getBoundingClientRect()
      const zoom = document.querySelector('[aria-label="Zoom level"]')!.getBoundingClientRect()
      return { left: tools.left, right: tools.right, top: tools.top, zoomBottom: zoom.bottom }
    })
    expect(boxes.left).toBeGreaterThanOrEqual(0)
    expect(boxes.right).toBeLessThanOrEqual(390)
    expect(boxes.zoomBottom).toBeLessThan(boxes.top)
    await page.click('[aria-label="Rectangle"]')
    const hintClear = await page.evaluate(
      () =>
        document.querySelector('[aria-label="Zoom level"]')!.getBoundingClientRect().bottom <
        document.querySelector('[data-drawing-hint]')!.getBoundingClientRect().top,
    )
    expect(hintClear).toBe(true)
    await page.screenshot({ path: '/tmp/doop-drawing-mobile-tools.png' })
    await page.touchscreen.tap(180, 250)
    expect((await waitForFrames(1))[0]!.name).toBe('Rectangle')
    await page.screenshot({ path: '/tmp/doop-drawing-mobile.png' })
    await page.click('[aria-label="Vector path"]')
    await page.touchscreen.touchStart(80, 450)
    await page.touchscreen.touchMove(80, 390)
    await page.touchscreen.touchEnd()
    await page.touchscreen.touchStart(280, 450)
    await page.touchscreen.touchMove(280, 510)
    await page.touchscreen.touchEnd()
    await page.click('[data-drawing-hint] button')
    expect((await waitForFrames(2))[1]!.html).toContain(' C ')
    await page.screenshot({ path: '/tmp/doop-canvas-curves-mobile.png' })
  })
})
