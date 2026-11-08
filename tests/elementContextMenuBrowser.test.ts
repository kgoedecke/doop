import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { Frame } from '../shared/types'

declare global {
  interface Window {
    delayContextMessage?: 'doop:html' | 'doop:context-hit'
    releaseContextMessage?: () => void
    contextMenuHarness: {
      seed: (frames: Frame[], zoom?: number) => void
      selection: () => { frameId: string; selector: string } | null
      updateHtml: (html: string) => void
      selectMany: (ids: string[]) => void
      undo: () => Promise<void>
      redo: () => Promise<void>
    }
  }
}

const HTML = `<html><head><style>body { margin: 0; padding: 20px }</style></head><body>
  <div id="box" style="width:200px;height:80px;background:#ddd">First</div>
  <p id="text" style="width:200px;height:50px">Second element</p>
  <div id="locked" data-doop-locked="true" style="width:200px;height:50px">Locked</div>
  <svg id="art" width="80" height="50"><rect width="80" height="50" fill="red" /></svg>
</body></html>`

describe.skipIf(!findBrowserPath())('frame and element context menus', () => {
  let browser: TestBrowser
  let page: Page
  let saved: Frame
  let deletedFrames = 0
  let stamped: string[] = []
  const errors: string[] = []

  async function frameDoc() {
    return (await page.$('iframe[data-doop-frame]'))!.contentFrame()
  }

  async function rightClick(selector: string, wait = true) {
    const doc = (await frameDoc())!
    await doc.waitForSelector(selector, { visible: true })
    const inner = await doc.$eval(selector, (el) => el.getBoundingClientRect().toJSON())
    const outer = await page.$eval('iframe[data-doop-frame]', (el) => el.getBoundingClientRect().toJSON())
    const zoom = outer.width / saved.width
    await page.mouse.click(outer.x + (inner.x + 5) * zoom, outer.y + (inner.y + 5) * zoom, { button: 'right' })
    if (wait)
      await page.waitForFunction(
        () => !!document.querySelector('[role="menu"]') && !document.body.textContent?.includes('Finding element…'),
      )
  }

  async function items() {
    return page.$$eval('[role="menuitem"]', (nodes) => nodes.map((node) => node.firstChild?.textContent))
  }

  async function choose(label: string) {
    const handle = await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (el) => el.firstChild?.textContent === text,
        ),
      {},
      label,
    )
    const item = await handle.asElement()?.toElement('div')
    if (!item) throw new Error(`Missing menu item: ${label}`)
    await item.click()
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
  }

  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    // Install before the iframe bootstrap registers its listener. A handler
    // added later cannot stop a message the runtime has already processed.
    await page.evaluateOnNewDocument(() => {
      window.addEventListener('message', (event) => {
        if (!window.delayContextMessage || event.data?.type !== window.delayContextMessage) return
        window.delayContextMessage = undefined
        event.stopImmediatePropagation()
        window.releaseContextMessage = () => {
          window.releaseContextMessage = undefined
          window.dispatchEvent(new MessageEvent('message', { data: event.data, source: event.source }))
        }
      })
    })
    page.setDefaultTimeout(5_000)
    page.on('pageerror', (err) => errors.push(String(err)))
    await page.setViewport({ width: 1200, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname === '/api/frames/f') {
        if (request.method() === 'PATCH') saved = { ...saved, ...JSON.parse(request.postData()!) }
        if (request.method() === 'DELETE') deletedFrames++
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) })
      } else if (pathname === '/api/frames/f/element-id') {
        /* the server stamps a data-doop-id onto the element and answers with it */
        stamped.push(JSON.parse(request.postData()!).selector)
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ elementId: 'text00' }),
        })
      } else await request.continue()
    })
    await browser.grantPermissions(['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
  }, 60_000)

  beforeEach(async () => {
    await page.goto(fixtureUrl('elementContextMenu.html'))
    await page.waitForFunction(() => !!window.contextMenuHarness)
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Menu frame',
      x: 60,
      y: 80,
      width: 500,
      height: 400,
      html: HTML,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
    }
    deletedFrames = 0
    stamped = []
    await page.evaluate((frame) => {
      localStorage.clear()
      window.contextMenuHarness.seed([frame])
    }, saved)
    const doc = (await frameDoc())!
    await doc.waitForSelector('#box')
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    expect(errors).toEqual([])
  })

  it.each(['frame', 'image'])('renames a %s from the Layers panel without losing editor focus', async (kind) => {
    if (kind === 'image') {
      saved = {
        ...saved,
        html: '<body data-doop-canvas-element="true"><img id="photo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" /></body>',
      }
      await page.evaluate((frame) => window.contextMenuHarness.seed([frame]), saved)
    }
    const row = kind === 'image' ? '[data-row-key="f|#photo"]' : '[role="treeitem"][data-row-key="f"]'
    const editor = 'input[aria-label="Item name"]'
    await page.click(`${row} > span:nth-of-type(3)`, { count: 2 })
    await page.waitForSelector(editor)
    await page.keyboard.type('Double-click name')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      (row) => document.querySelector(row)?.textContent?.includes('Double-click name'),
      {},
      row,
    )
    await expect.poll(() => saved.name).toBe('Double-click name')

    await page.click(row, { button: 'right' })
    await choose('Rename')
    await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), {}, editor)
    await page.keyboard.type('Menu name')
    await page.keyboard.press('Tab')
    await expect.poll(() => saved.name).toBe('Menu name')
    await page.evaluate(() => window.contextMenuHarness.undo())
    await page.waitForFunction(
      (row) => document.querySelector(row)?.textContent?.includes('Double-click name'),
      {},
      row,
    )
  })

  it.each(['#photo', '#text', '#box'])(
    'renames nested layer %s and restores its name after reload',
    async (selector) => {
      saved.html = saved.html.replace(
        '</body>',
        '<img id="photo" alt="Original alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" /></body>',
      )
      await page.evaluate((frame) => window.contextMenuHarness.seed([frame]), saved)
      await (await frameDoc())!.waitForSelector('#photo')
      await page.click('[role="treeitem"][data-row-key="f"]')
      const row = `[data-row-key="f|${selector}"]`
      const editor = 'input[aria-label="Item name"]'
      await page.click(`${row} > span:nth-of-type(3)`, { count: 2 })
      await page.waitForSelector(editor)
      await page.keyboard.type('Nested label')
      await page.keyboard.press('Enter')
      await expect.poll(() => saved.html).toContain('data-doop-name="Nested label"')
      const doc = (await frameDoc())!
      await doc.waitForSelector(`${selector}[data-doop-name="Nested label"]`)
      expect(await doc.$eval('#text', (el) => el.textContent)).toBe('Second element')
      expect(await doc.$eval('#photo', (el) => el.getAttribute('alt'))).toBe('Original alt')

      await page.click(row, { button: 'right' })
      await choose('Rename')
      await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), {}, editor)
      await page.keyboard.type('Saved label')
      await page.keyboard.press('Enter')
      await expect.poll(() => saved.html).toContain('data-doop-name="Saved label"')
      await page.reload()
      await page.waitForFunction(() => !!window.contextMenuHarness)
      await page.evaluate((frame) => window.contextMenuHarness.seed([frame]), saved)
      await page.click('[role="treeitem"][data-row-key="f"]')
      await page.waitForFunction((row) => document.querySelector(row)?.textContent?.includes('Saved label'), {}, row)
    },
  )

  it('opens the frame menu only from its title, and targets the clicked element', async () => {
    await page.click('[data-frame-title]', { button: 'right' })
    expect(await items()).toContain('Delete frame')
    expect(await items()).not.toContain('Delete element')
    await page.keyboard.press('Escape')
    await rightClick('#text')
    expect(await items()).toEqual([
      'Copy',
      'Paste',
      'Duplicate',
      'Hide',
      'Copy HTML',
      'Copy selector',
      'Copy link to element',
      'Export…',
      'Copy as PNG',
      'Move up',
      'Move down',
      'Lock',
      'Delete element',
    ])
    expect(await page.evaluate(() => window.contextMenuHarness.selection())).toEqual({
      frameId: 'f',
      selector: '#text',
    })
    expect(await page.$$('[role="menu"]')).toHaveLength(1)
    await page.waitForFunction(() => {
      const menu = document.querySelector('[role="menu"]')
      return menu && getComputedStyle(menu).opacity === '1'
    })
    await page.screenshot({ path: '/tmp/doop-element-context-menu.png' })
    await choose('Copy HTML')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('id="text"')
  })

  it('shares hide, unlock, and link actions with the layer panel', async () => {
    await rightClick('#locked')
    expect(
      await page.$$eval('[role="menuitem"]', (items) =>
        items.find((el) => el.firstChild?.textContent === 'Delete element')?.getAttribute('aria-disabled'),
      ),
    ).toBe('true')
    await choose('Unlock')
    await expect.poll(() => saved.html).not.toContain('data-doop-locked')
    await rightClick('#text')
    await choose('Hide')
    await expect.poll(() => saved.html).toContain('data-doop-hidden')
    await page.click('[data-row-key="f|#text"]', { button: 'right' })
    await choose('Show')
    await expect.poll(() => saved.html).not.toContain('data-doop-hidden')
    await rightClick('#text')
    await choose('Copy link to element')
    /* the copy waits for the stamp, so the clipboard is read once it has landed */
    await expect
      .poll(async () => new URL(await page.evaluate(() => navigator.clipboard.readText())).searchParams.get('element'))
      .toBe('text00')
    expect(stamped).toEqual(['#text'])
    const link = new URL(await page.evaluate(() => navigator.clipboard.readText()))
    expect(link.searchParams.has('selector')).toBe(false)
  })

  it('does not open the frame or background menu in empty frame space', async () => {
    await page.mouse.click(500, 440, { button: 'right' })
    await page.waitForFunction(() => document.querySelector('[role="menuitem"]')?.textContent?.startsWith('Copy'))
    expect(await items()).toEqual(['Copy', 'Paste'])
    expect(await page.evaluate(() => window.contextMenuHarness.selection())).toBeNull()
  })

  it('resolves elements at canvas zoom and treats SVG artwork as a layer', async () => {
    await page.evaluate((frame) => window.contextMenuHarness.seed([frame], 0.5), saved)
    await page.waitForFunction(
      () => document.querySelector('[data-frame-surface]')?.getBoundingClientRect().width === 250,
    )
    await rightClick('#art rect')
    expect(await page.evaluate(() => window.contextMenuHarness.selection())).toEqual({ frameId: 'f', selector: '#art' })
    await choose('Lock')
    await expect.poll(() => saved.html).toContain('<svg id="art" width="80" height="50" data-doop-locked="true">')
  })

  it('keeps rename undo and redo in sync with an actively edited text layer', async () => {
    const doc = (await frameDoc())!
    const box = await (await doc.$('#text'))!.boundingBox()
    await page.mouse.click(box!.x + 20, box!.y + 10, { count: 2 })
    await doc.waitForSelector('style[data-v-edit]')
    const row = '[data-row-key="f|#text"]'
    await page.click(`${row} > span:nth-of-type(3)`, { count: 2 })
    await page.waitForSelector('input[aria-label="Item name"]')
    await page.keyboard.type('Renamed text')
    await page.keyboard.press('Enter')
    await expect.poll(() => saved.html).toContain('data-doop-name="Renamed text"')
    await page.evaluate(() => window.contextMenuHarness.undo())
    expect(await doc.$eval('#text', (el) => el.getAttribute('data-doop-name'))).toBeNull()
    await page.evaluate(() => window.contextMenuHarness.redo())
    expect(await doc.$eval('#text', (el) => el.getAttribute('data-doop-name'))).toBe('Renamed text')
    await page.evaluate(() => window.contextMenuHarness.undo())
    expect(await doc.$('style[data-v-edit]')).not.toBeNull()
    await doc.$eval('#text', (el) => {
      el.textContent = 'Typed after undo'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect.poll(() => saved.html).toContain('Typed after undo')
    expect(saved.html).not.toContain('data-doop-name')
  })

  it('opens the element menu during inline text editing and preserves the final text', async () => {
    const doc = (await frameDoc())!
    const box = await (await doc.$('#text'))!.boundingBox()
    await page.mouse.click(box!.x + 20, box!.y + 10, { count: 2 })
    await doc.waitForSelector('style[data-v-edit]')
    await doc.$eval('#text', (el) => {
      el.textContent = 'Edited text'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await rightClick('#text')
    await choose('Copy HTML')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Edited text')
  })

  it('ignores a delayed hit from a dismissed menu when another element is right-clicked', async () => {
    const doc = (await frameDoc())!
    await doc.evaluate(() => {
      window.delayContextMessage = 'doop:context-hit'
    })
    await rightClick('#box', false)
    await page.waitForSelector('[role="menu"]')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
    await rightClick('#text')
    await doc.evaluate(() => window.releaseContextMessage?.())
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    expect(await page.evaluate(() => window.contextMenuHarness.selection())).toEqual({
      frameId: 'f',
      selector: '#text',
    })
    await choose('Copy HTML')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('id="text"')
  })

  it('keeps group actions on titles but restricts a surface action to its element', async () => {
    await page.evaluate((frame) => {
      window.contextMenuHarness.seed([frame, { ...frame, id: 'other', x: 600 }])
      window.contextMenuHarness.selectMany(['f', 'other'])
    }, saved)
    await page.click('[data-frame-title]', { button: 'right' })
    expect(await items()).toContain('Delete 2 frames')
    await page.keyboard.press('Escape')
    await rightClick('#box')
    expect(await items()).toContain('Delete element')
    expect(await items()).not.toContain('Delete 2 frames')
    await choose('Delete element')
    await expect.poll(() => saved.html).not.toContain('id="box"')
    expect(deletedFrames).toBe(0)
  })

  it('waits for the matching iframe document before using a position-based selector', async () => {
    const original = '<main><div style="height:40px">Keep</div><div style="height:40px">Target</div></main>'
    await page.evaluate((html) => window.contextMenuHarness.updateHtml(html), original)
    const doc = (await frameDoc())!
    await doc.waitForFunction(() => document.querySelector('main')?.textContent === 'KeepTarget')
    await doc.evaluate(() => {
      window.delayContextMessage = 'doop:html'
    })
    const updated = original.replace('<main>', '<main><div style="position:absolute;top:200px">Inserted</div>')
    await page.evaluate((html) => window.contextMenuHarness.updateHtml(html), updated)
    await doc.waitForFunction(() => !!window.releaseContextMessage)
    expect(await doc.$eval('main', (el) => el.textContent)).toBe('KeepTarget')
    await rightClick('main > div:nth-of-type(2)', false)
    await page.waitForFunction(() => document.querySelector('[role="menu"]')?.textContent === 'Finding element…')
    expect(await page.evaluate(() => window.contextMenuHarness.selection())).toBeNull()
    await doc.evaluate(() => window.releaseContextMessage?.())
    await page.waitForFunction(
      () =>
        window.contextMenuHarness.selection()?.selector ===
        'body:nth-of-type(1) > main:nth-of-type(1) > div:nth-of-type(3)',
    )
    await choose('Delete element')
    await expect.poll(() => saved.html).not.toContain('Target')
    expect(saved.html).toContain('Inserted')
    expect(saved.html).toContain('Keep')
  }, 20_000)

  it('disables a menu when a collaborator changes its document after it opens', async () => {
    await rightClick('#text')
    await page.evaluate((html) => window.contextMenuHarness.updateHtml(html), HTML.replace('Second element', 'Changed'))
    await page.waitForFunction(
      () => document.querySelector('[role="menu"]')?.textContent === 'Frame changed. Right-click again.',
    )
    expect(await items()).not.toContain('Delete element')
  })

  it('copies table rows and cells through the Layers menu', async () => {
    const table = '<table><tbody><tr id="row"><td id="cell">One</td><td>Two</td></tr></tbody></table>'
    await page.evaluate((html) => window.contextMenuHarness.updateHtml(html), table)
    const doc = (await frameDoc())!
    await doc.waitForSelector('#row')
    await rightClick('#cell')
    await page.keyboard.press('Escape')
    await page.click('[data-row-key="f|#row"]', { button: 'right' })
    await choose('Copy')
    await page.click('[data-row-key="f|#row"]', { button: 'right' })
    await choose('Paste')
    await doc.waitForSelector('tbody > tr#row-copy > td#cell-copy')
    await rightClick('#cell-copy')
    await choose('Copy')
    await page.click('[data-row-key="f|#cell"]', { button: 'right' })
    await choose('Paste')
    await doc.waitForSelector('#row > td#cell-copy-copy')
    expect(await doc.$eval('#row', (el) => el.children.length)).toBe(3)
  }, 20_000)
})
