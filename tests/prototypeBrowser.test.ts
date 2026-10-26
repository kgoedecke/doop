import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Frame as PuppeteerFrame, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import type { Canvas, Frame } from '../shared/types'

type Message = { type?: string; interaction?: { action?: string; target?: string } }
/* what tests/fixtures/prototype.html puts on window */
type Fixture = {
  messages: Message[]
  fixtureReady: boolean
  playerClosed: boolean
  seed: (canvas: Canvas) => void
  play: (frameId: string) => void
  playSynced: (frameId: string) => void
  editFrame: (id: string, html: string) => void
  addRawFrame: () => void
  mountStage: (prototypeMode: boolean) => void
}

const doc = (body: string) =>
  `<!doctype html><html><head><style>*{margin:0}button{display:block;width:160px;height:60px}</style></head><body>${body}</body></html>`

const frame = (id: string, body: string, x = 0): Frame => ({
  id,
  canvasId: 'c',
  pageId: 'p',
  name: id.toUpperCase(),
  x,
  y: 0,
  width: 400,
  height: 300,
  html: doc(body),
  createdAt: 0,
  updatedAt: 1,
  updatedBy: 'Test',
})

const CANVAS: Canvas = {
  id: 'c',
  name: 'Prototype',
  pages: [{ id: 'p', name: 'Flow' }],
  frames: [
    frame(
      'home',
      `<button id="go" data-doop-on="click" data-doop-action="navigate:detail" data-doop-transition="push-left" data-doop-duration="120">Open</button>
       <button id="help" data-doop-on="click" data-doop-action="overlay:menu">Help</button>
       <p id="blank" style="height:100px">Nothing here</p>`,
    ),
    frame('detail', `<button id="back" data-doop-on="click" data-doop-action="back">Back</button>`, 500),
    frame('menu', `<button id="close" data-doop-on="click" data-doop-action="close-overlay">Close</button>`, 1000),
  ],
  createdAt: 0,
  updatedAt: 0,
}

/* the review-fix regressions: repeated screens in the browser history, press
   releases, press scrolls, overlay-first Escape and live delay edits */
const FLOW: Canvas = {
  ...CANVAS,
  frames: [
    frame(
      'home',
      `<button id="go" data-doop-on="click" data-doop-action="navigate:detail">Open</button>
       <button id="hold" data-doop-on="press" data-doop-action="navigate:detail" data-doop-transition="dissolve" data-doop-duration="3000">Hold</button>
       <button id="help" data-doop-on="click" data-doop-action="overlay:menu">Help</button>
 <button id="peek" data-doop-on="press" data-doop-action="overlay:menu">Peek</button>
       <button id="jump" data-doop-on="press" data-doop-action="scroll-to:#end" data-doop-transition="instant">Jump</button>
       <div style="height:2000px"></div><p id="end">End</p>`,
    ),
    frame(
      'detail',
      `<button id="again" data-doop-on="click" data-doop-action="navigate:home">Home again</button>`,
      500,
    ),
    frame(
      'menu',
      `<button id="close" data-doop-on="click" data-doop-action="close-overlay">Close</button>
       <div data-doop-on="key:Escape" data-doop-action="navigate:detail"></div>
       <div data-doop-on="key:Enter" data-doop-action="navigate:gone"></div>`,
      1000,
    ),
  ],
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/* The first load transforms the app through a cold Vite dev server, which can
   take longer than the default test timeout on CI. */
describe.skipIf(!findBrowserPath())('prototype player', { timeout: 30_000 }, () => {
  let vite: ViteDevServer
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    vite = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await vite.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 700 })
    await page.goto(`${vite.resolvedUrls!.local[0]}tests/fixtures/prototype.html`)
    await page.waitForFunction(() => (window as unknown as Fixture).fixtureReady)
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await vite?.close()
  })

  async function screen(frameId: string): Promise<PuppeteerFrame> {
    /* the previous test's player may still be unmounting: wait for a live document */
    for (let attempt = 0; attempt < 40; attempt++) {
      const handle = await page.waitForSelector(`iframe[data-doop-proto-frame="${frameId}"]`)
      const content = await handle?.contentFrame()
      if (content && !content.detached && (await content.$('button').catch(() => null))) return content
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`screen ${frameId} never rendered`)
  }

  async function current() {
    return page.$eval('[data-proto-current]', (el) => el.textContent)
  }

  /* a trigger is live once the player has switched the frame's runtime on,
     a moment after the HTML lands — retry the click until it takes. The
     click is dispatched in the frame: the player scales its iframes, which
     puppeteer's point clicks do not map through */
  async function clickUntil(frame: PuppeteerFrame, selector: string, done: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await frame.$eval(selector, (el) => (el as HTMLElement).click())
      for (let wait = 0; wait < 5; wait++) {
        if (await done()) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw new Error(`clicking ${selector} never took effect`)
  }

  it('navigates on click, goes back, and opens and closes an overlay', async () => {
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), CANVAS)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    const home = await screen('home')
    expect(await current()).toBe('HOME')

    await clickUntil(home, '#go', async () => (await current()) === 'DETAIL')
    const detail = await screen('detail')
    /* the push transition settles and the outgoing screen unmounts */
    await page.waitForFunction(() => !document.querySelector('iframe[data-doop-proto-frame="home"]'))
    expect(await page.$$('iframe[data-doop-proto-frame]')).toHaveLength(1)

    await clickUntil(detail, '#back', async () => (await current()) === 'HOME')
    await page.waitForFunction(() => !document.querySelector('iframe[data-doop-proto-frame="detail"]'))

    const back = await screen('home')
    await clickUntil(back, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
    const menu = await screen('menu')
    await clickUntil(menu, '#close', async () => !(await page.$('[data-proto-overlay="menu"]')))

    /* the scrim closes an overlay too */
    await clickUntil(back, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
    await page.mouse.click(20, 20)
    await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
  })

  it('re-renders a frame edited live and flashes hotspots on a miss', async () => {
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), CANVAS)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    const home = await screen('home')
    await page.evaluate(() =>
      (window as unknown as Fixture).editFrame(
        'home',
        '<!doctype html><html><head></head><body><button id="go" data-doop-on="click" data-doop-action="navigate:detail">Edited</button><p id="blank" style="height:100px">x</p></body></html>',
      ),
    )
    await home.waitForFunction(() => document.querySelector('#go')?.textContent === 'Edited')
    for (let attempt = 0; attempt < 20; attempt++) {
      await home.$eval('#blank', (el) => (el as HTMLElement).click())
      if (await home.$('[data-v-proto-flash]')) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(await home.$('#go[data-v-proto-flash]')).not.toBeNull()
  })

  it('closes on Escape when presenting over the editor', async () => {
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), CANVAS)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    await screen('home')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => (window as unknown as Fixture).playerClosed)
  })

  it('draws connectors and the flow start in Prototype mode only', async () => {
    const pages = [{ id: 'p', name: 'Flow', startFrameId: 'home' }]
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), { ...CANVAS, pages })
    await page.evaluate(() => (window as unknown as Fixture).mountStage(false))
    await page.waitForSelector('iframe[data-doop-frame]')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await page.$('[data-prototype-overlay]')).toBeNull()

    await page.evaluate(() => (window as unknown as Fixture).mountStage(true))
    /* home → detail and home → menu; detail's Back and menu's Close are labels */
    await page.waitForFunction(() => document.querySelectorAll('[data-proto-connector]').length === 2)
    expect(await page.$eval('[data-flow-start]', (el) => (el as HTMLElement).dataset.flowStart)).toBe('home')
  })

  it('keeps interactions inert in a frame the editor drives', async () => {
    await page.evaluate(() => (window as unknown as Fixture).addRawFrame())
    const handle = await page.waitForSelector('iframe#raw')
    const raw = (await handle!.contentFrame())!
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.type === 'doop:frame-ready'))
    const html = doc('<button id="go" data-doop-on="click" data-doop-action="navigate:detail">Go</button>')
    await page.evaluate((html) => {
      ;(window as unknown as Fixture).messages = []
      ;(document.querySelector('iframe#raw') as HTMLIFrameElement).contentWindow!.postMessage(
        { type: 'doop:html', html },
        '*',
      )
    }, html)
    await raw.waitForSelector('#go')
    const actions = () =>
      page.evaluate(() => (window as unknown as Fixture).messages.filter((m) => m.type === 'doop:proto-action').length)

    /* canvas mode: the runtime never turned prototype mode on */
    await raw.click('#go')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await actions()).toBe(0)

    /* text-edit mode wins over prototype mode */
    const post = (message: Record<string, unknown>) =>
      page.evaluate(
        (message) =>
          (document.querySelector('iframe#raw') as HTMLIFrameElement).contentWindow!.postMessage(message, '*'),
        message,
      )
    await post({ type: 'doop:proto', on: true })
    await post({ type: 'doop:edit', on: true })
    await raw.click('#go')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await actions()).toBe(0)

    /* the player's mode: the same click navigates */
    await post({ type: 'doop:edit', on: false })
    await raw.click('#go')
    await page.waitForFunction(() =>
      (window as unknown as Fixture).messages.some((m) => m.type === 'doop:proto-action'),
    )
    expect(
      await page.evaluate(
        () => (window as unknown as Fixture).messages.find((m) => m.type === 'doop:proto-action')!.interaction,
      ),
    ).toMatchObject({ action: 'navigate', target: 'detail' })
  })

  describe('review fixes', () => {
    async function start(synced = false) {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), FLOW)
      await page.evaluate(
        (synced) =>
          synced ? (window as unknown as Fixture).playSynced('home') : (window as unknown as Fixture).play('home'),
        synced,
      )
      return screen('home')
    }

    /* a press fires on pointerdown, so retry it until the screen's runtime is on */
    async function pressUntil(frame: PuppeteerFrame, selector: string, done: () => Promise<boolean>) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await frame.$eval(selector, (el) =>
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })),
        )
        for (let wait = 0; wait < 5; wait++) {
          if (await done()) return
          await sleep(50)
        }
      }
      throw new Error(`pressing ${selector} never took effect`)
    }

    it('walks repeated screens back to the start and forward again with the browser history', async () => {
      const home = await start(true)
      expect(await page.$eval('[aria-label="Back"]', (el) => (el as HTMLButtonElement).disabled)).toBe(true)
      await clickUntil(home, '#go', async () => (await current()) === 'DETAIL')
      const detail = await screen('detail')
      await clickUntil(detail, '#again', async () => (await current()) === 'HOME')

      const walk = async (step: 'back' | 'forward', expected: string) => {
        await page.evaluate((step) => (step === 'back' ? history.back() : history.forward()), step)
        await page.waitForFunction(
          (expected) => document.querySelector('[data-proto-current]')?.textContent === expected,
          {},
          expected,
        )
      }
      await walk('back', 'DETAIL')
      await walk('back', 'HOME')
      expect(await page.$eval('[aria-label="Back"]', (el) => (el as HTMLButtonElement).disabled)).toBe(true)
      await walk('forward', 'DETAIL')
      await walk('forward', 'HOME')
      expect(await page.$eval('[aria-label="Back"]', (el) => (el as HTMLButtonElement).disabled)).toBe(false)
    })

    it('reverts a press navigation released on the outgoing screen', async () => {
      const home = await start()
      await pressUntil(home, '#hold', async () => (await current()) === 'DETAIL')
      /* the dissolve keeps home mounted, switched off, while the pointer comes up there */
      await home.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
      await page.waitForFunction(() => document.querySelector('[data-proto-current]')?.textContent === 'HOME')
    })

    it('keeps a held press pending through another interaction', async () => {
      const home = await start()
      await pressUntil(home, '#peek', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      await screen('menu')
      /* the overlay's key:Enter runs (its target is gone, so only a notice shows) */
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.body.textContent?.includes('no longer on the canvas'))
      await home.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
      await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
    })

    it('scrolls on a press scroll-to', async () => {
      const home = await start()
      await pressUntil(home, '#jump', () => home.evaluate(() => window.scrollY > 0))
      expect(await current()).toBe('HOME')
    })

    it('closes an overlay on Escape before the overlay screen runs its own key:Escape', async () => {
      const home = await start()
      await clickUntil(home, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      const menu = await screen('menu')
      await menu.$eval('#close', (el) => (el as HTMLElement).focus())
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
      await sleep(300)
      expect(await current()).toBe('HOME')
    })

    it('starts the delays of a live edit', async () => {
      const home = await start()
      /* the runtime is on once a click takes: an overlay opens */
      await clickUntil(home, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      await page.$eval('[data-proto-scrim]', (el) => (el as HTMLElement).click())
      await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
      await page.evaluate(() =>
        (window as unknown as Fixture).editFrame(
          'home',
          '<!doctype html><html><head></head><body><button id="wait" data-doop-on="delay:100" data-doop-action="navigate:detail">Wait</button></body></html>',
        ),
      )
      await page.waitForFunction(() => document.querySelector('[data-proto-current]')?.textContent === 'DETAIL')
    })
  })
})
