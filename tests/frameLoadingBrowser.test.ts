import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import {
  commentMoves,
  drag,
  drawingPage,
  layerFrame,
  page,
  patchRequests,
  saved,
  seedFrames,
  visibleDrawing,
} from './drawingPage'

function frameAt(id: string, x: number) {
  return {
    ...layerFrame('<p id="text" style="width:180px;margin:20px">Edit me</p>'),
    id,
    name: id,
    x,
    y: 60,
    width: 240,
    height: 180,
  }
}

describe.skipIf(!findBrowserPath())('loading frames on the canvas', { timeout: 30_000 }, () => {
  drawingPage()

  it('loads the top of a tall page before frames outside its opening view', async () => {
    const titlesAtFirstRender = await page.evaluate(
      async (frames) => {
        return new Promise<string[]>((resolve) => {
          function onRender(event: MessageEvent) {
            if (event.data?.type !== 'doop:html-result') return
            window.removeEventListener('message', onRender)
            resolve([...document.querySelectorAll<HTMLIFrameElement>('iframe[data-doop-frame]')].map((f) => f.title))
          }
          window.addEventListener('message', onRender)
          window.drawingHarness.seed({
            id: 'opening',
            name: 'Draw',
            frames: frames.map((frame) => ({ ...frame, canvasId: 'opening' })),
            pages: [{ id: 'first', name: 'Main' }],
            createdAt: 0,
            updatedAt: 0,
          })
        })
      },
      [
        { ...frameAt('far', 2400), y: 14_000 },
        { ...frameAt('visible', 2400), y: 2000 },
        { ...frameAt('near', 2400), y: 4000 },
      ],
    )
    expect(titlesAtFirstRender).toEqual(['visible'])
    await visibleDrawing('near', '#text')
    await visibleDrawing('far', '#text')
  })

  it('starts visible frames in batches when zooming out during initial loading', async () => {
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 })
      const held: MessageEvent[] = []
      function holdBoot(event: MessageEvent) {
        if (event.data?.type !== 'doop:frame-ready') return
        event.stopImmediatePropagation()
        held.push(event)
      }
      window.addEventListener('message', holdBoot, true)
      window.addEventListener(
        'release-zoom-frames',
        () => {
          window.removeEventListener('message', holdBoot, true)
          for (const { data, source } of held) window.dispatchEvent(new MessageEvent('message', { data, source }))
        },
        { once: true },
      )
    })
    await seedFrames([
      frameAt('start', 100),
      ...Array.from({ length: 60 }, (_, i) => frameAt(`overview-${i}`, 2000 + i * 170)),
    ])
    await page.waitForSelector('iframe[title="start"]')
    expect(await page.$('iframe[title="overview-0"]')).toBeNull()

    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 0.08 }))
    await page.waitForSelector('iframe[title="overview-0"]')
    expect(await page.$$eval('iframe[data-doop-frame]', (frames) => frames.length)).toBeLessThanOrEqual(24)

    await page.evaluate(() => window.dispatchEvent(new Event('release-zoom-frames')))
    await visibleDrawing('overview-59', '#text')
  })

  async function seedWaitingFrame(target: ReturnType<typeof frameAt>) {
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 })
      window.addEventListener(
        'message',
        (event) => {
          if (event.data?.type !== 'doop:frame-ready') return
          const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe[title^="busy-"]')].find(
            (iframe) => iframe.contentWindow === event.source,
          )
          if (frame) event.stopImmediatePropagation()
        },
        true,
      )
    })
    const busy = Array.from({ length: 24 }, (_, i) => ({ ...frameAt(`busy-${i}`, 100), y: i * 24, height: 20 }))
    await seedFrames([...busy, target])
    await page.waitForSelector('iframe[title="busy-23"]')
    expect(await page.$(`iframe[title="${target.name}"]`)).toBeNull()
  }

  it('exports a queued frame and a layer with their rendered contents', async () => {
    const target = {
      ...frameAt('destination', 10_000),
      html: '<p id="text"></p><script>document.querySelector("#text").textContent = "Rendered text"</script>',
    }
    await seedWaitingFrame(target)
    const svgs = await page.evaluate(async (id) => {
      const downloads: Blob[] = []
      const createObjectURL = URL.createObjectURL
      URL.createObjectURL = (blob) => {
        if (blob instanceof Blob && blob.type.startsWith('image/svg+xml')) downloads.push(blob)
        return createObjectURL(blob)
      }
      try {
        await Promise.all([
          window.drawingHarness.exportSvg(id),
          window.drawingHarness.exportSvg(id, { selector: '#text', name: 'Text' }),
        ])
        return await Promise.all(downloads.map((blob) => blob.text()))
      } finally {
        URL.createObjectURL = createObjectURL
      }
    }, target.id)
    expect(svgs).toHaveLength(2)
    expect(svgs.every((svg) => svg.includes('Rendered text'))).toBe(true)
  })

  it('applies arrow nudges queued before the selected layer is live', async () => {
    const target = {
      ...frameAt('destination', 10_000),
      html: '<p id="text" style="position:absolute;left:20px;top:30px;margin:0">Move me</p>',
    }
    await seedWaitingFrame(target)
    await page.evaluate((id) => {
      window.drawingHarness.pick({ frameId: id, selector: '#text' })
      window.drawingHarness.nudge(1, 0)
      window.drawingHarness.nudge(1, 0)
    }, target.id)
    await expect.poll(() => saved.find((frame) => frame.id === target.id)?.html).toContain('left: 22px')
  })

  it('undoes a nudge issued before the frame was ready', async () => {
    const target = {
      ...frameAt('destination', 10_000),
      html: '<p id="text" style="position:absolute;left:20px;top:30px;margin:0">Move me</p>',
    }
    await seedWaitingFrame(target)
    await page.evaluate(async (id) => {
      window.drawingHarness.pick({ frameId: id, selector: '#text' })
      window.drawingHarness.nudge(1, 0)
      await window.drawingHarness.undo()
    }, target.id)
    expect(patchRequests).toBe(2)
    expect(saved.find((frame) => frame.id === target.id)?.html).toBe(target.html)
  })

  it('undoes a formatting shortcut issued before the selected layer is live', async () => {
    const target = {
      ...frameAt('destination', 10_000),
      html: '<p id="text">Make me bold</p>',
    }
    await seedWaitingFrame(target)
    await page.evaluate(async (id) => {
      window.drawingHarness.pick({ frameId: id, selector: '#text' })
      window.drawingHarness.formatText('bold')
      await window.drawingHarness.undo()
    }, target.id)
    expect(patchRequests).toBe(2)
    expect(saved.find((frame) => frame.id === target.id)?.html).toBe(target.html)
  })

  it('anchors a dropped comment to the element in a queued frame', async () => {
    const target = {
      ...frameAt('destination', 1300),
      html: '<body style="margin:0"><div id="text" data-doop-id="aaa000" style="width:120px;height:100px">Target</div></body>',
    }
    await seedWaitingFrame(target)
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: -200, y: 0, zoom: 1 })
      window.drawingHarness.comments([
        {
          id: 'moving',
          canvasId: 'c',
          pageId: 'first',
          x: 500,
          y: 100,
          from: 'Alice',
          text: 'Move me',
          snippet: '',
          at: 0,
        },
      ])
    })
    const pin = (await page.waitForSelector('[title="Alice: Move me"]'))!
    await pin.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)))
    const box = (await pin.boundingBox())!
    expect(await page.$('iframe[title="destination"]')).toBeNull()
    const stage = (await (await page.$('.stage'))!.boundingBox())!
    await drag(
      [box.x + box.width / 2, box.y + box.height / 2],
      [stage.x + target.x - 200 + 40, stage.y + target.y + 40],
    )
    await expect
      .poll(() => commentMoves.at(-1))
      .toMatchObject({
        frameId: target.id,
        selector: '#text',
        elementId: 'aaa000',
      })
  })

  it('prioritizes a newly visible frame during background loading and keeps its live editor across pans', async () => {
    await page.evaluate(() => {
      window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 })
      const held: MessageEvent[] = []
      function holdBackground(event: MessageEvent) {
        if (event.data?.type !== 'doop:frame-ready') return
        const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe[title^="background-"]')].find(
          (iframe) => iframe.contentWindow === event.source,
        )
        if (!frame) return
        event.stopImmediatePropagation()
        held.push(new MessageEvent('message', { data: event.data, source: event.source }))
      }
      window.addEventListener('message', holdBackground, true)
      window.addEventListener(
        'release-background',
        () => {
          window.removeEventListener('message', holdBackground, true)
          for (const event of held) window.dispatchEvent(event)
        },
        { once: true },
      )
    })
    const target = frameAt('destination', 12_000)
    await seedFrames([
      target,
      frameAt('start', 100),
      ...Array.from({ length: 12 }, (_, i) => frameAt(`background-${i}`, 2000 + i * 300)).reverse(),
    ])
    await page.waitForSelector('iframe[title="background-0"]')
    expect(await page.$('iframe[title="background-11"]')).toBeNull()
    expect(await page.$('iframe[title="destination"]')).toBeNull()

    await page.mouse.move(850, 500)
    await page.mouse.wheel({ deltaX: 11_900 })
    const text = await visibleDrawing('destination', '#text')
    const iframe = await page.waitForSelector('iframe[title="destination"]')
    const doc = await iframe?.contentFrame()
    if (!iframe || !doc) throw new Error('Destination iframe did not open')

    await page.mouse.click(text.x + 20, text.y + 8, { count: 2, delay: 60 })
    await doc.waitForSelector('#text[contenteditable]')
    await page.evaluate(() => window.drawingHarness.viewport({ x: 0, y: 0, zoom: 1 }))
    expect(await iframe.evaluate((el) => el.isConnected)).toBe(true)
    expect(await iframe.contentFrame()).toBe(doc)
    await doc.waitForSelector('#text[contenteditable]')
    await page.keyboard.type(' updated')
    await page.keyboard.press('Escape')
    await expect.poll(() => saved.find((frame) => frame.id === 'destination')?.html).toContain('updated')

    await page.evaluate(() => window.dispatchEvent(new Event('release-background')))
    await visibleDrawing('background-11', '#text')
  })
})
