import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import type { CanvasRole } from '../shared/canvasRole'
import type { Frame } from '../shared/types'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'

declare global {
  interface Window {
    canvasClipboardHarness: {
      seed: (frames: Frame[], role?: CanvasRole) => void
      pick: (...selectors: string[]) => void
      frames: () => Frame[]
      picked: () => string[]
      lockFrame: () => void
      notice: () => string | undefined
      undo: () => Promise<void>
    }
  }
}

const HTML = `<!doctype html><html><body style="margin:0;padding:20px">
  <section id="card" style="width:200px;height:100px"><h1>Card</h1><button>Action</button></section>
  <p id="other">Other element</p>
</body></html>`
const FRAME: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Frame',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  html: HTML,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
}

/* These tests go through the real system clipboard. On macOS headless Chromium
   shares the OS pasteboard with everything else on the machine and its reads
   race its writes, so the file is skipped there unless asked for. */
const CLIPBOARD_IS_RELIABLE = process.platform !== 'darwin' || !!process.env.DOOP_CLIPBOARD_TESTS

describe.skipIf(!findBrowserPath() || !CLIPBOARD_IS_RELIABLE)('canvas clipboard shortcuts', { timeout: 20_000 }, () => {
  let browser: TestBrowser
  let page: Page
  let created: Partial<Frame>[] = []
  let uploads = 0
  const errors: string[] = []

  /* Headless Chromium on macOS binds copy and paste in the OS menu, not in
     Blink, so a key chord alone never fires the clipboard events there; the
     editing command goes along with the key (a macOS-only CDP option). */
  async function chord(key: 'c' | 'v') {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const commands = process.platform === 'darwin' ? [key === 'c' ? 'copy' : 'paste'] : undefined
    await page.keyboard.down(mod)
    await page.keyboard.press(key, { commands })
    await page.keyboard.up(mod)
  }

  async function count(selector: string) {
    return page.evaluate((selector) => {
      const html = window.canvasClipboardHarness.frames()[0]!.html
      return new DOMParser().parseFromString(html, 'text/html').querySelectorAll(selector).length
    }, selector)
  }

  async function copyImage() {
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 2
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new Error('Could not create clipboard image'))
        }),
      )
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    })
  }

  async function choose(label: string) {
    const handle = await page.waitForFunction(
      (label) =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (el) => el.firstChild?.textContent === label,
        ),
      {},
      label,
    )
    const item = await handle.asElement()?.toElement('div')
    if (!item) throw new Error(`Missing menu item: ${label}`)
    await item.click()
    await page.waitForSelector('[role="menu"]', { hidden: true })
  }

  async function editText() {
    const doc = (await (await page.$('iframe[data-doop-frame]'))!.contentFrame())!
    await doc.click('h1')
    const edit = await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === 'Edit text'),
    )
    const button = await edit.asElement()!.toElement('button')
    await button.click()
    await doc.click('h1')
    await doc.waitForSelector('[contenteditable]')
    return doc
  }

  beforeAll(async () => {
    browser = await openBrowser()
    await browser.grantPermissions(['clipboard-read', 'clipboard-sanitized-write'])
    page = await browser.newPage()
    page.setDefaultTimeout(4_000)
    await page.setViewport({ width: 1200, height: 900 })
    page.on('pageerror', (err) => errors.push(String(err)))
    // CanvasPage installs the real shortcuts; its live server connection is outside this test.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'WebSocket', {
        value: class {
          readyState = 0
          static OPEN = 1
          close() {}
        },
      })
    })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const path = new URL(request.url()).pathname
      if (path === '/api/canvases/c/frames' && request.method() === 'POST') {
        const frame: Partial<Frame> = JSON.parse(request.postData()!)
        created.push(frame)
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...FRAME, ...frame, id: `new${created.length}` }),
        })
      } else if (path === '/api/canvases/c/assets') {
        uploads++
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ url: '/clipboard-image.png' }),
        })
      } else if (path === '/api/canvases/c/fonts') {
        await request.respond({ status: 200, contentType: 'application/json', body: '[]' })
      } else if (path === '/api/auth/get-session') {
        /* signed out, as the server says it: a `{}` session has no `user` */
        await request.respond({ status: 200, contentType: 'application/json', body: 'null' })
      } else if (path.startsWith('/api/')) {
        await request.respond({ status: 200, contentType: 'application/json', body: '{}' })
      } else await request.continue()
    })
  }, 60_000)

  beforeEach(async () => {
    created = []
    uploads = 0
    await page.goto(fixtureUrl('canvasClipboard.html'))
    await page.waitForFunction(() => !!window.canvasClipboardHarness && !!document.querySelector('.stage'))
    await page.evaluate((frame) => {
      localStorage.clear()
      window.canvasClipboardHarness.seed([frame])
    }, FRAME)
    await page.waitForSelector('iframe[data-doop-frame]')
    const doc = (await (await page.$('iframe[data-doop-frame]'))!.contentFrame())!
    await doc.waitForSelector('#card')
    await page.evaluate(() => navigator.clipboard.writeText('external text'))
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    expect(errors).toEqual([])
  })

  it('copies a whole element after a screenshot and pastes its children as one undo step', async () => {
    await copyImage()
    await page.evaluate(() => window.canvasClipboardHarness.pick('#card'))
    await chord('c')
    await chord('v')
    await expect.poll(() => count('section')).toBe(2)
    const doc = (await (await page.$('iframe[data-doop-frame]'))!.contentFrame())!
    await doc.waitForSelector('#card-copy')
    expect(await count('#card-copy h1, #card-copy button')).toBe(2)
    expect(uploads).toBe(0)
    await page.evaluate(() => window.canvasClipboardHarness.undo())
    expect(await count('section')).toBe(1)
  })

  it('pastes a newer external image instead of stale copied elements', async () => {
    await page.evaluate(() => window.canvasClipboardHarness.pick('#card'))
    await chord('c')
    await copyImage()
    await chord('v')
    await expect.poll(() => uploads).toBe(1)
    expect(await count('section')).toBe(1)
  })

  it('does not paste an old element when external text replaced the clipboard', async () => {
    await page.evaluate(() => window.canvasClipboardHarness.pick('#card'))
    await chord('c')
    await page.evaluate(() => navigator.clipboard.writeText('new external text'))
    await chord('v')
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    expect(await count('section')).toBe(1)
    expect(created).toHaveLength(0)
  })

  it('copies and pastes immediately after leaving text editing with Escape', async () => {
    const doc = await editText()
    await page.keyboard.press('Escape')
    await doc.waitForSelector('[contenteditable]', { hidden: true })
    /* Escape hands the keyboard back to the page; the copy event must fire
       on this window, not inside the frame's document */
    await page.waitForFunction(() => document.activeElement?.tagName !== 'IFRAME')
    await chord('c')
    await chord('v')
    await expect.poll(() => count('h1')).toBe(2)
    await doc.waitForFunction(() => document.querySelectorAll('h1').length === 2)
    expect(await count('section')).toBe(1)
  })

  it('keeps focus in another field when a remote lock ends text editing', async () => {
    const doc = await editText()
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.id = 'other-field'
      document.body.append(input)
      input.focus()
      window.canvasClipboardHarness.lockFrame()
    })
    await doc.waitForSelector('[contenteditable]', { hidden: true })
    await page.waitForFunction(() => document.activeElement?.tagName !== 'IFRAME')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('other-field')
  })

  it('keeps multiple copied elements together and selects the pasted set', async () => {
    await page.evaluate(() => window.canvasClipboardHarness.pick('#card', '#other'))
    await chord('c')
    await chord('v')
    await expect.poll(() => count('section, p')).toBe(4)
    expect(await page.evaluate(() => window.canvasClipboardHarness.picked())).toHaveLength(2)
  })

  it('copies through the element menu and pastes with the keyboard', async () => {
    await copyImage()
    const doc = (await (await page.$('iframe[data-doop-frame]'))!.contentFrame())!
    await doc.click('h1', { button: 'right' })
    await choose('Copy')
    await chord('v')
    await expect.poll(() => count('h1')).toBe(2)
    expect(uploads).toBe(0)
  })

  it('copies a frame through its menu and pastes with the keyboard', async () => {
    await copyImage()
    await page.click('[data-frame-title]', { button: 'right' })
    await choose('Copy')
    /* the menu's copy writes the clipboard asynchronously: paste once the
       token has replaced the image, or the paste lands the image instead */
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('doop:clipboard:')
    await chord('v')
    await expect.poll(() => created.length).toBe(1)
    expect(created[0]).toMatchObject({ html: HTML, width: 400, height: 300 })
    expect(uploads).toBe(0)
  })

  it('replaces an element copy with an entire frame copied through the keyboard', async () => {
    await page.evaluate(() => window.canvasClipboardHarness.pick('#card'))
    await chord('c')
    await page.click('[data-frame-title]')
    await chord('c')
    await chord('v')
    await expect.poll(() => created.length).toBe(1)
    expect(created[0]).toMatchObject({ html: HTML, width: 400, height: 300 })
    expect(await count('section')).toBe(1)
  })

  it.each(['element', 'frame'])('preserves the previous copy when the %s menu copy is denied', async (kind) => {
    await page.evaluate(() => window.canvasClipboardHarness.pick('#card'))
    await chord('c')
    await page.evaluate(() =>
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () => Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError')),
      }),
    )
    if (kind === 'frame') await page.click('[data-frame-title]', { button: 'right' })
    else {
      const doc = (await (await page.$('iframe[data-doop-frame]'))!.contentFrame())!
      await doc.click('#other', { button: 'right' })
    }
    await choose('Copy')
    await page.waitForFunction(() => window.canvasClipboardHarness.notice()?.includes('Couldn’t copy'))
    await chord('v')
    await expect.poll(() => count('section')).toBe(2)
    expect(await count('#card-copy h1, #card-copy button')).toBe(2)
    expect(created).toHaveLength(0)
  })

  it('leaves native text copy and paste alone while an element is selected', async () => {
    await page.evaluate(() => {
      window.canvasClipboardHarness.pick('#card')
      const input = document.createElement('input')
      input.id = 'native-input'
      input.value = 'native text'
      document.body.append(input)
      input.focus()
      input.select()
    })
    await chord('c')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('native text')
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#native-input')!
      input.value = ''
    })
    await chord('v')
    expect(await page.$eval('#native-input', (input) => (input as HTMLInputElement).value)).toBe('native text')
    expect(await count('section')).toBe(1)
  })

  it('copies selected paragraph text instead of the selected canvas element', async () => {
    await page.evaluate(() => {
      window.canvasClipboardHarness.pick('#card')
      const paragraph = document.createElement('p')
      paragraph.textContent = 'selected paragraph text'
      document.body.append(paragraph)
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await chord('c')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('selected paragraph text')
    expect(await count('section')).toBe(1)
  })

  it('duplicates the picked element when the key arrives as uppercase D', async () => {
    await page.evaluate(() => {
      window.canvasClipboardHarness.pick('#card')
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'D',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(await count('section')).toBe(2)
    expect(created).toHaveLength(0)
    expect(await page.evaluate(() => window.canvasClipboardHarness.picked())).toEqual(['#card-copy'])
  })

  it.each(['view', 'frame', 'element'] as const)('respects %s protection when pasting', async (lock) => {
    await page.evaluate(() => window.canvasClipboardHarness.pick('#card'))
    await chord('c')
    expect(await page.evaluate(() => navigator.clipboard.readText())).not.toBe('external text')
    await page.evaluate(
      ({ frame, lock }) => {
        window.canvasClipboardHarness.seed(
          [
            {
              ...frame,
              locked: lock === 'frame',
              html:
                lock === 'element' ? frame.html.replace('id="card"', 'id="card" data-doop-locked="true"') : frame.html,
            },
          ],
          lock === 'view' ? 'view' : 'edit',
        )
        window.canvasClipboardHarness.pick('#card')
      },
      { frame: FRAME, lock },
    )
    await chord('v')
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    expect(await count('section')).toBe(1)
    expect(created).toHaveLength(0)
    expect(uploads).toBe(0)
  })
})
