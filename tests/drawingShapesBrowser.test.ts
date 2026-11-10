import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import {
  drag,
  drawingPage,
  layerFrame,
  page,
  patchRequests,
  saved,
  seedFrames,
  visibleDrawing,
  waitForFrames,
} from './drawingPage'
import type { Frame } from '../shared/types'

describe.skipIf(!findBrowserPath())('drawing on the canvas', { timeout: 30_000 }, () => {
  drawingPage()

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

  it('types literal multiline text without triggering shortcuts, keeps escaped text and drops empty drafts', async () => {
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
    await page.keyboard.type('keep me')
    await page.keyboard.press('Escape')
    expect(await page.$('textarea[data-drawing-input]')).toBeNull()
    expect((await waitForFrames(2))[1]!.html).toContain('keep me')
    expect(await page.evaluate(() => window.drawingHarness.state().tool)).toBe('select')
    await page.keyboard.press('t')
    await page.mouse.click(800, 600)
    await page.keyboard.press('Escape')
    expect(await page.$('textarea[data-drawing-input]')).toBeNull()
    expect(saved).toHaveLength(2)
    await page.keyboard.press('t')
    await page.mouse.click(800, 600)
    await page.mouse.click(800, 700)
    expect(await page.$('textarea[data-drawing-input]')).toBeNull()
    expect(saved).toHaveLength(2)
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
    /* a transfer saves the destination first; the source's removal is the
       save after it, still on its way when the store already shows the move */
    await expect.poll(() => saved[0]!.html).not.toContain('data-doop-drawing')
    await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.frameId === 'drawn-2')
    await page.waitForSelector('[data-comment-ui] button')
    await page.mouse.click(1100, 550)
    await drag([750, 360], [500, 600])
    const outside = (await waitForFrames(3))[2]!
    expect(outside).toMatchObject({ x: 210, y: 250, width: 40, height: 40, name: 'Circle' })
    await expect.poll(() => saved[1]!.html).not.toContain('data-doop-drawing')
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

  /** Which of the pen cursors the stage wears (each SVG names itself). */
  const stageCursor = () =>
    page.$eval('.stage', (el) => decodeURIComponent(getComputedStyle(el).cursor).match(/data-cursor='([^']+)'/)?.[1])

  it('snaps to intermediate anchors and lets Alt place a point freely', async () => {
    await page.click('[aria-label="Vector path"]')
    expect(await stageCursor()).toBe('pen')
    await page.mouse.click(220, 250)
    await page.mouse.click(420, 250)
    await page.mouse.click(420, 450)
    await page.mouse.move(426, 250)
    await page.waitForSelector('[data-path-anchor="1"][data-snapped="true"]')
    /* the pen's badge says what a press does: land on that anchor, or close on the first */
    expect(await stageCursor()).toBe('pen-anchor')
    await page.mouse.move(222, 250)
    await page.waitForSelector('[data-path-snap="close"]')
    expect(await stageCursor()).toBe('pen-close')
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

  it("resizes an edited standalone path through its shell's grips", async () => {
    /* a standalone path's root fills its shell and wears only the shell's
       grips: an edit must leave it filling the shell, or the grips would
       grow the frame around a path that stays put */
    const frame: Frame = {
      id: 'pen',
      updatedBy: 'User',
      canvasId: 'c',
      pageId: 'first',
      name: 'Pen',
      x: 30,
      y: 30,
      width: 140,
      height: 100,
      createdAt: 0,
      updatedAt: 0,
      html: '<body data-doop-canvas-element="true" style="margin:0"><svg id="pen" data-doop-drawing="path" viewBox="0 0 140 100" preserveAspectRatio="none" style="position:absolute;left:0;top:0;width:100%;height:100%;margin:0"><path d="M 10 50 C 30 0 80 100 120 50" stroke="black" fill="none" stroke-width="2" /></svg></body>',
    }
    await seedFrames([frame])
    const rect = await visibleDrawing('Pen')
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { count: 2, delay: 60 })
    const first = await editorPoint(0)
    await drag(first, [first[0] - 30, first[1] + 40])
    await page.waitForFunction((before) => window.drawingHarness.state().frames[0]!.html !== before, {}, frame.html)
    await page.waitForFunction(() => !document.body.textContent?.includes('Saving path…'))
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-path-editor]'))
    const edited = saved[0]!
    expect(edited.html).toMatch(/width:\s*100%;\s*height:\s*100%/)
    expect(edited.html).not.toContain('matrix(')
    await page.evaluate(() => window.drawingHarness.selectFrames(['pen']))
    const grip = await page.waitForSelector('[data-frame-resize-handle="se"]')
    const box = (await grip!.boundingBox())!
    await drag(
      [box.x + box.width / 2, box.y + box.height / 2],
      [box.x + box.width / 2 + 100, box.y + box.height / 2 + 60],
    )
    await page.waitForFunction((before) => window.drawingHarness.state().frames[0]!.width !== before, {}, edited.width)
    const grown = await page.evaluate(() => window.drawingHarness.state().frames[0]!)
    expect(grown.width).toBeGreaterThan(edited.width)
    expect(grown.height).toBeGreaterThan(edited.height)
    /* the rendered path follows the shell: no empty band, no clipping */
    const after = await visibleDrawing('Pen', 'svg')
    const shell = (await (await page.$('iframe[title="Pen"]'))!.boundingBox())!
    expect(after.width).toBeCloseTo(shell.width, 0)
    expect(after.height).toBeCloseTo(shell.height, 0)
  })

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

  it('formats selected text from the toolbar, saves it, and supports canvas undo after editing', async () => {
    const source = layerFrame('<p id="text" style="width:200px;height:80px;margin:80px">Hello world</p>')
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 80, zoom: 1 }))
    const text = await visibleDrawing('Layers', '#text')
    await page.mouse.click(text.x + 20, text.y + 10, { count: 2, delay: 60 })
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('#text[contenteditable]')
    await iframe.evaluate(() => {
      const text = document.querySelector('#text')!.firstChild!
      getSelection()!.setBaseAndExtent(text, 0, text, 5)
    })
    await page.waitForSelector('[aria-label="Text formatting"]')
    await page.click('button[aria-label="Bold"]')
    await iframe.waitForSelector('#text b')
    expect(await iframe.$eval('#text b', (el) => el.textContent)).toBe('Hello')
    expect(await iframe.evaluate(() => getSelection()!.toString())).toBe('Hello')
    await page.waitForSelector('button[aria-label="Bold"][aria-pressed="true"]')
    await expect.poll(() => saved[0]?.html).toContain('<b>Hello</b> world')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[aria-label="Text formatting"]'))
    await iframe.waitForFunction(() => !document.querySelector('[contenteditable]'))
    await page.evaluate(() => window.drawingHarness.undo())
    await expect.poll(() => saved[0]?.html).toBe(source.html)
    await page.evaluate(() => window.drawingHarness.redo())
    await expect.poll(() => saved[0]?.html).toContain('<b>Hello</b> world')
  })

  it('bolds a picked text layer whole from the canvas and undoes it in one step', async () => {
    const source = layerFrame('<p style="width:200px;height:80px;margin:80px">Hello <b>world</b></p>')
    await seedFrames([source])
    const paragraph = 'body:nth-of-type(1) > p:nth-of-type(1)'
    await page.evaluate((selector) => window.drawingHarness.pick({ frameId: 'layers', selector }), paragraph)
    await page.waitForFunction(
      (selector) => window.drawingHarness.state().selectedElement?.selector === selector,
      {},
      paragraph,
    )
    expect(await page.evaluate(() => window.drawingHarness.formatText('bold'))).toBe(true)
    await expect.poll(() => saved[0]?.html).toContain('<b>Hello world</b>')
    await page.evaluate(() => window.drawingHarness.undo())
    await expect.poll(() => saved[0]?.html).toBe(source.html)
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement?.selector)).toBe(paragraph)
    /* the save comes back before the frame's own document shows the undo;
       formatting acts on that document, so wait until the bold is gone from it */
    const doc = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await doc.waitForFunction(() => document.querySelector('p')?.innerHTML === 'Hello <b>world</b>')
    // The paragraph becomes a div so the list survives reload; the selection follows it.
    expect(await page.evaluate(() => window.drawingHarness.formatText('insertUnorderedList'))).toBe(true)
    await expect.poll(() => saved[0]?.html).toContain('<li>Hello <b>world</b></li>')
    await page.waitForFunction(
      () => window.drawingHarness.state().selectedElement?.selector === 'body:nth-of-type(1) > div:nth-of-type(1)',
    )
  })

  it('leaves a layer inside a locked frame alone on a format shortcut', async () => {
    const source = { ...layerFrame('<p id="text" style="margin:80px">Hello</p>'), locked: true }
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.pick({ frameId: 'layers', selector: '#text' }))
    await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.selector === '#text')
    expect(await page.evaluate(() => window.drawingHarness.formatText('bold'))).toBe(true)
    await new Promise((r) => setTimeout(r, 400))
    expect(saved[0]?.html).toBe(source.html)
  })

  it('still enters text editing on double-click and moves the whole frame from its title', async () => {
    const source = layerFrame('<p id="text" style="width:100px;height:80px;margin:50px">Edit me</p>')
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const text = await visibleDrawing('Layers', '#text')
    await page.mouse.click(text.x + 20, text.y + 10, { count: 2, delay: 60 })
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('style[data-v-edit]')
    /* the double-click itself opens the text with every character selected
       (no second click to place a caret), outlined by the page's hairline
       with no grips and no badge to dismiss */
    await iframe.waitForSelector('#text[contenteditable]')
    expect(await iframe.evaluate(() => getSelection()?.toString())).toBe('Edit me')
    await page.waitForSelector('[data-editing-outline]')
    expect(await page.$('[data-element-outline]')).toBeNull()
    expect(await page.$('[data-resize-handles]')).toBeNull()
    expect(await page.$$eval('button', (buttons) => buttons.some((b) => b.textContent?.trim() === 'Done'))).toBe(false)
    await page.keyboard.press('Escape')
    await iframe.waitForFunction(() => !document.querySelector('style[data-v-edit]'))
    /* the edit's text selection does not outlive it */
    expect(await iframe.evaluate(() => getSelection()?.toString() ?? '')).toBe('')
    /* Escape hands the keyboard back to the page: the next key (⌫ on the
       still-selected element) must reach the canvas's window, not the frame */
    await page.waitForFunction(() => document.activeElement?.tagName !== 'IFRAME')
    /* the listener is in place before the key is sent: an un-awaited
       evaluate raced the key to the page on CI and never settled */
    await page.evaluate(() =>
      window.addEventListener('keydown', (e) => (document.documentElement.dataset.heard = e.key), { once: true }),
    )
    await page.keyboard.press('Backspace')
    await page.waitForFunction(() => document.documentElement.dataset.heard === 'Backspace')
    const before = await page.$eval('iframe[title="Layers"]', (el) => el.getBoundingClientRect().toJSON() as DOMRect)
    await drag([before.x + 20, before.y - 14], [before.x + 80, before.y + 16])
    await expect.poll(() => saved[0]?.x).toBe(source.x + 60)
    expect(saved[0]?.y).toBe(source.y + 30)
  })

  it('relays canvas shortcuts pressed while the focus is left inside a frame', async () => {
    const source = layerFrame('<p id="text" style="width:100px;height:80px;margin:50px">Edit me</p>')
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const text = await visibleDrawing('Layers', '#text')
    await page.mouse.click(text.x + 20, text.y + 10, { count: 2, delay: 60 })
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('style[data-v-edit]')
    await iframe.click('#text')
    await iframe.waitForSelector('#text[contenteditable]')
    /* typing while editing stays in the text */
    await page.keyboard.press('r')
    expect(await page.evaluate(() => window.drawingHarness.state().tool)).toBe('select')
    await page.keyboard.press('Escape')
    await iframe.waitForFunction(() => !document.querySelector('style[data-v-edit]'))
    /* the Escape that ended editing is not also the canvas's Escape */
    expect(await page.evaluate(() => window.drawingHarness.state().selectedIds)).toEqual(['layers'])
    /* the page takes the keyboard back when an edit ends; a design's own
       script, or a tab into the frame, can still leave it in there */
    await expect.poll(() => iframe.evaluate(() => document.hasFocus())).toBe(false)
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="Layers"]')!.focus())
    expect(await iframe.evaluate(() => document.hasFocus())).toBe(true)
    await page.keyboard.press('r')
    await page.waitForFunction(() => window.drawingHarness.state().tool === 'rectangle')
    /* a canvas chord reaches the canvas (⌘= / Ctrl+= zooms in) and is kept
       from the frame document's own browser default, the page zoom */
    await iframe.evaluate(() => {
      document.addEventListener('keydown', (e) => {
        if (e.key === '=') document.body.dataset.prevented = String(e.defaultPrevented)
      })
    })
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.down(mod)
    await page.keyboard.press('Equal')
    await page.keyboard.up(mod)
    await expect.poll(() => page.evaluate(() => window.drawingHarness.camera().zoom)).toBe(1.25)
    expect(await iframe.evaluate(() => document.body.dataset.prevented)).toBe('true')
    /* a design's own script cannot forge a key: not by posting the relay's
       shape, not by a synthetic event in its document, and a relayed ⌫ is
       never heard; nor is anything once the frame has let go of the focus */
    const forge = (key: string) =>
      iframe.evaluate((key) => {
        const code = key.length === 1 ? 'Key' + key.toUpperCase() : key
        const init = { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false }
        parent.postMessage({ type: 'doop:key', event: 'keydown', ...init }, '*')
        document.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }))
      }, key)
    /* nor can it fish the port out of the runtime's send, or make the key
       the person pressed read as another one */
    await iframe.evaluate(() => {
      const w = window as unknown as { leaked: unknown }
      const call = Function.prototype.call
      Function.prototype.call = function (this: unknown, thisArg: unknown, ...rest: unknown[]) {
        if (this === MessagePort.prototype.postMessage) w.leaked = thisArg
        return Reflect.apply(call, this, [thisArg, ...rest])
      }
      const key = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, 'key')!
      Object.defineProperty(KeyboardEvent.prototype, 'key', { ...key, get: () => 'h' })
    })
    await page.keyboard.press('r')
    expect(await page.evaluate(() => window.drawingHarness.state().tool)).toBe('rectangle')
    expect(await iframe.evaluate(() => (window as unknown as { leaked: unknown }).leaked)).toBeUndefined()
    await forge('h')
    await forge('Delete')
    await forge('Backspace')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await forge('h')
    await new Promise((r) => setTimeout(r, 100))
    expect(await page.evaluate(() => window.drawingHarness.state().frames.length)).toBe(1)
    expect(await page.evaluate(() => window.drawingHarness.state().tool)).toBe('rectangle')
  })

  it('keeps the picked element when a press on a layer that cannot move drags the frame', async () => {
    const source = layerFrame('<p id="text" data-doop-locked style="width:100px;height:80px;margin:50px">Locked</p>')
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const text = await visibleDrawing('Layers', '#text')
    await page.evaluate(() => {
      window.drawingHarness.selectFrames(['layers'])
      window.drawingHarness.pick({ frameId: 'layers', selector: '#text' })
    })
    await drag([text.x + 20, text.y + 10], [text.x + 80, text.y + 40])
    await expect.poll(() => saved[0]?.x).toBe(source.x + 60)
    expect(saved[0]?.y).toBe(source.y + 30)
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement)).toEqual({
      frameId: 'layers',
      selector: '#text',
    })
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
