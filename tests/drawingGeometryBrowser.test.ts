import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import {
  commentMoves,
  drag,
  drawingPage,
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
      let at = 'Source'
      for (const [title, to] of [
        ['Source', [current.x + current.width / 2 + 40, current.y + current.height / 2 + 20]],
        ['Destination', [850, 300]],
        ['Rectangle', [500, 650]],
        ['Source', [300, 300]],
      ] as [string, [number, number]][]) {
        const beforeHtml = saved.map((f) => f.html).join()
        const from: [number, number] = [current.x + current.width / 2, current.y + current.height / 2]
        /* a standalone element is moved like a frame: live, and snapping to
           the frames around it — ⌥ keeps this leg at the pointer's own spot,
           which the geometry below is measured against */
        const standalone = at === 'Rectangle'
        if (standalone) await page.keyboard.down('Alt')
        await page.mouse.move(...from)
        await page.mouse.down()
        await page.mouse.move(...to, { steps: 5 })
        /* a layer inside a frame travels as a preview; a standalone element
           is moved itself, so it is measured live */
        const preview = await visibleDrawing(standalone ? 'Rectangle' : 'Moving drawing')
        await page.mouse.up()
        if (standalone) await page.keyboard.up('Alt')
        at = title
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
              editing: !!document.querySelector('[title="Save and finish editing (Esc)"]'),
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
        // Regular frame chrome adds a design-pixel border around its iframe;
        // a standalone element lands on whole design pixels, as a frame does,
        // so its leg may be out by half a design pixel more.
        const slack = 2.1 + (standalone ? 1 : 0)
        expect(Math.abs(current.x + current.width / 2 - to[0])).toBeLessThanOrEqual(slack)
        expect(Math.abs(current.y + current.height / 2 - to[1])).toBeLessThanOrEqual(slack)
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
    // the shape itself moves: its original is unpainted while the copy follows
    const original = (await (await page.waitForSelector('iframe[title="Source"]'))!.contentFrame())!
    const visibility = () => original.$eval('[data-doop-drawing]', (el) => getComputedStyle(el).visibility)
    await expect.poll(visibility).toBe('hidden')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect.poll(visibility).toBe('visible')
    // Chromium takes the world's 2x layout zoom as the preview's pixel density,
    // as it does for frames, so the drawing keeps its design width and sharpness
    expect(inside).toEqual({ width: 60, dpr: 2 })
    expect(moving.width).toBeCloseTo(drawing.width, 1)
  })

  it('shows only the dragged drawing and snaps it to its frame and siblings', async () => {
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
      html:
        '<style>.tinted{background:rgb(0, 128, 0)}</style>' +
        '<div class="tinted" data-doop-drawing="rectangle" data-name="Rectangle" style="position:absolute;left:40px;top:40px;width:60px;height:40px"></div>' +
        '<div data-doop-drawing="rectangle" data-name="Sibling" style="position:absolute;left:150px;top:180px;width:50px;height:50px;background:blue"></div>' +
        // nearer on both axes than what it snaps to, but nobody sees it
        '<div data-doop-drawing="rectangle" data-name="Hidden" style="position:absolute;left:152px;top:178px;width:50px;height:50px;visibility:hidden"></div>',
    }
    await seedFrames([source])
    await page.evaluate(async () => {
      window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 })
      const world = document.querySelector<HTMLElement>('.world')!
      while (world.style.zoom !== '1') await new Promise((r) => requestAnimationFrame(r))
    })
    const drawing = await visibleDrawing('Source')
    const from = { x: drawing.x + 30, y: drawing.y + 20 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    /* the centre lands 2px short of the frame's (125) and the top 3px short
       of the sibling's (180): both pull on */
    await page.mouse.move(from.x + 53, from.y + 137, { steps: 6 })
    const moving = (await (await page.waitForSelector('iframe[title="Moving drawing"]'))!.contentFrame())!
    // the copy keeps the look its frame's stylesheet gives it
    await expect
      .poll(() => moving.$eval('[data-doop-drawing]', (el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(0, 128, 0)')
    expect(await page.$('[data-element-outline]')).toBeNull()
    expect(await page.$('[data-resize-handles]')).toBeNull()
    expect(await page.$('[data-element-size]')).toBeNull()
    // a move inside its own frame marks no drop target
    expect(await page.$('[data-drawing-drop-target]')).toBeNull()
    await page.mouse.up()
    await expect.poll(() => saved.find((f) => f.id === 'source')?.html ?? '').toContain('left: 95px; top: 180px;')
    // the picked shape is the selection: its frame wears no ring of its own
    await page.waitForSelector('[data-element-outline]')
    expect(await page.$('[data-frame-selection]')).toBeNull()
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

  it('comments on a frame as a whole where the Comment tool finds no element', async () => {
    await seedFrames([
      {
        id: 'plain',
        updatedBy: 'User',
        canvasId: 'c',
        pageId: 'first',
        name: 'Plain',
        x: 30,
        y: 30,
        width: 400,
        height: 300,
        createdAt: 0,
        updatedAt: 0,
        html: '<p id="a" style="margin:0">Alpha</p>',
      },
    ])
    const handle = await page.waitForSelector('iframe[title="Plain"]')
    const text = (await (await (await handle!.contentFrame())!.waitForSelector('#a'))!.boundingBox())!
    const box = (await handle!.boundingBox())!
    await page.keyboard.press('c')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForSelector('textarea[placeholder="Leave a comment on this frame…"]')
    /* the whole frame is never an element pick: ⌫ deletes the pick, and `body` would empty the frame */
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement)).toBeNull()
    /* the composer opens at the click, and the posted point is the click in design px (zoom 2) */
    const composer = (await (await page.$('[data-comment-ui] textarea'))!.boundingBox())!
    expect(Math.abs(composer.x - (box.x + box.width / 2))).toBeLessThan(40)
    const posted = page.waitForRequest((req) => req.url().endsWith('/api/frames/plain/comments'))
    await page.keyboard.type('Whole frame')
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    expect(JSON.parse((await posted).postData()!)).toMatchObject({ selector: 'body', x: 200, y: 150 })
    await page.evaluate(() =>
      window.drawingHarness.comments([
        {
          id: 'whole',
          canvasId: 'c',
          frameId: 'plain',
          snippet: '',
          x: 200,
          y: 150,
          from: 'Alice',
          text: 'Whole frame',
          at: 0,
        },
      ]),
    )
    const pinHandle = (await page.waitForSelector('[title="Alice: Whole frame"]'))!
    /* the pin's entrance animation owns its transform until it ends */
    await pinHandle.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    const pin = (await pinHandle.boundingBox())!
    expect(Math.abs(pin.x + pin.width / 2 - (box.x + box.width / 2))).toBeLessThan(3)
    expect(Math.abs(pin.y + pin.height / 2 - (box.y + box.height / 2))).toBeLessThan(3)
    await page.keyboard.press('Escape')
    await page.keyboard.press('c')
    await page.mouse.click(text.x + 10, text.y + text.height / 2)
    await page.waitForSelector('textarea[placeholder="Leave a comment on this element…"]')
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement?.selector)).toBe('#a')
  })

  it("comments on a frame filled by its layers from the frame's name", async () => {
    await seedFrames([
      {
        id: 'full',
        updatedBy: 'User',
        canvasId: 'c',
        pageId: 'first',
        name: 'Full',
        x: 30,
        y: 30,
        width: 400,
        height: 300,
        createdAt: 0,
        updatedAt: 0,
        html: '<body style="margin:0"><div id="hero" style="width:400px;height:300px;background:#eee"></div></body>',
      },
    ])
    await page.waitForSelector('iframe[title="Full"]')
    await page.keyboard.press('c')
    const title = (await (await page.waitForSelector('[data-frame-title]'))!.boundingBox())!
    /* hovering the name outlines the whole frame */
    await page.mouse.move(title.x + 4, title.y + title.height / 2)
    await page.waitForSelector('[data-frame-comment-hover]')
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForSelector('textarea[placeholder="Leave a comment on this frame…"]')
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement)).toBeNull()
    const posted = page.waitForRequest((req) => req.url().endsWith('/api/frames/full/comments'))
    await page.keyboard.type('The whole hero')
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    expect(JSON.parse((await posted).postData()!)).toMatchObject({ selector: 'body', x: 12, y: 12 })
    /* leaving the name takes the outline away */
    await page.mouse.move(title.x + 4, title.y - 40)
    await page.waitForFunction(() => !document.querySelector('[data-frame-comment-hover]'))
  })

  it('drags a comment pin off its element onto the canvas, onto the frame, and back onto an element', async () => {
    await seedFrames([
      {
        id: 'plain',
        updatedBy: 'User',
        canvasId: 'c',
        pageId: 'first',
        name: 'Plain',
        x: 30,
        y: 30,
        width: 400,
        height: 300,
        createdAt: 0,
        updatedAt: 0,
        html: '<p id="a" data-doop-id="aaa000" style="margin:0;width:120px">Alpha</p>',
      },
    ])
    const handle = await page.waitForSelector('iframe[title="Plain"]')
    await (await handle!.contentFrame())!.waitForSelector('#a')
    const box = (await handle!.boundingBox())!
    /* a point inside the paragraph (120 design px wide under the body's 8px margin), at zoom 2 */
    const inText = { x: box.x + 100, y: box.y + 32 }
    const onElement = {
      id: 'moving',
      canvasId: 'c',
      frameId: 'plain',
      elementId: 'aaa000',
      snippet: '<p id="a">Alpha</p>',
      from: 'Alice',
      text: 'Move me',
      at: 0,
    }
    await page.evaluate((c) => window.drawingHarness.comments([c]), onElement)
    const pinBox = async () => {
      const pin = (await page.waitForSelector('[title="Alice: Move me"]'))!
      await pin.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
      return (await pin.boundingBox())!
    }
    const home = await pinBox()
    /* a comment with no recorded origin sits at the element's top-left: the body's 8px margin, at zoom 2 */
    expect(Math.abs(home.x + home.width / 2 - (box.x + 16))).toBeLessThan(8)
    let pin = home

    /* onto empty canvas, right of the frame: the ghost rides along, the pin hides */
    await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width + 100, box.y + 100, { steps: 6 })
    await page.waitForSelector('[data-comment-drag]')
    expect(await page.$eval('[title="Alice: Move me"]', (el) => getComputedStyle(el).opacity)).toBe('0')
    const ghost = (await (await page.$('[data-comment-drag]'))!.boundingBox())!
    expect(Math.abs(ghost.x + ghost.width / 2 - (box.x + box.width + 100))).toBeLessThan(3)
    expect(Math.abs(ghost.y + ghost.height / 2 - (box.y + 100))).toBeLessThan(3)
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('[data-comment-drag]'))
    expect(commentMoves).toHaveLength(1)
    /* world px at zoom 2: the frame's right edge is at 430, 100 screen px right of it is 50 more
       (the frame's box is measured to its 1px border, so the point may land a px over) */
    expect(commentMoves[0]).toMatchObject({ pageId: 'first' })
    expect(Math.abs(Number(commentMoves[0]!.x) - 480)).toBeLessThan(2)
    expect(Math.abs(Number(commentMoves[0]!.y) - 80)).toBeLessThan(2)
    /* no thread opened from the release */
    expect(await page.$('textarea[placeholder="Reply… (@doop to ask the agent)"]')).toBeNull()
    /* the room says where it went: a canvas pin now */
    const onCanvas = {
      ...onElement,
      frameId: undefined,
      elementId: undefined,
      snippet: '',
      pageId: 'first',
      x: 480,
      y: 80,
    }
    await page.evaluate((c) => window.drawingHarness.comments([c]), onCanvas)
    pin = await pinBox()
    expect(Math.abs(pin.x + pin.width / 2 - (box.x + box.width + 100))).toBeLessThan(3)

    /* onto the frame's own background: a comment on the frame as a whole, at that point */
    await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('[data-comment-drag]'))
    expect(commentMoves).toHaveLength(2)
    expect(commentMoves[1]).toMatchObject({ frameId: 'plain', snippet: '' })
    expect(commentMoves[1]).not.toHaveProperty('selector')
    expect(commentMoves[1]).not.toHaveProperty('elementId')
    expect(Math.abs(Number(commentMoves[1]!.x) - 200)).toBeLessThan(2)
    expect(Math.abs(Number(commentMoves[1]!.y) - 150)).toBeLessThan(2)
    const onFrame = { ...onElement, elementId: undefined, snippet: '', x: 200, y: 150 }
    await page.evaluate((c) => window.drawingHarness.comments([c]), onFrame)
    pin = await pinBox()
    expect(Math.abs(pin.x + pin.width / 2 - (box.x + box.width / 2))).toBeLessThan(3)

    /* back onto the paragraph: an element comment again */
    await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2)
    await page.mouse.down()
    await page.mouse.move(inText.x, inText.y, { steps: 6 })
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('[data-comment-drag]'))
    expect(commentMoves).toHaveLength(3)
    /* the runtime's path for the server to stamp from, the id the element already wears,
       and the point for the server to fall back to */
    expect(commentMoves[2]).toMatchObject({ frameId: 'plain', selector: '#a', elementId: 'aaa000' })
    expect(Math.abs(Number(commentMoves[2]!.x) - 50)).toBeLessThan(3)
    await page.evaluate((c) => window.drawingHarness.comments([c]), onElement)
    pin = await pinBox()
    expect(Math.abs(pin.x - home.x)).toBeLessThan(3)
    expect(Math.abs(pin.y - home.y)).toBeLessThan(3)

    /* a click still opens the thread, and Esc mid-drag puts the pin back without a move */
    await page.mouse.click(pin.x + pin.width / 2, pin.y + pin.height / 2)
    await page.waitForSelector('textarea[placeholder="Reply… (@doop to ask the agent)"]')
    await page.keyboard.press('Escape')
    await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width + 100, box.y + 100, { steps: 4 })
    await page.waitForSelector('[data-comment-drag]')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-comment-drag]'))
    await page.mouse.up()
    expect(commentMoves).toHaveLength(3)
    expect(await page.$eval('[title="Alice: Move me"]', (el) => getComputedStyle(el).opacity)).toBe('1')
    /* the cancelled gesture leaves nothing behind: the next click opens the
       thread, and Escape (no longer swallowed) closes it again */
    await page.mouse.click(pin.x + pin.width / 2, pin.y + pin.height / 2)
    await page.waitForSelector('textarea[placeholder="Reply… (@doop to ask the agent)"]')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('textarea[placeholder="Reply… (@doop to ask the agent)"]'))

    /* ⇧C mid-drag hides the pins, but the one in hand finishes its move and
       leaves no ghost behind; ⇧C again brings the pins back */
    const toggleComments = async () => {
      await page.keyboard.down('Shift')
      await page.keyboard.press('KeyC')
      await page.keyboard.up('Shift')
    }
    await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width + 100, box.y + 100, { steps: 4 })
    await page.waitForSelector('[data-comment-drag]')
    await toggleComments()
    await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('[data-comment-drag]'))
    expect(commentMoves).toHaveLength(4)
    await page.waitForFunction(() => !document.querySelector('[title="Alice: Move me"]'))
    await toggleComments()
    await page.waitForSelector('[title="Alice: Move me"]')
  })
})
