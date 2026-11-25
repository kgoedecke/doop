import { beforeEach, describe, expect, it } from 'vitest'
import type { Frame as PuppeteerFrame, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'
import type { Canvas, ElementComment, Frame } from '../shared/types'

type Message = { type?: string; interaction?: { action?: string; target?: string } }
/* what tests/fixtures/prototype.html puts on window */
type Fixture = {
  messages: Message[]
  fixtureReady: boolean
  playerClosed: boolean
  seed: (canvas: Canvas) => void
  seedComments: (comments: ElementComment[]) => void
  play: (frameId: string) => void
  playSynced: (frameId: string) => void
  editFrame: (id: string, html: string) => void
  addRawFrame: () => void
  mountStage: (prototypeMode: boolean) => void
  selectFrame: (id: string | null) => void
  pickElement: (el: { frameId: string; selector: string } | null) => void
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
/* the player's control bar above the screens, in px */
const BAR = 40
/* the pager's strip under them, on a page with frames to step to */
const PAGER = 56

describe.skipIf(!findBrowserPath())('prototype player', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 1000, height: 700 })
    await page.goto(fixtureUrl('prototype.html'))
    await page.waitForFunction(() => (window as unknown as Fixture).fixtureReady)
  })

  async function screen(frameId: string): Promise<PuppeteerFrame> {
    /* the iframe is in the page before its document is: wait for a live one */
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
    /* on the scrim, below the bar */
    await page.mouse.click(20, BAR + 20)
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

  it('keeps a restarted hotspot flash for its whole run', async () => {
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), CANVAS)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    const home = await screen('home')
    /* a miss flashes once the runtime is in prototype mode; let that flash end */
    for (let attempt = 0; attempt < 20; attempt++) {
      await home.$eval('#blank', (el) => (el as HTMLElement).click())
      if (await home.$('[data-v-proto-flash]')) break
      await sleep(50)
    }
    await home.waitForFunction(() => !document.querySelector('[data-v-proto-flash]'), { timeout: 3000 })
    /* timed inside the frame, so no round trip stretches the gaps: the first
       miss's clear must not cut the second miss's flash short */
    const run = await home.evaluate(async () => {
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const go = document.getElementById('go')!
      const alpha = () => Number(/rgba?\(([^)]+)\)/.exec(getComputedStyle(go).outlineColor)?.[1]?.split(',')[3] ?? 1)
      const blank = document.getElementById('blank')!
      blank.click()
      await wait(500)
      blank.click()
      await wait(100)
      const early = alpha()
      await wait(500)
      const late = alpha()
      await wait(200)
      return { early, late, lit: go.hasAttribute('data-v-proto-flash') }
    })
    expect(run.lit).toBe(true)
    /* and the ring fades over the run rather than holding until it is cleared */
    expect(run.late).toBeLessThan(run.early)
    await home.waitForFunction(() => !document.querySelector('[data-v-proto-flash]'), { timeout: 3000 })
  })

  it('sits below the app inset and rescales from its scaling menu', async () => {
    await page.evaluate(() => document.documentElement.style.setProperty('--app-inset', '40px'))
    /* the scaling pick is kept in storage, which the file's pages share */
    try {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), CANVAS)
      await page.evaluate(() => (window as unknown as Fixture).play('home'))
      await screen('home')
      expect(await page.$eval('[data-prototype-player]', (el) => el.getBoundingClientRect().top)).toBe(40)
      const width = () => page.$eval('[data-proto-screen="home"] > div', (el) => el.getBoundingClientRect().width)
      /* the screens get 1000 × 660 less the bar and the pager, room for the 400 × 300 frame
         nearly twice over, and Fit (the default) draws it at its design size, not larger */
      expect(await width()).toBe(400)
      /* the bar sits above the screens and the pager below, never over them */
      const box = (selector: string) =>
        page.$eval(selector, (el) => {
          const { top, bottom, height } = el.getBoundingClientRect()
          return { top, bottom, height }
        })
      const bar = await box('[data-proto-bar]')
      expect((await box('[data-proto-stage]')).top).toBe(bar.bottom)
      expect(bar).toMatchObject({ top: 40, height: BAR })
      const pager = await box('[data-proto-pager]')
      expect((await box('[data-proto-stage]')).bottom).toBe(pager.top)
      expect(pager).toMatchObject({ bottom: 700, height: PAGER })

      const widthBecomes = (px: number) =>
        page.waitForFunction(
          (want) => document.querySelector('[data-proto-screen="home"] > div')?.getBoundingClientRect().width === want,
          {},
          px,
        )
      const pick = async (label: string) => {
        await page.click('[aria-label="Scaling"]')
        await page.waitForSelector('[data-proto-menu]')
        await page.$$eval(
          '[data-proto-menu] [role="menuitemradio"]',
          (items, text) => (items.find((item) => item.textContent === text) as HTMLElement | undefined)?.click(),
          label,
        )
      }

      /* Fit width fills the player's width, enlarging the screen */
      await pick('Fit width')
      await widthBecomes(1000)

      await page.click('[aria-label="Scaling"]')
      await page.waitForSelector('[data-proto-menu]')
      /* the first item, Actual size, by keyboard */
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => !document.querySelector('[data-proto-menu]'))
      /* the menu's keys stayed with the menu: the player is still up */
      expect(await page.evaluate(() => (window as unknown as Fixture).playerClosed)).toBe(false)
      /* and the keys are the screen's again: a keyboard user is not left nowhere */
      await page.waitForFunction(() => document.activeElement?.matches('iframe[data-doop-proto-frame="home"]'))
      await widthBecomes(400)

      await pick('Responsive')
      await widthBecomes(1000)
    } finally {
      await page.evaluate(() => localStorage.removeItem('doop:proto-scaling'))
    }
  })

  it('cuts a long frame name short on a phone instead of running it under the buttons', async () => {
    const long: Canvas = {
      ...CANVAS,
      frames: CANVAS.frames.map((f) => (f.id === 'home' ? { ...f, name: 'A very long frame name '.repeat(4) } : f)),
    }
    await page.setViewport({ width: 320, height: 700 })
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), long)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    await screen('home')
    const edges = await page.evaluate(() => {
      /* the left group's last button: the name pushes it along */
      const left = document.querySelector('[aria-label="Restart prototype"]')!.getBoundingClientRect()
      const hotspots = document.querySelector('[aria-label="Show hotspots"]')!.getBoundingClientRect()
      return {
        leftEnd: left.right,
        buttonsLeft: hotspots.left,
        overflow: document.querySelector('[data-proto-bar]')!.scrollWidth,
      }
    })
    expect(edges.leftEnd).toBeLessThanOrEqual(edges.buttonsLeft)
    expect(edges.overflow).toBeLessThanOrEqual(320)
  })

  it('opens the scaling menu from the keyboard without driving the screen', async () => {
    const keyed: Canvas = {
      ...CANVAS,
      frames: CANVAS.frames.map((f) =>
        f.id === 'home'
          ? {
              ...f,
              html: f.html.replace(
                '</body>',
                '<div data-doop-on="key:ArrowDown" data-doop-action="navigate:detail"></div></body>',
              ),
            }
          : f,
      ),
    }
    await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), keyed)
    await page.evaluate(() => (window as unknown as Fixture).play('home'))
    await screen('home')
    await page.focus('[aria-label="Scaling"]')
    await page.keyboard.press('ArrowDown')
    await page.waitForSelector('[data-proto-menu]')
    await sleep(200)
    expect(await current()).toBe('HOME')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-proto-menu]'))
    expect(await page.evaluate(() => (window as unknown as Fixture).playerClosed)).toBe(false)
  })

  it('scrolls an oversized screen to its far corner, crops it under Fill and shrinks it under Fit', async () => {
    const big: Canvas = {
      ...CANVAS,
      frames: [{ ...frame('big', '<button>Big</button>'), width: 2000, height: 1400 }],
    }
    /* the screens' box (the player between its bar and its pager strip, kept
       even for this one-frame page), the screen's box,
       and how far its scroller can go */
    const measure = () =>
      page.$eval('[data-proto-screen="big"]', (scroller) => {
        const player = scroller.closest('[data-proto-stage]')!.getBoundingClientRect()
        scroller.scrollTo(scroller.scrollWidth, scroller.scrollHeight)
        const box = scroller.firstElementChild!.getBoundingClientRect()
        return {
          scrolled: scroller.scrollLeft > 0 || scroller.scrollTop > 0,
          right: box.right - player.right,
          bottom: box.bottom - player.bottom,
          left: box.left - player.left,
          top: box.top - player.top,
        }
      })
    const playAt = async (scaling: string) => {
      await page.evaluate((s) => localStorage.setItem('doop:proto-scaling', s), scaling)
      await page.evaluate(() => (window as unknown as Fixture).play('big'))
      await screen('big')
      return measure()
    }
    try {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), big)
      await page.setViewport({ width: 1000, height: 700 + BAR + PAGER })
      /* 2000 × 1400 at 1× in a 1000 × 700 player: scrolled to the far corner */
      expect(await playAt('actual')).toMatchObject({ scrolled: true, right: 0, bottom: 0 })
      /* at 0.5×: 1000 × 700 fills the width exactly, no room to scroll */
      expect(await playAt('fit-width')).toMatchObject({ right: 0, bottom: 0, left: 0, top: 0 })
      await page.setViewport({ width: 1000, height: 600 + BAR + PAGER })
      /* 1000 × 700 in 1000 × 600: scrolls down to the bottom edge */
      expect(await playAt('fit-width')).toMatchObject({ scrolled: true, bottom: 0, left: 0 })
      /* 0.5× covers 1000 × 600: 100px cropped, 50 each side, nothing to scroll */
      expect(await playAt('fill')).toEqual({ scrolled: false, right: 0, bottom: 50, left: 0, top: -50 })
      /* Fit shrinks it whole, letterboxed: at 600 / 1400 it is 857 × 600, 71 spare each side */
      const fit = await playAt('fit')
      expect(fit.scrolled).toBe(false)
      for (const [edge, want] of [
        ['top', 0],
        ['bottom', 0],
        ['left', 500 / 7],
        ['right', -500 / 7],
      ] as const)
        expect(fit[edge]).toBeCloseTo(want, 0)
    } finally {
      await page.evaluate(() => localStorage.removeItem('doop:proto-scaling'))
    }
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

    /* a selected frame shows only the links into and out of it: connectors
       and the label-only links (detail's Back, menu's Close) alike */
    const shown = (connectors: number, labels: number) =>
      page.waitForFunction(
        (connectors, labels) =>
          document.querySelectorAll('[data-proto-connector]').length === connectors &&
          document.querySelectorAll('[data-prototype-overlay] text').length === labels,
        {},
        connectors,
        labels,
      )
    await shown(2, 2)
    await page.evaluate(() => (window as unknown as Fixture).selectFrame('detail'))
    await shown(1, 1)
    await page.evaluate(() => (window as unknown as Fixture).selectFrame('home'))
    await shown(2, 0)
    await page.evaluate(() => (window as unknown as Fixture).selectFrame('menu'))
    await shown(1, 1)
    await page.evaluate(() => (window as unknown as Fixture).selectFrame(null))
    await shown(2, 2)
    /* a picked element counts as its frame being selected */
    await page.evaluate(() =>
      (window as unknown as Fixture).pickElement({ frameId: 'detail', selector: 'body > button' }),
    )
    await shown(1, 1)
    await page.evaluate(() => (window as unknown as Fixture).pickElement(null))
    await shown(2, 2)
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

    /* only the top screen takes input: the screen an overlay covers stays put */
    const COVERED: Canvas = {
      ...CANVAS,
      frames: [
        frame(
          'home',
          `<button id="help" data-doop-on="click" data-doop-action="overlay:menu">Help</button>
           <div data-doop-on="delay:800" data-doop-action="navigate:detail"></div>
           <div data-doop-on="key:k" data-doop-action="navigate:detail"></div>`,
        ),
        frame('detail', `<button id="back" data-doop-on="click" data-doop-action="back">Back</button>`, 500),
        frame(
          'menu',
          `<button id="close" data-doop-on="click" data-doop-action="close-overlay">Close</button>
           <button id="more" data-doop-on="click" data-doop-action="overlay:sheet">More</button>
           <div data-doop-on="key:k" data-doop-action="close-overlay"></div>`,
          1000,
        ),
        frame(
          'sheet',
          `<button id="done" data-doop-on="click" data-doop-action="close-overlay">Done</button>
           <div data-doop-on="key:k" data-doop-action="close-overlay"></div>`,
          1500,
        ),
      ],
    }
    const focusedScreen = () =>
      page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.doopProtoFrame)
    /* a wait that, when it never comes true, says where the focus and the overlays are */
    async function waitFor(label: string, check: () => boolean) {
      try {
        await page.waitForFunction(check)
      } catch (error) {
        const state = await page
          .evaluate(() => ({
            active: (document.activeElement as HTMLElement | null)?.outerHTML.slice(0, 120),
            overlays: [...document.querySelectorAll('[data-proto-overlay]')].map((el) =>
              el.getAttribute('data-proto-overlay'),
            ),
            current: document.querySelector('[data-proto-current]')?.textContent,
            messages: (window as unknown as Fixture).messages.map((m) => m.type).slice(-40),
          }))
          .catch(() => 'unavailable')
        throw new Error(`${label}: ${String(error)}\n${JSON.stringify(state)}`, { cause: error })
      }
    }

    it('runs only the top screen’s delays and keys while an overlay is open', async () => {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), COVERED)
      await page.evaluate(() => (window as unknown as Fixture).play('home'))
      const home = await screen('home')
      /* a real click focuses the screen that opens the overlay */
      await home.$eval('#help', (el) => (el as HTMLElement).focus())
      await clickUntil(home, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      await screen('menu')
      /* home's delay comes due under the overlay and does nothing */
      await sleep(1000)
      expect(await current()).toBe('HOME')
      expect(await page.$('[data-proto-overlay="menu"]')).not.toBeNull()

      /* the key goes to the menu on top, not to home, which held the focus */
      await page.keyboard.press('k')
      await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
      await sleep(200)
      expect(await current()).toBe('HOME')
    })

    it('hands the focus back to the uncovered screen as nested overlays close', async () => {
      await page.evaluate((canvas) => (window as unknown as Fixture).seed(canvas), COVERED)
      await page.evaluate(() => (window as unknown as Fixture).play('home'))
      const home = await screen('home')
      await home.$eval('#help', (el) => (el as HTMLElement).focus())
      await clickUntil(home, '#help', async () => !!(await page.$('[data-proto-overlay="menu"]')))
      const menu = await screen('menu')
      await waitFor(
        'menu focused',
        () => (document.activeElement as HTMLElement | null)?.dataset.doopProtoFrame === 'menu',
      )
      await clickUntil(menu, '#more', async () => !!(await page.$('[data-proto-overlay="sheet"]')))
      await screen('sheet')
      await waitFor(
        'sheet focused',
        () => (document.activeElement as HTMLElement | null)?.dataset.doopProtoFrame === 'sheet',
      )
      await page.keyboard.press('k')
      await waitFor('sheet closed', () => !document.querySelector('[data-proto-overlay="sheet"]'))
      await expect.poll(focusedScreen).toBe('menu')
      await page.keyboard.press('k')
      await waitFor('menu closed', () => !document.querySelector('[data-proto-overlay]'))
      await expect.poll(focusedScreen).toBe('home')
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

  describe('frame menu and comments', () => {
    const current = () => page.$eval('[data-proto-current]', (el) => el.textContent)

    it('jumps to any frame from the menu, and Back returns', async () => {
      await page.evaluate((canvas) => {
        const w = window as unknown as Fixture
        w.seed(canvas)
        w.play('home')
      }, CANVAS)
      await screen('home')
      await page.click('[data-proto-frame-menu]')
      await page.waitForSelector('[data-proto-jump="detail"]')
      const listed = await page.$$eval('[data-proto-jump]', (items) => items.map((i) => i.textContent))
      expect(listed).toEqual(['HOME', 'DETAIL', 'MENU'])
      await page.click('[data-proto-jump="detail"]')
      await page.waitForFunction(() => document.querySelector('[data-proto-current]')?.textContent === 'DETAIL')
      await screen('detail')
      await page.click('[aria-label="Back"]')
      await page.waitForFunction(() => document.querySelector('[data-proto-current]')?.textContent === 'HOME')
      expect(await current()).toBe('HOME')
    })

    it('steps through the page with the pager, and a click around the screen hides the UI', async () => {
      await page.evaluate((canvas) => {
        const w = window as unknown as Fixture
        w.seed(canvas)
        w.play('home')
      }, CANVAS)
      await screen('home')
      const count = () => page.$eval('[data-proto-count]', (el) => el.textContent)
      expect(await count()).toBe('1 / 3')
      expect(await page.$eval('[aria-label="Previous frame"]', (el) => (el as HTMLButtonElement).disabled)).toBe(true)
      await page.click('[aria-label="Next frame"]')
      await page.waitForFunction(() => document.querySelector('[data-proto-count]')?.textContent === '2 / 3')
      expect(await current()).toBe('DETAIL')
      await page.click('[aria-label="Next frame"]')
      await page.waitForFunction(() => document.querySelector('[data-proto-count]')?.textContent === '3 / 3')
      expect(await page.$eval('[aria-label="Next frame"]', (el) => (el as HTMLButtonElement).disabled)).toBe(true)
      await page.click('[aria-label="Previous frame"]')
      await page.waitForFunction(() => document.querySelector('[data-proto-count]')?.textContent === '2 / 3')
      /* the screen stepped to takes the keys, not the pager's button */
      await page.waitForFunction(() => document.activeElement?.matches('iframe[data-doop-proto-frame="detail"]'))

      /* the letterbox around the 400x300 screen, then back */
      const stage = (await page.$eval('[data-proto-stage]', (el) => {
        const r = el.getBoundingClientRect()
        return { x: r.left + 5, y: r.top + r.height / 2 }
      }))!
      const screenBox = () =>
        page.$eval('[data-proto-screen="detail"] > div', (el) => JSON.stringify(el.getBoundingClientRect()))
      const before = await screenBox()
      const shown = () =>
        page.$$eval('[data-proto-bar], [data-proto-pager]', (els) =>
          els.map((el) => getComputedStyle(el).visibility === 'visible'),
        )
      await page.mouse.click(stage.x, stage.y)
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-proto-bar], [data-proto-pager]')].every(
          (el) => getComputedStyle(el).visibility === 'hidden',
        ),
      )
      /* the UI keeps its room: the screen neither moves nor rescales */
      expect(await screenBox()).toBe(before)
      /* where the bar was brings it back, for a screen with no space around it */
      await page.mouse.click(500, BAR / 2)
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-proto-bar], [data-proto-pager]')].every(
          (el) => getComputedStyle(el).visibility === 'visible',
        ),
      )
      expect(await shown()).toEqual([true, true])
    })

    it('pins a comment to the element clicked in comment mode, without playing it', async () => {
      await page.evaluate((canvas) => {
        const w = window as unknown as Fixture & { posted: { url: string; body: Record<string, unknown> }[] }
        w.posted = []
        const real = window.fetch.bind(window)
        window.fetch = (input, init) => {
          const url = String(input)
          if (url.includes('/comments') && init?.method === 'POST') {
            w.posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> })
            return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
          }
          return real(input, init)
        }
        w.seed(canvas)
        w.play('home')
      }, CANVAS)
      const home = await screen('home')
      await page.click('[data-proto-comments]')
      await page.waitForSelector('[data-proto-comment-surface]')
      const box = (await (await page.$('iframe[data-doop-proto-frame="home"]'))!.boundingBox())!
      const help = (await home.$eval('#help', (el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })) as { x: number; y: number }
      /* the screen is drawn scaled: design px to the page's */
      const scale = box.width / 400
      await page.mouse.click(box.x + help.x * scale, box.y + help.y * scale)
      await page.waitForSelector('[data-proto-composer] textarea')
      /* "c" types into the comment; it does not leave comment mode */
      await page.type('[data-proto-composer] textarea', 'Nice copy')
      await page.keyboard.down('Control')
      await page.keyboard.press('Enter')
      await page.keyboard.up('Control')
      await page.waitForFunction(() => (window as unknown as { posted: unknown[] }).posted.length === 1)
      const [posted] = await page.evaluate(
        () => (window as unknown as { posted: { url: string; body: Record<string, unknown> }[] }).posted,
      )
      expect(posted!.url).toContain('/api/frames/home/comments')
      expect(posted!.body.text).toBe('Nice copy')
      expect(String(posted!.body.snippet)).toContain('Help')
      expect(await page.$('[data-proto-composer]')).toBeNull()
      /* the click commented: the Help overlay never opened */
      expect(await page.$('[data-proto-overlay]')).toBeNull()
      expect(await page.$('[data-proto-comment-surface]')).not.toBeNull()
      /* Esc leaves comment mode before it closes the player */
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('[data-proto-comment-surface]'))
      expect(await page.evaluate(() => (window as unknown as Fixture).playerClosed)).toBe(false)
    })

    it("leaves C to a screen's own key:c interaction, and switches comment mode otherwise", async () => {
      const keyed: Canvas = {
        ...CANVAS,
        frames: [
          frame(
            'home',
            `<button id="go">Go</button><div data-doop-on="key:c" data-doop-action="navigate:detail"></div>`,
          ),
          ...CANVAS.frames.slice(1),
        ],
      }
      await page.evaluate((canvas) => {
        const w = window as unknown as Fixture
        w.seed(canvas)
        w.play('home')
      }, keyed)
      await screen('home')
      await page.keyboard.press('c')
      await page.waitForFunction(() => document.querySelector('[data-proto-current]')?.textContent === 'DETAIL')
      expect(await page.$('[data-proto-comment-surface]')).toBeNull()
      /* DETAIL has no key:c: C is comment mode */
      await screen('detail')
      await page.keyboard.press('c')
      await page.waitForSelector('[data-proto-comment-surface]')
    })

    it('scrolls a long screen under the comment cover', async () => {
      await page.evaluate((canvas) => {
        const w = window as unknown as Fixture
        w.seed(canvas)
        w.play('home')
      }, FLOW)
      const home = await screen('home')
      await page.click('[data-proto-comments]')
      const surface = (await (await page.waitForSelector('[data-proto-comment-surface]'))!.boundingBox())!
      await page.mouse.move(surface.x + 50, surface.y + 50)
      await page.mouse.wheel({ deltaY: 400 })
      await home.waitForFunction(() => window.scrollY > 0)
    })

    it('picking the screen under an open overlay closes the overlay', async () => {
      await page.evaluate((canvas) => {
        const w = window as unknown as Fixture
        w.seed(canvas)
        w.play('home')
      }, CANVAS)
      const home = await screen('home')
      await clickUntil(home, '#help', async () => !!(await page.$('[data-proto-overlay]')))
      await page.click('[data-proto-frame-menu]')
      await page.waitForSelector('[data-proto-jump="home"]')
      await page.click('[data-proto-jump="home"]')
      await page.waitForFunction(() => !document.querySelector('[data-proto-overlay]'))
      /* nothing was pushed: Back has nowhere to go */
      expect(await page.$eval('[aria-label="Back"]', (b) => (b as HTMLButtonElement).disabled)).toBe(true)
    })

    it("shows the screen's threads as pins in comment mode", async () => {
      const comment: ElementComment = {
        id: 'k1',
        canvasId: 'c',
        frameId: 'home',
        snippet: '',
        x: 200,
        y: 150,
        from: 'Ana',
        text: 'Too tight',
        at: 1,
      }
      await page.evaluate(
        (canvas, c) => {
          const w = window as unknown as Fixture
          w.seed(canvas)
          w.seedComments([c])
          w.play('home')
        },
        CANVAS,
        comment,
      )
      await screen('home')
      expect(await page.$('[title^="Ana: Too tight"]')).toBeNull()
      await page.click('[data-proto-comments]')
      const pin = await page.waitForSelector('[title^="Ana: Too tight"]')
      await pin!.click()
      await page.waitForFunction(() => document.body.textContent?.includes('Too tight'))
      expect(await page.$('[data-comment-popover]')).not.toBeNull()
    })
  })
})
