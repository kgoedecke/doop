import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import {
  drag,
  drawingPage,
  flowBoxes,
  layerFrame,
  page,
  patchRequests,
  rectangle,
  saved,
  seedFrames,
  visibleDrawing,
  waitForFrames,
} from './drawingPage'
import type { Frame } from '../shared/types'

describe.skipIf(!findBrowserPath())('drawing on the canvas', { timeout: 30_000 }, () => {
  drawingPage()

  it('cancels moving an element on Escape, pointer cancellation, and page changes', async () => {
    await page.click('[aria-label="Circle"]')
    await drag([250, 300], [330, 380])
    const [original] = await waitForFrames(1)
    for (const reason of ['escape', 'pointer', 'page']) {
      await page.mouse.move(290, 340)
      await page.mouse.down()
      await page.mouse.move(700, 300, { steps: 4 })
      /* a standalone element moves live, like a frame */
      await page.waitForFunction((x) => window.drawingHarness.state().frames[0]?.x !== x, {}, original!.x)
      if (reason === 'escape') await page.keyboard.press('Escape')
      else if (reason === 'pointer')
        await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })))
      else await page.evaluate(() => window.drawingHarness.page('second'))
      await page.mouse.up()
      /* and goes back where it was when the move is called off */
      await page.waitForFunction((x) => window.drawingHarness.state().frames[0]?.x === x, {}, original!.x)
      expect(saved).toEqual([original])
      if (reason === 'page') await page.evaluate(() => window.drawingHarness.page('first'))
    }
  })

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

  it('keeps a click a click when its hit test answers after the pointer has moved on', async () => {
    const source = layerFrame(
      rectangle + rectangle.replace('id="rect"', 'id="second"').replace('left:50px', 'left:250px'),
    )
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const first = await visibleDrawing('Layers', '#rect')
    const second = await visibleDrawing('Layers', '#second')
    await page.mouse.click(first.x + 40, first.y + 40)
    await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.selector === '#rect')
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 350)))
    /* a loaded machine: the frame answers the next press only after the
       button is up and the pointer is on its way to another element */
    await page.evaluate(() => (window.heldMoveHits = []))
    await page.mouse.click(first.x + 40, first.y + 40)
    await page.waitForFunction(() => !!window.heldMoveHits?.length)
    /* the travel reaches the canvas while the frame is slow to route input;
       sent here directly, as the iframe would otherwise take it */
    await page.evaluate(
      (x, y) => {
        document.body.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y }),
        )
        const held = window.heldMoveHits ?? []
        window.heldMoveHits = null
        for (const event of held)
          window.dispatchEvent(new MessageEvent('message', { data: event.data, source: event.source }))
      },
      second.x + 40,
      second.y + 40,
    )
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 350)))
    expect(await page.evaluate(() => window.drawingHarness.state().selectedElement?.selector)).toBe('#rect')
    /* the next press waits for whatever the click left running, so once it
       lands nothing from the click is still on its way */
    await page.mouse.click(second.x + 40, second.y + 40)
    await page.waitForFunction(() => window.drawingHarness.state().selectedElement?.selector === '#second')
    expect(patchRequests).toBe(0)
    expect(saved[0]?.html).toBe(source.html)
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

  it('drags every picked layer together, as one save and one undo step, from a press inside one of them', async () => {
    const source = layerFrame(
      rectangle +
        '<div id="box" style="position:absolute;left:300px;top:60px;width:120px;height:90px;background:teal">' +
        '<p id="label" style="margin:0;padding:20px">Two</p></div>' +
        '<p id="sibling" style="margin:0">Keep me</p>',
    )
    await seedFrames([source])
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 })
      window.drawingHarness.selectFrames(['layers'])
      window.drawingHarness.pickMany('layers', ['#box', '#rect'])
    })
    const rect = await visibleDrawing('Layers', '#rect')
    const box = await visibleDrawing('Layers', '#box')
    /* the press lands on the label inside the picked box */
    await page.mouse.move(box.x + 30, box.y + 30)
    await page.mouse.down()
    await page.mouse.move(box.x + 70, box.y + 55, { steps: 5 })
    await expect.poll(async () => (await visibleDrawing('Layers', '#box')).x).toBeCloseTo(box.x + 40, 0)
    /* the other picked layer previews the same travel, with no save yet */
    expect((await visibleDrawing('Layers', '#rect')).x).toBeCloseTo(rect.x + 40, 0)
    expect(patchRequests).toBe(0)
    await page.mouse.up()
    await expect.poll(() => patchRequests).toBe(1)
    expect((await visibleDrawing('Layers', '#box')).y).toBeCloseTo(box.y + 25, 0)
    expect((await visibleDrawing('Layers', '#rect')).y).toBeCloseTo(rect.y + 25, 0)
    expect(saved[0]!.html).toContain('<p id="sibling" style="margin:0">Keep me</p>')
    /* the pick stands, the pressed layer now its primary */
    const state = await page.evaluate(() => window.drawingHarness.state())
    expect(state.selectedElement?.selector).toBe('#box')
    expect(state.selectedElements).toEqual(['#rect', '#box'])
    await page.evaluate(() => window.drawingHarness.undo())
    await expect.poll(async () => (await visibleDrawing('Layers', '#rect')).x).toBeCloseTo(rect.x, 0)
    expect((await visibleDrawing('Layers', '#box')).x).toBeCloseTo(box.x, 0)
  })

  it('drags a drawing picked with other layers together with them', async () => {
    const source = layerFrame(
      rectangle +
        '<div id="shape" data-doop-drawing="rectangle" data-name="Rectangle" style="position:absolute;left:300px;top:60px;width:60px;height:40px;background:red"></div>',
    )
    await seedFrames([source])
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 })
      window.drawingHarness.selectFrames(['layers'])
      window.drawingHarness.pickMany('layers', ['#rect', '#shape'])
    })
    const rect = await visibleDrawing('Layers', '#rect')
    const shape = await visibleDrawing('Layers', '#shape')
    /* a travel that lines the shape up with none of its sibling's edges, so no snap */
    await drag([shape.x + 20, shape.y + 20], [shape.x + 60, shape.y + 50])
    await expect.poll(() => patchRequests).toBe(1)
    expect((await visibleDrawing('Layers', '#shape')).x).toBeCloseTo(shape.x + 40, 0)
    expect((await visibleDrawing('Layers', '#rect')).x).toBeCloseTo(rect.x + 40, 0)
    expect((await visibleDrawing('Layers', '#rect')).y).toBeCloseTo(rect.y + 30, 0)
    const state = await page.evaluate(() => window.drawingHarness.state())
    expect(state.selectedElements).toEqual(['#rect', '#shape'])
  })

  it('moves a picked parent once with its picked child, whatever order the pick names them in', async () => {
    const source = layerFrame(
      rectangle +
        '<div id="box" style="position:absolute;left:300px;top:60px;width:120px;height:90px;background:teal">' +
        '<div id="child" style="position:absolute;left:10px;top:10px;width:30px;height:30px;background:gold"></div></div>',
    )
    await seedFrames([source])
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 })
      window.drawingHarness.selectFrames(['layers'])
      window.drawingHarness.pickMany('layers', ['#child', '#box', '#rect'])
    })
    const rect = await visibleDrawing('Layers', '#rect')
    const box = await visibleDrawing('Layers', '#box')
    const child = await visibleDrawing('Layers', '#child')
    await drag([rect.x + 40, rect.y + 40], [rect.x + 80, rect.y + 40])
    await expect.poll(() => patchRequests).toBe(1)
    expect((await visibleDrawing('Layers', '#box')).x).toBeCloseTo(box.x + 40, 0)
    /* the child rides its parent and is not moved a second time on its own */
    expect((await visibleDrawing('Layers', '#child')).x).toBeCloseTo(child.x + 40, 0)
    expect(saved[0]!.html).not.toMatch(/id="child"[^>]*translate/)
  })

  it('leaves the rest of a pick where it is when Escape cancels the drag', async () => {
    const source = layerFrame(
      rectangle +
        '<div id="box" style="position:absolute;left:300px;top:60px;width:120px;height:90px;background:teal"></div>',
    )
    await seedFrames([source])
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 })
      window.drawingHarness.selectFrames(['layers'])
      window.drawingHarness.pickMany('layers', ['#rect', '#box'])
    })
    const rect = await visibleDrawing('Layers', '#rect')
    const box = await visibleDrawing('Layers', '#box')
    await page.mouse.move(rect.x + 40, rect.y + 40)
    await page.mouse.down()
    await page.mouse.move(rect.x + 80, rect.y + 40, { steps: 5 })
    await expect.poll(async () => (await visibleDrawing('Layers', '#box')).x).toBeCloseTo(box.x + 40, 0)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await visibleDrawing('Layers', '#box')).x).toBeCloseTo(box.x, 0)
    expect((await visibleDrawing('Layers', '#rect')).x).toBeCloseTo(rect.x, 0)
    await page.mouse.up()
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(patchRequests).toBe(0)
    expect(saved[0]!.html).toBe(source.html)
  })

  it('moves only the layer pressed when it is not part of the pick', async () => {
    const source = layerFrame(
      rectangle +
        '<div id="box" style="position:absolute;left:300px;top:60px;width:120px;height:90px;background:teal"></div>' +
        '<div id="loose" style="position:absolute;left:50px;top:300px;width:80px;height:80px;background:plum"></div>',
    )
    await seedFrames([source])
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 })
      window.drawingHarness.selectFrames(['layers'])
      window.drawingHarness.pickMany('layers', ['#rect', '#box'])
    })
    const rect = await visibleDrawing('Layers', '#rect')
    const loose = await visibleDrawing('Layers', '#loose')
    await drag([loose.x + 40, loose.y + 40], [loose.x + 80, loose.y + 40])
    await expect.poll(() => patchRequests).toBe(1)
    expect((await visibleDrawing('Layers', '#loose')).x).toBeCloseTo(loose.x + 40, 0)
    expect((await visibleDrawing('Layers', '#rect')).x).toBeCloseTo(rect.x, 0)
    const state = await page.evaluate(() => window.drawingHarness.state())
    expect(state.selectedElements).toEqual(['#loose'])
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
    // ⌥ once the drag is under way: the exact delta, with no snap to the sibling
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.keyboard.down('Alt')
    await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 35, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(() => patchRequests).toBe(1)
    const after = await visibleDrawing('Layers', '#rect')
    expect(after.x - before.x).toBeCloseTo(60, 0)
    expect(after.y - before.y).toBeCloseTo(35, 0)
    expect(after.width).toBeCloseTo(before.width, 0)
    expect(await visibleDrawing('Layers', '#sibling')).toEqual(sibling)
    expect(saved[0]!.html).toContain('transform: rotate(10deg)')
  })

  it('⌥⇧-drags a copy of the picked layer, leaving the original, as one undo step', async () => {
    const source = layerFrame(
      '<div id="rect" data-doop-id="keep" style="position:absolute;left:40px;top:40px;width:100px;height:80px;background:coral"></div>',
    )
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    await page.evaluate(() => window.drawingHarness.pick({ frameId: 'layers', selector: '#rect' }))
    const before = await visibleDrawing('Layers', '#rect')
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    // 2px short of the frame's centre line: the copy snaps onto it, ⌥ held or not
    await drag([before.x + 50, before.y + 40], [before.x + 308, before.y + 140])
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    await expect.poll(() => patchRequests).toBe(1)
    expect(saved).toHaveLength(1)
    const [original, copy] = await page.evaluate((html) => {
      const divs = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('div')]
      return divs.map((el) => ({ id: el.id, doopId: el.getAttribute('data-doop-id'), style: el.getAttribute('style') }))
    }, saved[0]!.html)
    expect(original).toMatchObject({ id: 'rect', doopId: 'keep' })
    expect(original!.style).toContain('left:40px')
    expect(copy).toMatchObject({ id: 'rect-copy', doopId: null })
    const moved = await visibleDrawing('Layers', '#rect-copy')
    expect(moved.x - before.x).toBeCloseTo(260, 0)
    expect(moved.y - before.y).toBeCloseTo(100, 0)
    expect(await visibleDrawing('Layers', '#rect')).toEqual(before)
    const state = await page.evaluate(() => window.drawingHarness.state())
    expect(state.frames).toHaveLength(1)
    expect(state.selectedElement?.selector).not.toBe('#rect')
    await page.evaluate(() => window.drawingHarness.undo())
    await expect.poll(() => saved[0]!.html).toBe(source.html)
  })

  it.each(['canvas', 'frame'])('⌥⇧-drags a copy of the picked layer off its frame onto the %s', async (onto) => {
    /* a source rule with !important, carried along, must not beat the drop's placement */
    const source = layerFrame(
      '<style>.card { position:absolute !important; left:40px !important }</style><div id="rect" class="card" data-doop-id="keep" style="position:absolute;left:40px;top:40px;width:100px;height:80px;background:coral"></div>',
    )
    /* a positioned, margined body must not shift a copy dropped into it */
    const other: Frame = {
      ...layerFrame('<style>body { position:relative; margin:20px !important }</style><p style="margin:0">Other</p>'),
      id: 'other',
      name: 'Other',
      x: 900,
      y: 50,
      width: 250,
      height: 300,
    }
    await seedFrames(onto === 'frame' ? [source, other] : [source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    await page.evaluate(() => window.drawingHarness.pick({ frameId: 'layers', selector: '#rect' }))
    const before = await visibleDrawing('Layers', '#rect')
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await page.mouse.move(before.x + 50, before.y + 40)
    await page.mouse.down()
    // world x 110 → 863: clear of every edge, so nothing snaps
    await page.mouse.move(before.x + 803, before.y + 70, { steps: 8 })
    await page.waitForSelector(
      onto === 'frame' ? '[data-drawing-drop-target="other"]' : 'iframe[title="Moving drawing"]',
    )
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    if (onto === 'canvas') {
      await expect.poll(() => saved.length).toBe(2)
      const copy = saved[1]!
      expect(copy).toMatchObject({ x: 863, y: 120, width: 100, height: 80, pageId: 'first' })
      expect(copy.html).toContain('data-doop-canvas-element')
      expect(copy.html).not.toContain('data-doop-id')
    } else {
      await expect.poll(() => patchRequests).toBe(1)
      expect(saved.find((f) => f.id === 'other')!.html).not.toContain('data-doop-id')
      const dest = (await (await page.$('iframe[title="Other"]'))!.contentFrame())!
      await dest.waitForSelector('#rect')
      expect(
        await dest.$eval('#rect', (el) => {
          const box = el.getBoundingClientRect()
          return { x: box.x, y: box.y, width: box.width, height: box.height }
        }),
      ).toEqual({ x: -37, y: 70, width: 100, height: 80 })
    }
    /* the source never changed: the original is still there, in its place */
    expect(saved.find((f) => f.id === 'layers')!.html).toBe(source.html)
    expect(await visibleDrawing('Layers', '#rect')).toEqual(before)
    expect(await (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!.$$('#rect-copy')).toHaveLength(0)
    await page.evaluate(() => window.drawingHarness.undo())
    if (onto === 'canvas') await expect.poll(() => saved.length).toBe(1)
    else await expect.poll(() => saved.find((f) => f.id === 'other')!.html).toBe(other.html)
  })

  it('⌥⇧-drags a copy out of a turned frame from where the layer shows', async () => {
    const source: Frame = {
      ...layerFrame(
        '<div id="rect" style="position:absolute;left:40px;top:40px;width:100px;height:80px;background:coral"></div>',
      ),
      rotation: 90,
    }
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    await page.evaluate(() => window.drawingHarness.pick({ frameId: 'layers', selector: '#rect' }))
    /* the frame turns a quarter about its centre (420, 300): the layer's
       centre (90, 80) in it shows at (590, 40) on the canvas, screen (630, 60) */
    await visibleDrawing('Layers', '#rect')
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await drag([630, 60], [1080, 60])
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    await expect.poll(() => saved.length).toBe(2)
    /* unturned, centred where it was let go: 450px right of where it showed */
    expect(saved[1]).toMatchObject({ x: 990, y: 0, width: 100, height: 80 })
  })

  it('⌥⇧-drags a copy that keeps the rules styling the original by its id', async () => {
    const source = layerFrame(
      '<style>#rect { position:absolute; left:40px; top:40px; width:100px; height:80px; background:coral }</style><div id="rect"></div>',
    )
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    await page.evaluate(() => window.drawingHarness.pick({ frameId: 'layers', selector: '#rect' }))
    const before = await visibleDrawing('Layers', '#rect')
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await drag([before.x + 50, before.y + 40], [before.x + 250, before.y + 140])
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    await expect.poll(() => patchRequests).toBe(1)
    /* styled from the start, the copy moves freely to where it was let go */
    const copy = await visibleDrawing('Layers', '#rect-copy')
    expect(copy.x - before.x).toBeCloseTo(200, 0)
    expect(copy.y - before.y).toBeCloseTo(100, 0)
    expect(copy.width).toBeCloseTo(100, 0)
    expect(copy.height).toBeCloseTo(80, 0)
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    expect(await iframe.$eval('#rect-copy', (el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 127, 80)')
  })

  it('⌥⇧-drags a copy of a flow layer onto the room it takes below the original', async () => {
    const source = layerFrame(`<style>body { display:flex; flex-direction:column; padding:40px }</style>
      <h1 data-doop-id="keep" style="margin:0;font-size:40px">Title</h1><p style="margin:0">Lede</p>`)
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    await page.evaluate(() => window.drawingHarness.pick({ frameId: 'layers', selector: 'body > h1' }))
    const title = await visibleDrawing('Layers', 'body > h1')
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await drag([title.x + 20, title.y + 10], [title.x + 20, title.y + 10 + title.height])
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    await expect.poll(() => patchRequests).toBe(1)
    const [original, copy] = await page.evaluate((html) => {
      const h1s = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('h1')]
      return h1s.map((el) => ({ doopId: el.getAttribute('data-doop-id'), next: el.nextElementSibling?.tagName }))
    }, saved[0]!.html)
    expect(original).toEqual({ doopId: 'keep', next: 'H1' })
    expect(copy).toEqual({ doopId: null, next: 'P' })
    expect((await page.evaluate(() => window.drawingHarness.state())).selectedElement?.selector).toMatch(
      /h1:nth-of-type\(2\)$/,
    )
  })

  it('⌥⇧-drags a copy of a flow layer into another box, and Escape leaves nothing behind', async () => {
    const source = layerFrame(flowBoxes)
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    await page.evaluate(() => window.drawingHarness.pick({ frameId: 'layers', selector: '#photo' }))
    const photo = await visibleDrawing('Layers', '#photo')
    const into = await visibleDrawing('Layers', '#into')
    const iframe = (await (await page.$('iframe[title="Layers"]'))!.contentFrame())!
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await page.mouse.move(photo.x + 30, photo.y + 20)
    await page.mouse.down()
    await page.mouse.move(into.x + 50, into.y + 40, { steps: 5 })
    await page.waitForSelector('[data-element-drop-indicator]')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect.poll(() => iframe.$$eval('img', (imgs) => imgs.length)).toBe(1)
    expect(patchRequests).toBe(0)
    await drag([photo.x + 30, photo.y + 20], [into.x + 50, into.y + 40])
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    await expect.poll(() => patchRequests).toBe(1)
    await iframe.waitForSelector('#into > img')
    expect(await iframe.$$eval('#from > img#photo', (imgs) => imgs.length)).toBe(1)
    expect(saved).toHaveLength(1)
  })

  it("drags a layer inside a turned frame along the document's own axes, picking the layer under the pointer", async () => {
    const source = { ...layerFrame(rectangle), rotation: 90 }
    await seedFrames([source])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const iframe = (await (await page.waitForSelector('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('#rect')
    /* the 700×500 frame at (70,50) turned a quarter has its centre at (420,300)
       in the world; the layer's design centre (100,100) lands at (570,50),
       which the viewport's offset puts at (610,70) on screen */
    await drag([610, 70], [610, 130])
    await expect.poll(() => patchRequests).toBe(1)
    /* 60px down the screen is 60px along the turned document's x: the layer
       itself moved, not the frame, and only along that axis */
    expect(saved[0]).toMatchObject({ x: 70, y: 50 })
    expect(saved[0]!.html).toMatch(/translate: 60px (0|[0-9.e-]+)px/)
    const moved = await iframe.$eval('#rect', (el) => el.getBoundingClientRect().toJSON() as DOMRect)
    expect(moved.x).toBeCloseTo(110, 0)
    expect(moved.y).toBeCloseTo(60, 0)
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
})
