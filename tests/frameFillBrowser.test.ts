import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { Frame } from '../shared/types'
import type { DesignToken } from '../shared/designTokens'

/** The fixture's harness, as this file uses it (other files declare their own view of it). */
interface FillHarness {
  seed: (frame: Frame) => void
  inspectFrame: () => void
  tokens: (tokens: DesignToken[]) => void
  undo: () => Promise<void>
}
type FillWindow = { elementPanelHarness: FillHarness }

const FILL = 'input[aria-label="Fill color"]'
const OPACITY = 'input[aria-label="Fill opacity"]'

/** The frame Inspector's Fill: the frame's own background, edited with the
 *  element panel's Fill section through the live frame. */
describe.skipIf(!findBrowserPath())('frame fill', () => {
  const pages = pagePerTest()
  let page: Page
  let saved: Frame

  async function open(html: string) {
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Screen',
      x: 40,
      y: 60,
      width: 400,
      height: 300,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
      html,
    }
    await page.evaluate((frame) => (window as unknown as FillWindow).elementPanelHarness.seed(frame), saved)
    const frame = (await (await page.waitForSelector('iframe'))!.contentFrame())!
    await frame.waitForSelector('#content')
    await page.evaluate(() => (window as unknown as FillWindow).elementPanelHarness.inspectFrame())
    await page.waitForSelector(FILL)
    return frame
  }

  async function typeFill(value: string) {
    await page.click(FILL, { count: 3 })
    await page.keyboard.type(value)
    await page.keyboard.press('Enter')
  }

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(5_000)
    await page.setViewport({ width: 1000, height: 800 })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      if (new URL(request.url()).pathname === '/api/frames/f' && request.method() === 'PATCH') {
        saved = { ...saved, ...JSON.parse(request.postData()!) }
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) })
      } else await request.continue()
    })
    await page.goto(fixtureUrl('elementPanel.html'))
    await page.waitForFunction(() => 'elementPanelHarness' in window)
  }, 60_000)

  it('paints an unfilled frame on its body and saves it, undoably', async () => {
    const frame = await open('<!doctype html><html><head></head><body><p id="content">Hi</p></body></html>')
    expect(await page.$eval(FILL, (el) => (el as HTMLInputElement).value)).toBe('')

    await typeFill('ff0000')
    await frame.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 0, 0)')
    await expect.poll(() => saved.html).toMatch(/<body style="background-color: (rgb\(255, 0, 0\)|#ff0000);?"/)
    await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLInputElement).value === '#ff0000', {}, FILL)
    expect(await page.$eval(OPACITY, (el) => (el as HTMLInputElement).value)).toBe('100')

    await page.click(OPACITY, { count: 3 })
    await page.keyboard.type('50')
    await page.keyboard.press('Enter')
    await frame.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgba(255, 0, 0, 0.5)')
    await expect.poll(() => saved.html).toContain('rgba(255, 0, 0, 0.5)')

    /* edits a moment apart coalesce into one undo step, as an element's styles do */
    await page.evaluate(() => (window as unknown as FillWindow).elementPanelHarness.undo())
    await frame.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)')
    await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLInputElement).value === '', {}, FILL)
  }, 30_000)

  it('edits the root when only <html> paints the frame', async () => {
    const frame = await open(
      '<!doctype html><html><head><style>html { background: #00ff00 }</style></head><body><p id="content">Hi</p></body></html>',
    )
    await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLInputElement).value === '#00ff00', {}, FILL)

    await typeFill('0000ff')
    await frame.waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(0, 0, 255)')
    expect(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await expect.poll(() => saved.html).toMatch(/<html style="background-color: (rgb\(0, 0, 255\)|#0000ff);?"/)
  }, 30_000)

  it('binds the frame fill to a colour token', async () => {
    const frame = await open(
      '<!doctype html><html><head><style>:root { --brand: #123456 }</style></head><body style="background-color: #ffffff"><p id="content">Hi</p></body></html>',
    )
    await page.evaluate(() =>
      (window as unknown as FillWindow).elementPanelHarness.tokens([
        { name: '--brand', type: 'color', value: '#123456', order: 0, updatedAt: 0, updatedBy: 'Tester' },
      ]),
    )
    await page.click('label:has(input[aria-label="Fill color"]) button[aria-label="Use a token"]')
    await (await page.waitForSelector('[data-slot="popover-content"] [role="option"]'))!.click()
    await frame.waitForFunction(() => document.body.style.backgroundColor === 'var(--brand)')
    await expect.poll(() => saved.html).toContain('background-color: var(--brand)')
  }, 30_000)

  it('edits the root around a body that is only a centred column', async () => {
    const frame = await open(
      '<!doctype html><html><head><style>html { background: #111111 } body { background: #ffffff; width: 120px; margin: 0 auto }</style></head><body><p id="content">Hi</p></body></html>',
    )
    await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLInputElement).value === '#111111', {}, FILL)
    await typeFill('222222')
    await frame.waitForFunction(() => getComputedStyle(document.documentElement).backgroundColor === 'rgb(34, 34, 34)')
    expect(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 255, 255)')
  }, 30_000)

  it('edits a body that covers the frame even when the root is painted too', async () => {
    const frame = await open(
      '<!doctype html><html><head><style>html { background: #111111 } body { background: #eeeeee; margin: 0; min-height: 100vh }</style></head><body><p id="content">Hi</p></body></html>',
    )
    await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLInputElement).value === '#eeeeee', {}, FILL)
    await typeFill('333333')
    await frame.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(51, 51, 51)')
  }, 30_000)

  it('counts a transparent modern colour as unpainted', async () => {
    await open(
      '<!doctype html><html><head><style>html { background: #00aa00 } body { background: oklch(0 0 0 / 0) }</style></head><body><p id="content">Hi</p></body></html>',
    )
    await page.waitForFunction((sel) => (document.querySelector(sel) as HTMLInputElement).value === '#00aa00', {}, FILL)
  }, 30_000)

  it('replaces a gradient with the colour picked for the fill', async () => {
    const frame = await open(
      '<!doctype html><html><head></head><body style="background: linear-gradient(#ff0000, #0000ff)"><p id="content">Hi</p></body></html>',
    )
    await typeFill('00ff00')
    await frame.waitForFunction(
      () =>
        getComputedStyle(document.body).backgroundImage === 'none' &&
        getComputedStyle(document.body).backgroundColor === 'rgb(0, 255, 0)',
    )
    await expect.poll(() => saved.html).toContain('background-image: none')
  }, 30_000)

  it('offers the image fill of a frame painted with an image', async () => {
    const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')
    await open(
      `<!doctype html><html><head></head><body style="background-image: url('data:image/svg+xml,${svg}')"><p id="content">Hi</p></body></html>`,
    )
    await page.waitForSelector('button[aria-label="Image fill"]')
  }, 30_000)

  it('shows a token set through the background shorthand, and a colour replaces it', async () => {
    const frame = await open(
      '<!doctype html><html><head><style>:root { --surface: #abcdef }</style></head><body style="background: var(--surface)"><p id="content">Hi</p></body></html>',
    )
    await page.evaluate(() =>
      (window as unknown as FillWindow).elementPanelHarness.tokens([
        { name: '--surface', type: 'color', value: '#abcdef', order: 0, updatedAt: 0, updatedBy: 'Tester' },
      ]),
    )
    await page.waitForSelector('button[aria-label^="Detach from"]')
    await page.click('button[aria-label^="Detach from"]')
    await frame.waitForFunction(
      () =>
        document.body.style.background === '' &&
        getComputedStyle(document.body).backgroundColor === 'rgb(171, 205, 239)',
    )
  }, 30_000)
})
