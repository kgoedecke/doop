import type { Page } from 'puppeteer-core'
import { describe, expect, it } from 'vitest'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

describe.skipIf(!findBrowserPath())('editing multiple selected layers', () => {
  const pages = pagePerTest()
  const fill = 'input[aria-label="Fill color"]'

  const buttons =
    '<body><button id="a" style="background:red">A</button><button id="b" style="background:blue">B</button><button id="c" style="background:green">C</button></body>'

  async function pickThree(html = buttons) {
    const page = await pages.open()
    await page.setViewport({ width: 1600, height: 900 })
    const frame = canvasFrame({ id: 'f', name: 'Board', x: 0, y: 0, width: 320, height: 240 })
    frame.html = html
    await openCanvasPage(page, [frame])
    await page.click('[data-row-key="f"]')
    await page.click('[data-row-key="f|#a"]')
    await page.keyboard.down('Meta')
    await page.click('[data-row-key="f|#b"]')
    await page.click('[data-row-key="f|#c"]')
    await page.keyboard.up('Meta')
    await page.waitForSelector(fill)
    const saved: string[] = []
    page.on('request', (r) => {
      if (r.method() !== 'PATCH' || new URL(r.url()).pathname !== '/api/frames/f') return
      const { html } = JSON.parse(r.postData()!) as { html?: string }
      if (html) saved.push(html)
    })
    return { page, saved }
  }

  async function scrub(page: Page, label: string, dx: number) {
    const handle = (await page.waitForSelector(`label:has(input[aria-label="${label}"]) [data-scrub]`))!
    await handle.scrollIntoView()
    const box = (await handle.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y)
  }

  it.each(['hex field', 'color picker'])(
    'changes all three fills with the %s and restores all three with one Undo',
    async (control) => {
      const { page, saved } = await pickThree()
      async function colors(html: string) {
        return page.evaluate((html) => {
          const doc = new DOMParser().parseFromString(html, 'text/html')
          return Array.from(doc.querySelectorAll('button'), (el) => el.style.backgroundColor)
        }, html)
      }
      if (control === 'hex field') {
        await page.click(fill, { count: 3 })
        await page.keyboard.sendCharacter('ffff00')
        await page.keyboard.press('Enter')
      } else {
        await page.$eval('label:has(' + fill + ') input[type=color]', (picker) => {
          const input = picker as HTMLInputElement
          for (const color of ['#ff0000', '#ff9900', '#ffff00']) {
            // Native picker changes bypass React's value tracker.
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, color)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
          input.dispatchEvent(new Event('change', { bubbles: true }))
        })
      }
      await expect.poll(() => saved.length).toBe(1)
      expect(await colors(saved[0]!)).toEqual(Array(3).fill('rgb(255, 255, 0)'))
      await page.keyboard.down('Meta')
      await page.keyboard.press('z')
      await page.keyboard.up('Meta')
      await expect.poll(() => saved.length).toBe(2)
      expect(await colors(saved[1]!)).toEqual(['red', 'blue', 'green'])
    },
  )

  it('previews fill opacity for every color and cancels the whole scrub with Escape', async () => {
    const { page, saved } = await pickThree()
    await page.waitForSelector(fill + '[placeholder="Mixed"]')
    const frame = (await (await page.waitForSelector('iframe[title="Board"]'))!.contentFrame())!
    const colors = () =>
      frame.$$eval('button', (buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor))
    const original = await colors()
    await scrub(page, 'Fill opacity', -50)
    await expect.poll(colors).toEqual(['rgba(255, 0, 0, 0.5)', 'rgba(0, 0, 255, 0.5)', 'rgba(0, 128, 0, 0.5)'])
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect.poll(colors).toEqual(original)
    expect(saved).toEqual([])
  })
  it('restores a collaborator’s inline text sizes when a group scrub is cancelled', async () => {
    const html = ['a', 'b', 'c']
      .map((id) => `<button id="${id}" style="font-size:12px"><span style="font-size:12px">${id}</span></button>`)
      .join('')
    const { page, saved } = await pickThree(html)
    const frame = (await (await page.waitForSelector('iframe[title="Board"]'))!.contentFrame())!
    const sizes = () => frame.$$eval('button span', (spans) => spans.map((span) => getComputedStyle(span).fontSize))
    await scrub(page, 'Font size', 8)
    await expect.poll(sizes).toEqual(['20px', '20px', '20px'])
    await page.$eval(
      'iframe[title="Board"]',
      (iframe, html) => {
        ;(iframe as HTMLIFrameElement).contentWindow!.postMessage({ type: 'doop:html', html }, '*')
      },
      html.replaceAll('span style="font-size:12px"', 'span title="remote" style="font-size:17px"'),
    )
    await frame.waitForSelector('span[title=remote]')
    expect(await sizes()).toEqual(['20px', '20px', '20px'])
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect.poll(sizes).toEqual(['17px', '17px', '17px'])
    expect(saved).toEqual([])
  })
})
