import { describe, expect, it } from 'vitest'
import type { KeyInput } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { drawingPage, layerFrame, page, saved, seedFrames, visibleDrawing } from './drawingPage'

/* two loose rectangles and two stacked 22px apart */
const SHAPES =
  '<div id="a" style="position:absolute;left:10px;top:30px;width:98px;height:85px;background:#ddd"></div>' +
  '<div id="b" style="position:absolute;left:136px;top:30px;width:20px;height:20px;background:#ddd"></div>' +
  '<div id="c" style="position:absolute;left:205px;top:109px;width:51px;height:62px;background:#ddd"></div>' +
  '<div id="d" style="position:absolute;left:205px;top:25px;width:51px;height:62px;background:#ddd"></div>'

const html = () => saved.find((f) => f.id === 'layers')!.html

describe.skipIf(!findBrowserPath())('grouping drawn layers', { timeout: 30_000 }, () => {
  drawingPage()

  it('groups stacked shapes into an absolute flex column and ungroups them back in place', async () => {
    await seedFrames([layerFrame(SHAPES)])
    const iframe = (await (await page.waitForSelector('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('#d')
    const boxes = () =>
      iframe
        .$$eval('#c, #d', (els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect()
            return [el.id, r.x, r.y, r.width, r.height]
          }),
        )
        .then((rows) => rows.sort((m, n) => String(m[0]).localeCompare(String(n[0]))))
    const before = await boxes()
    await page.evaluate(() => window.drawingHarness.pickMany('layers', ['#c', '#d']))
    await page.keyboard.down('Meta')
    await page.keyboard.press('KeyG')
    await page.keyboard.up('Meta')
    await expect.poll(html).toContain('display: flex')
    const group =
      /<div data-doop-name="[^"]+" data-doop-drawing="group" style="([^"]+)">\s*<div id="(\w)"[^>]*><\/div>\s*<div id="(\w)"/.exec(
        html(),
      )
    expect(group?.[1]).toBe(
      'display: flex; flex-direction: column; align-items: start; gap: 22px; position: absolute; left: 205px; top: 25px; width: max-content',
    )
    /* flow order: the upper shape first */
    expect([group?.[2], group?.[3]]).toEqual(['d', 'c'])
    expect(html()).toContain(
      '<div id="d" style="width: 51px; height: 62px; background: rgb(221, 221, 221); flex-shrink: 0;">',
    )
    /* the frame shows the group before the shapes are measured again */
    await iframe.waitForSelector('[data-doop-name] > #d')
    expect(await boxes()).toEqual(before)

    const groupPath = (await page.evaluate(() => window.drawingHarness.state().selectedElement))!.selector
    await page.evaluate((selector) => window.drawingHarness.pick({ frameId: 'layers', selector }), groupPath)
    await page.keyboard.down('Meta')
    await page.keyboard.down('Shift')
    await page.keyboard.press('KeyG')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Meta')
    await expect.poll(html).not.toContain('display: flex')
    await iframe.waitForFunction(() => !document.querySelector('[data-doop-name]'))
    expect(await boxes()).toEqual(before)
    expect(html()).toMatch(/<div id="c" style="[^"]*position: absolute; left: 205px; top: 109px;/)
  })

  it('pins overlapping shapes in an absolute box at their spots', async () => {
    await seedFrames([
      layerFrame(
        '<div id="p" style="position:absolute;left:40px;top:40px;width:80px;height:80px;background:red"></div>' +
          '<div id="q" style="position:absolute;left:90px;top:70px;width:80px;height:80px;background:blue"></div>',
      ),
    ])
    const iframe = (await (await page.waitForSelector('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('#q')
    await page.evaluate(() => window.drawingHarness.pickMany('layers', ['#p', '#q']))
    await page.keyboard.down('Meta')
    await page.keyboard.press('KeyG')
    await page.keyboard.up('Meta')
    await expect.poll(html).toContain('left: 40px; top: 40px; width: 130px; height: 110px')
    expect(html()).toContain('id="q" style="position: absolute; left: 50px; top: 30px;')
    await iframe.waitForSelector('[data-doop-name] > #q')
    const q = await iframe.$eval('#q', (el) => [el.getBoundingClientRect().x, el.getBoundingClientRect().y])
    expect(q).toEqual([90, 70])
  })

  it('picks a group with a click and goes into it with a double-click', async () => {
    await seedFrames([layerFrame(SHAPES)])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    const frameEl = (await page.waitForSelector('iframe[title="Layers"]'))!
    const iframe = (await frameEl.contentFrame())!
    await iframe.waitForSelector('#d')
    await page.evaluate(() => window.drawingHarness.pickMany('layers', ['#c', '#d']))
    await page.keyboard.down('Meta')
    await page.keyboard.press('KeyG')
    await page.keyboard.up('Meta')
    await iframe.waitForSelector('[data-doop-drawing="group"] > #d')
    await page.evaluate(() => window.drawingHarness.pick(null))
    /* the screen point over #c */
    const at = async () => {
      const outer = (await frameEl.boundingBox())!
      const inner = await iframe.$eval('#c', (el) => el.getBoundingClientRect().toJSON() as DOMRect)
      return [outer.x + inner.x + 10, outer.y + inner.y + 10] as const
    }
    const picked = () => page.evaluate(() => window.drawingHarness.state().selectedElement?.selector ?? null)
    const [x, y] = await at()
    await page.mouse.click(x, y)
    await expect.poll(picked).toMatch(/div:nth-of-type\(\d\)$/)
    expect(await picked()).not.toBe('#c')
    await page.mouse.click(x, y, { count: 2 })
    await expect.poll(picked).toBe('#c')
    /* inside the group, a click picks the sibling, not the group again */
    const d = await iframe.$eval('#d', (el) => el.getBoundingClientRect().toJSON() as DOMRect)
    const outer = (await frameEl.boundingBox())!
    await page.mouse.click(outer.x + d.x + 10, outer.y + d.y + 10)
    await expect.poll(picked).toBe('#d')
  })

  /* a column group of two drawn shapes, #d over #c, as ⌘G makes it */
  const COLUMN = `<div data-doop-name="Group" data-doop-drawing="group" style="display: flex; flex-direction: column; align-items: start; gap: 22px; position: absolute; left: 205px; top: 25px; width: max-content">
    <div id="d" data-doop-drawing="rectangle" style="width: 51px; height: 62px; background: #ddd; flex-shrink: 0;"></div>
    <div id="c" data-doop-drawing="rectangle" style="width: 51px; height: 62px; background: #ddd; flex-shrink: 0;"></div></div>`

  /* a press on a layer inside a group drags the group: pick the layer first */
  async function dragLayer(selector: string, by: [number, number]) {
    const box = await visibleDrawing('Layers', selector)
    await page.evaluate((sel) => window.drawingHarness.pick({ frameId: 'layers', selector: sel }), selector)
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.keyboard.down('Alt') // no snapping: the drop lands where it was let go
    await page.mouse.move(x + by[0], y + by[1], { steps: 6 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    return box
  }

  it('reorders a layer inside a flex group, with no offset or override left on it', async () => {
    await seedFrames([layerFrame(COLUMN)])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    /* past the middle of the layer above: the slot before it */
    await dragLayer('#c', [0, -110])
    await expect.poll(html).toMatch(/<div id="c"[^>]*><\/div>\s*<div id="d"/)
    expect(html()).toContain(
      '<div id="c" data-doop-drawing="rectangle" style="width: 51px; height: 62px; background: #ddd; flex-shrink: 0;"></div>',
    )
  })

  it('takes a layer dragged out of a flex group onto the frame absolute, where it was let go', async () => {
    await seedFrames([layerFrame(COLUMN)])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    const iframe = (await (await page.waitForSelector('iframe[title="Layers"]'))!.contentFrame())!
    const start = await iframe.$eval('#c', (el) => el.getBoundingClientRect().toJSON() as DOMRect)
    await dragLayer('#c', [200, 100])
    /* out of the group: the last child of the body, on top */
    await expect.poll(html).toMatch(/<\/div><div id="c"[^>]*position: absolute/)
    const style = /<div id="c" [^>]*style="([^"]*)"/.exec(html())![1]!
    expect(style).toMatch(/position: absolute; left: [\d.]+px; top: [\d.]+px;/)
    expect(style).not.toContain('flex-shrink')
    expect(style).not.toMatch(/translate|!important/)
    await iframe.waitForFunction(() => document.querySelector('#c')?.parentElement === document.body)
    const end = await iframe.$eval('#c', (el) => el.getBoundingClientRect().toJSON() as DOMRect)
    expect(end.x - start.x).toBeCloseTo(200, -1)
    expect(end.y - start.y).toBeCloseTo(100, -1)
    /* the group keeps its other layer */
    expect(html()).toMatch(/data-doop-drawing="group"[^>]*>\s*<div id="d"/)
  })

  it('places a layer the Layers panel moves the way a canvas drag would', async () => {
    await seedFrames([
      layerFrame(
        '<div id="a" data-doop-drawing="rectangle" style="position:absolute;left:10px;top:30px;width:98px;height:85px"></div>' +
          COLUMN,
      ),
    ])
    const iframe = (await (await page.waitForSelector('iframe[title="Layers"]'))!.contentFrame())!
    await iframe.waitForSelector('#c')
    const placement = (selector: string, target: { selector: string; place: string }) =>
      page.evaluate(
        (selector, target) =>
          new Promise((resolve) => {
            const win = (document.querySelector('iframe[title="Layers"]') as HTMLIFrameElement).contentWindow!
            const reqId = Math.random()
            window.addEventListener('message', (e) => {
              if (e.data?.type === 'doop:layer-placement-result' && e.data.reqId === reqId) resolve(e.data.styles)
            })
            win.postMessage({ type: 'doop:layer-placement', reqId, selector, target }, '*')
          }),
        selector,
        target,
      )
    /* into the flex group: a flow item that keeps its size */
    expect(await placement('#a', { selector: '#d', place: 'after' })).toEqual({ order: '0', flexItem: true })
    /* out of it onto the frame: absolute where it shows now */
    expect(await placement('#c', { selector: '#a', place: 'after' })).toEqual({
      order: '0',
      absolute: { left: 205, top: 109 },
    })
    /* reordered among the body's own absolute layers: left as it is */
    expect(await placement('#a', { selector: '[data-doop-drawing="group"]', place: 'after' })).toBeNull()
  })

  it('shows the insertion line over a flex group while a shape on the frame is dragged, and drops it in', async () => {
    await seedFrames([
      layerFrame(
        COLUMN +
          '<div id="dot" data-doop-drawing="circle" style="position:absolute;left:400px;top:300px;width:40px;height:40px;border-radius:50%;background:#ddd;margin:0;"></div>',
      ),
    ])
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    const dot = await visibleDrawing('Layers', '#dot')
    const d = await visibleDrawing('Layers', '#d')
    const [x, y] = [dot.x + 20, dot.y + 20]
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.keyboard.down('Alt')
    /* just under #d: the slot between #d and #c */
    await page.mouse.move(d.x + 25, d.y + d.height + 6, { steps: 8 })
    await page.waitForSelector('[data-element-drop-indicator]')
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(html).toMatch(/<div id="d"[^>]*><\/div>\s*<div id="dot"[^>]*><\/div>\s*<div id="c"/)
    const style = /<div id="dot" [^>]*style="([^"]*)"/.exec(html())![1]!
    expect(style).toBe(
      'width: 40px; height: 40px; border-radius: 50%; background: rgb(221, 221, 221); margin: 0px; flex-shrink: 0;',
    )
    expect(await page.$('[data-element-drop-indicator]')).toBeNull()
  })

  /* ---- review fixes ---- */

  const ask = (type: string, payload: Record<string, unknown>) =>
    page.evaluate(
      (type, payload) =>
        new Promise((resolve) => {
          const win = (document.querySelector('iframe[title="Layers"]') as HTMLIFrameElement).contentWindow!
          const reqId = Math.random()
          window.addEventListener('message', (e) => {
            if (e.data?.type === `${type}-result` && e.data.reqId === reqId) resolve(e.data)
          })
          win.postMessage({ ...payload, type, reqId }, '*')
        }),
      type,
      payload,
    ) as Promise<Record<string, unknown>>

  async function press(key: KeyInput, shift = false) {
    await page.keyboard.down('Meta')
    if (shift) await page.keyboard.down('Shift')
    await page.keyboard.press(key)
    if (shift) await page.keyboard.up('Shift')
    await page.keyboard.up('Meta')
  }

  const rects = (iframe: Awaited<ReturnType<typeof frameOf>>, selector: string) =>
    iframe.$$eval(selector, (els) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect()
          return [el.id, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
        })
        .sort((m, n) => String(m[0]).localeCompare(String(n[0]))),
    )
  async function frameOf() {
    return (await (await page.waitForSelector('iframe[title="Layers"]'))!.contentFrame())!
  }

  it('reports where a positioned body with a margin places new drawings from', async () => {
    const frame = layerFrame('')
    await seedFrames([{ ...frame, html: frame.html.replace('<body>', '<body style="position:relative;margin:20px">') }])
    await frameOf()
    expect((await ask('doop:placement-origin', {})).origin).toEqual({ x: 20, y: 20, scale: { x: 1, y: 1 } })
  })

  it('pins overlapping older fixed drawings absolute in the group, where they were', async () => {
    await seedFrames([
      layerFrame(
        '<div id="p" style="position:fixed;left:40px;top:40px;width:80px;height:80px;background:red"></div>' +
          '<div id="q" style="position:fixed;left:90px;top:70px;width:80px;height:80px;background:blue"></div>',
      ),
    ])
    const iframe = await frameOf()
    await iframe.waitForSelector('#q')
    const before = await rects(iframe, '#p, #q')
    await page.evaluate(() => window.drawingHarness.pickMany('layers', ['#p', '#q']))
    await press('KeyG')
    await iframe.waitForSelector('[data-doop-drawing="group"] > #q')
    expect(html()).toContain('id="p" style="position: absolute; left: 0px; top: 0px;')
    expect(await rects(iframe, '#p, #q')).toEqual(before)
  })

  it('groups layers inside a scaled box without moving them, the gap in its own px', async () => {
    await seedFrames([
      layerFrame(
        '<div id="zoom" style="position:absolute;left:0;top:0;width:300px;height:200px;transform:scale(2);transform-origin:0 0">' +
          '<div id="m" style="position:absolute;left:10px;top:10px;width:10px;height:10px;background:red"></div>' +
          '<div id="n" style="position:absolute;left:30px;top:10px;width:10px;height:10px;background:blue"></div></div>',
      ),
    ])
    const iframe = await frameOf()
    await iframe.waitForSelector('#n')
    const before = await rects(iframe, '#m, #n')
    await page.evaluate(() => window.drawingHarness.pickMany('layers', ['#m', '#n']))
    await press('KeyG')
    await iframe.waitForSelector('[data-doop-drawing="group"] > #n')
    expect(html()).toContain('gap: 10px; position: absolute; left: 10px; top: 10px;')
    expect(await rects(iframe, '#m, #n')).toEqual(before)
  })

  it('ungroups a padded flex item at its own CSS width, and refuses a turned group', async () => {
    const group = (turn: string) =>
      `<div id="g" data-doop-drawing="group" style="display:flex;gap:10px;position:absolute;left:50px;top:40px;width:max-content${turn}">` +
      '<div id="u" style="width:100px;height:20px;padding:10px;flex-shrink:0;background:red"></div>' +
      '<div id="v" style="width:20px;height:20px;flex-shrink:0;background:blue"></div></div>'
    await seedFrames([layerFrame(group(''))])
    const iframe = await frameOf()
    await iframe.waitForSelector('#v')
    const before = await rects(iframe, '#u, #v')
    await page.evaluate(() => window.drawingHarness.pick({ frameId: 'layers', selector: '#g' }))
    await press('KeyG', true)
    await iframe.waitForFunction(() => document.querySelector('#u')?.parentElement === document.body)
    expect(html()).toMatch(/id="u" style="[^"]*width: 100px;[^"]*position: absolute; left: 50px; top: 40px;/)
    expect(await rects(iframe, '#u, #v')).toEqual(before)

    await seedFrames([layerFrame(group(';rotate:30deg'))])
    const turned = await frameOf()
    await turned.waitForSelector('#g[style*="rotate"]')
    await page.evaluate(() => window.drawingHarness.pick({ frameId: 'layers', selector: '#g' }))
    await press('KeyG', true)
    await new Promise((r) => setTimeout(r, 300))
    expect(html()).toContain('id="g"')
  })

  it('places an absolute drop by the layout box, not counting its transform twice', async () => {
    await seedFrames([
      layerFrame(
        COLUMN.replace(
          'id="c" data-doop-drawing="rectangle" style="',
          'id="c" data-doop-drawing="rectangle" style="transform: translateX(20px); ',
        ),
      ),
    ])
    const iframe = await frameOf()
    await iframe.waitForSelector('#c')
    const reply = await ask('doop:layer-placement', {
      selector: '#c',
      target: { selector: '[data-doop-drawing="group"]', place: 'after' },
    })
    expect(reply.styles).toEqual({ order: '0', absolute: { left: 205, top: 109 } })
  })
})
