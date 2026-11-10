import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import {
  drag,
  drawingPage,
  flowBoxes,
  flowImage,
  layerFrame,
  page,
  patchRequests,
  rectangle,
  saved,
  seedFrames,
  visibleDrawing,
} from './drawingPage'

describe.skipIf(!findBrowserPath())('drawing on the canvas', { timeout: 30_000 }, () => {
  drawingPage()

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

  it('waits for a pending document before picking the layer to drag', async () => {
    const box = (left: number) =>
      `<div style="position:absolute;left:${left}px;top:60px;width:100px;height:80px;background:coral"></div>`
    await seedFrames([layerFrame(box(50))])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const before = await visibleDrawing('Layers', 'body > div')
    /* turn the clock back so the frame's render throttle holds the next
       document for about a second, as a slow delivery would */
    await page.evaluate(() => {
      const now = Date.now.bind(Date)
      Date.now = () => now() - 1200
    })
    /* a collaborator puts a same-tag sibling in front of the box */
    await seedFrames([layerFrame(box(400) + box(50))])
    await page.mouse.move(before.x + 40, before.y + 40)
    await page.mouse.down()
    await page.mouse.move(before.x + 100, before.y + 40, { steps: 3 })
    await page.mouse.up()
    const left = (nth: number) =>
      visibleDrawing('Layers', `body > div:nth-of-type(${nth})`).then((rect) => rect.x - before.x)
    await expect.poll(() => left(2), { timeout: 5000 }).toBeCloseTo(60, 0)
    expect(await left(1)).toBeCloseTo(350, 0)
    expect(saved[0]?.html).toContain('left:400px;top:60px;width:100px;height:80px;background:coral"></div>')
  })

  it('drops the hover outline of a layer the document no longer has, without the pointer moving', async () => {
    const box =
      '<div id="box" style="position:absolute;left:50px;top:50px;width:100px;height:80px;background:teal"></div>'
    await seedFrames([layerFrame(box)])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 40, y: 20, zoom: 1 }))
    const target = await visibleDrawing('Layers', '#box')
    await page.mouse.move(target.x + 20, target.y + 20)
    await page.waitForSelector('[data-hover-outline]')
    /* the layer goes (⌫, a collaborator's save): the pointer has not moved,
       and the outline it was wearing must not outlive it */
    await seedFrames([layerFrame('')])
    await page.waitForFunction(() => !document.querySelector('[data-hover-outline]'))
    /* and what is under the pointer now gets the outline instead */
    await seedFrames([
      layerFrame('<p id="under" style="position:absolute;left:0;top:0;width:300px;height:200px">Under</p>'),
    ])
    await page.waitForFunction(() => document.querySelector('[data-hover-outline]')?.textContent === 'p')
  })
})
