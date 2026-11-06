import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Frame, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import type { TextFormatCommand } from '../src/lib/richText'
import type { ElementInfo, StylePatch } from '../src/lib/frameBridge'

type Fixture = {
  messages: { type: string; reqId?: string; html?: string; state?: Record<string, boolean>; info?: ElementInfo }[]
}

describe.skipIf(!findBrowserPath())('rich text editing', { timeout: 30_000 }, () => {
  let browser: TestBrowser
  let page: Page
  let frame: Frame

  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
  })
  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })
  beforeEach(async () => {
    await page.goto(fixtureUrl('frameReplay.html'))
    await page.waitForFunction(() =>
      (window as unknown as Fixture).messages?.some((m) => m.type === 'doop:frame-ready'),
    )
    frame = page.frames().find((f) => f !== page.mainFrame())!
  })

  async function send(message: Record<string, unknown>) {
    await page.evaluate(
      (message) => document.querySelector('iframe')!.contentWindow!.postMessage(message, '*'),
      message,
    )
  }
  async function render(html: string) {
    await send({ type: 'doop:html', html, reqId: 'render' })
    await frame.waitForSelector('#text')
    await send({ type: 'doop:edit', on: true, x: 20, y: 20 })
    await frame.waitForSelector('#text[contenteditable]')
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.type === 'doop:text-state'))
  }
  async function select(start: number, end: number) {
    await page.evaluate(() => {
      ;(window as unknown as Fixture).messages = []
    })
    await frame.evaluate(
      (start, end) => {
        // An identical selection would fire no selectionchange: clear it first.
        getSelection()!.removeAllRanges()
        const text = document.querySelector('#text')!.firstChild!
        getSelection()!.setBaseAndExtent(text, start, text, end)
      },
      start,
      end,
    )
    await frame.waitForFunction(() => getSelection()!.toString().length > 0)
    // Wait for the selectionchange message before acting from the parent.
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.type === 'doop:text-state'))
  }
  async function format(command: TextFormatCommand) {
    await page.evaluate(() => {
      ;(window as unknown as Fixture).messages = []
    })
    await send({ type: 'doop:text-format', command })
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.type === 'doop:edited'))
  }
  let nextReq = 0
  async function ask(type: 'doop:style' | 'doop:inspect', payload: Record<string, unknown>) {
    const reqId = `req-${++nextReq}`
    await send({ ...payload, type, reqId })
    await page.waitForFunction(
      (reqId) => (window as unknown as Fixture).messages.some((m) => m.reqId === reqId),
      {},
      reqId,
    )
    return page.evaluate((reqId) => (window as unknown as Fixture).messages.find((m) => m.reqId === reqId)!.info, reqId)
  }
  const style = (styles: StylePatch) => ask('doop:style', { selector: '#text', styles })
  const inspect = () => ask('doop:inspect', { selector: '#text' })
  async function savedHtml() {
    return page.evaluate(
      () => (window as unknown as Fixture).messages.filter((m) => m.type === 'doop:edited').at(-1)!.html!,
    )
  }

  it.each([
    ['bold', 'fontWeight', '700'],
    ['italic', 'fontStyle', 'italic'],
    ['underline', 'textDecorationLine', 'underline'],
    ['strikeThrough', 'textDecorationLine', 'line-through'],
  ] as const)('formats only selected text with %s and toggles it off', async (command, property, value) => {
    await render('<p id="text" style="margin:0;font:24px Arial">Hello world</p>')
    await select(0, 5)
    await format(command)
    const styles = await frame.$eval(
      '#text',
      (el, property) => ({
        selected: getComputedStyle(el.firstElementChild!)[property],
        rest: getComputedStyle(el)[property],
        text: el.textContent,
      }),
      property,
    )
    expect(styles).toEqual({ selected: value, rest: expect.not.stringContaining(value), text: 'Hello world' })
    expect(await frame.evaluate(() => getSelection()!.toString())).toBe('Hello')
    expect(await savedHtml()).not.toMatch(/contenteditable|data-v-active|data-v-boot/)
    await format(command)
    expect(
      await frame.$eval('#text', (el, property) => getComputedStyle(el.firstElementChild ?? el)[property], property),
    ).not.toContain(value)
  })

  it('creates separate bullets from multiline text and preserves them through reload and re-entry', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial;white-space:pre-wrap">One\nTwo</p>')
    await format('insertUnorderedList')
    expect(await frame.$$eval('#text li', (items) => items.map((li) => li.textContent))).toEqual(['One', 'Two'])
    const html = await savedHtml()
    await send({ type: 'doop:edit', on: false })
    await frame.waitForFunction(() => !document.querySelector('[contenteditable]'))
    expect(await frame.$('div#text ul')).not.toBeNull()
    await send({ type: 'doop:html', html, reqId: 'reload' })
    await frame.waitForSelector('div#text ul')
    expect(await frame.$$eval('#text li', (items) => items.map((li) => li.textContent))).toEqual(['One', 'Two'])
    await send({ type: 'doop:edit', on: true, x: 50, y: 20 })
    await frame.waitForSelector('#text[contenteditable]')
    await format('insertOrderedList')
    expect(await frame.$('#text ol')).not.toBeNull()
    await format('insertOrderedList')
    expect(await frame.$('#text ol')).toBeNull()
  })

  it('preserves existing list styling when applying inline formatting', async () => {
    await render(
      '<div id="text" data-doop-text style="margin:0;font:24px Arial"><ul style="list-style:square;margin:0;padding-left:20px"><li>Hello</li></ul></div>',
    )
    await format('bold')
    expect(await frame.$eval('#text ul', (el) => getComputedStyle(el).listStyleType)).toBe('square')
    expect(await frame.$eval('#text b', (el) => el.textContent)).toBe('Hello')
  })

  it('continues a list with Enter and leaves it on an empty item', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial">One</p>')
    await format('insertUnorderedList')
    await frame.evaluate(() => {
      const range = document.createRange()
      range.selectNodeContents(document.querySelector('#text li')!)
      range.collapse(false)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
    })
    await page.keyboard.press('Enter')
    await page.keyboard.type('Two')
    expect(await frame.$$eval('#text li', (items) => items.map((li) => li.textContent))).toEqual(['One', 'Two'])
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Outside')
    expect(await frame.$$eval('#text li', (items) => items.map((li) => li.textContent))).toEqual(['One', 'Two'])
    expect(await frame.$eval('#text', (el) => el.textContent)).toContain('Outside')
  })

  it('keeps the text root when clicking formatted words, and supports native undo and redo', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial">Hello world</p>')
    await select(0, 5)
    await format('bold')
    await frame.click('#text b')
    expect(await frame.$eval('[contenteditable]', (el) => el.id)).toBe('text')
    await frame.evaluate(() => document.execCommand('undo'))
    expect(await frame.$('#text b')).toBeNull()
    await frame.evaluate(() => document.execCommand('redo'))
    expect(await frame.$('#text b')).not.toBeNull()
  })

  it('supports formatting shortcuts and plain-text paste without importing clipboard markup', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial">Hello world</p>')
    await select(0, 5)
    await page.keyboard.down('Control')
    await page.keyboard.press('i')
    await page.keyboard.up('Control')
    await frame.waitForSelector('#text i')
    await frame.evaluate(() => {
      const clipboard = new DataTransfer()
      clipboard.setData('text/plain', '<b>literal</b>')
      clipboard.setData('text/html', '<img src="x" onerror="alert(1)">')
      document
        .querySelector('#text')!
        .dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
    })
    expect(await frame.$eval('#text', (el) => el.textContent)).toBe('<b>literal</b> world')
    expect(await frame.$('#text img')).toBeNull()
  })

  it('scopes Design panel text styles to the selected run and reports the layer as mixed', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial">Hello world</p>')
    await select(0, 5)
    const selected = await style({ 'font-size': '32px' })
    expect(selected).toMatchObject({ fontSize: 32, textMixed: {} })
    const sizes = await frame.$eval('#text', (el) => ({
      run: getComputedStyle(el.firstElementChild!).fontSize,
      runText: el.firstElementChild!.textContent,
      rest: getComputedStyle(el).fontSize,
      fontFamily: el.firstElementChild!.getAttribute('style'),
    }))
    expect(sizes).toEqual({ run: '32px', runText: 'Hello', rest: '24px', fontFamily: 'font-size: 32px;' })
    expect(await frame.evaluate(() => getSelection()!.toString())).toBe('Hello')
    // A second edit lands on the same run rather than nesting a new one.
    await style({ color: 'rgb(255, 0, 0)' })
    expect(await frame.$$eval('#text span', (runs) => runs.map((r) => r.getAttribute('style')))).toEqual([
      'font-size: 32px; color: rgb(255, 0, 0);',
    ])
    await send({ type: 'doop:edit', on: false })
    await frame.waitForFunction(() => !document.querySelector('[contenteditable]'))
    expect(await inspect()).toMatchObject({ hasText: true, textMixed: { fontSize: true, color: true } })
    await expect.poll(savedHtml).toContain('<span style="font-size: 32px; color: rgb(255, 0, 0);">Hello</span> world')
  })

  it('makes a mixed layer uniform when a value is set on the whole element', async () => {
    await render(
      '<p id="text" style="margin:0;font:24px Arial"><span style="font-size: 32px; color: red">Hello</span> <b>world</b></p>',
    )
    expect(await inspect()).toMatchObject({ textMixed: { fontSize: true, color: true, fontWeight: true } })
    await style({ 'font-size': '20px' })
    const after = await inspect()
    expect(after).toMatchObject({ fontSize: 20, textMixed: { color: true, fontWeight: true } })
    expect(await frame.$eval('#text span', (el) => el.getAttribute('style'))).toBe('color: red;')
    await style({ color: 'rgb(0, 0, 255)' })
    expect(await frame.$eval('#text span', (el) => el.hasAttribute('style'))).toBe(false)
    expect((await inspect())?.textMixed).toEqual({ fontWeight: true })
  })

  it('treats an edited paragraph turned list as one text layer', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial;white-space:pre-wrap">One\nTwo</p>')
    await format('insertUnorderedList')
    expect(await inspect()).toMatchObject({ hasText: true, fontSize: 24 })
    await send({ type: 'doop:edit', on: false })
    await frame.waitForFunction(() => !document.querySelector('[contenteditable]'))
    expect(await inspect()).toMatchObject({ hasText: true, textMixed: {} })
  })

  it('formats whole layers from the canvas: a mixed layer becomes uniform, a uniform one toggles off', async () => {
    await send({
      type: 'doop:html',
      html: '<p id="text" style="margin:0;font:24px Arial">Hello <b>world</b></p><p>Keep</p>',
      reqId: 'render',
    })
    await frame.waitForSelector('#text')
    const formatLayers = async (selectors: string[], command: TextFormatCommand) => {
      const reqId = `layers-${++nextReq}`
      await send({ type: 'doop:text-format', selectors, command, reqId })
      await page.waitForFunction(
        (reqId) => (window as unknown as Fixture).messages.some((m) => m.reqId === reqId),
        {},
        reqId,
      )
      return page.evaluate(
        (reqId) =>
          (window as unknown as Fixture).messages.find((m) => m.reqId === reqId) as unknown as {
            selectors: string[] | null
          },
        reqId,
      )
    }
    expect((await formatLayers(['#text'], 'bold')).selectors).toEqual(['#text'])
    expect(await frame.$eval('#text b', (el) => el.textContent)).toBe('Hello world')
    expect(await frame.$('[contenteditable]')).toBeNull()
    expect(await inspect()).toMatchObject({ fontWeight: '700', textMixed: {} })
    await expect.poll(savedHtml).not.toMatch(/contenteditable/)
    await formatLayers(['#text'], 'bold')
    expect(await frame.$eval('#text', (el) => getComputedStyle(el).fontWeight)).toBe('400')
    expect(await frame.$('#text b')).toBeNull()
    // A paragraph turned list changes tag; the reply carries each layer's selector afterwards.
    expect((await formatLayers(['#text', 'body > p:nth-of-type(2)'], 'insertUnorderedList')).selectors).toEqual([
      '#text',
      'body:nth-of-type(1) > div:nth-of-type(2)',
    ])
    expect(await frame.$$eval('li', (items) => items.map((li) => li.textContent))).toEqual(['Hello world', 'Keep'])
    // Locked layers and edits in progress are left alone.
    await send({ type: 'doop:html', html: '<p id="text" data-doop-locked>Hello</p>', reqId: 'locked' })
    await frame.waitForSelector('#text[data-doop-locked]')
    expect((await formatLayers(['#text'], 'bold')).selectors).toEqual(['#text'])
    expect(await frame.$('#text b')).toBeNull()
  })

  it("keeps a run's own font when another text property changes on it", async () => {
    await render(
      '<p id="text" style="margin:0;font:24px Arial"><span style="font-family: Georgia">Hello</span> world</p>',
    )
    await page.evaluate(() => {
      ;(window as unknown as Fixture).messages = []
    })
    await frame.evaluate(() => {
      const text = document.querySelector('#text span')!.firstChild!
      getSelection()!.setBaseAndExtent(text, 0, text, 5)
    })
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.type === 'doop:text-state'))
    await style({ 'font-size': '32px' })
    expect(await frame.$$eval('#text span', (runs) => runs.map((r) => r.getAttribute('style')))).toEqual([
      'font-family: Georgia; font-size: 32px;',
    ])
  })

  it('takes the boldness of <b> runs along when a weight is set on the whole layer', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial">Hello <b data-doop-id="w">world</b></p>')
    expect((await inspect())?.textMixed).toEqual({ fontWeight: true })
    await style({ 'font-weight': '400' })
    expect(await frame.$eval('#text', (el) => el.innerHTML)).toBe('Hello <span data-doop-id="w">world</span>')
    expect((await inspect())?.textMixed).toEqual({})
  })

  it('restores a cancelled size scrub on selected words and saves a committed one once', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial">Hello world</p>')
    await select(0, 5)
    const gesture = (phase: 'begin' | 'commit' | 'cancel') =>
      ask('doop:style-gesture' as 'doop:style', { selector: '#text', phase })
    await gesture('begin')
    await style({ 'font-size': '30px' })
    await style({ 'font-size': '36px' })
    expect(await frame.$eval('#text span', (el) => el.getAttribute('style'))).toBe('font-size: 36px;')
    await page.evaluate(() => {
      ;(window as unknown as Fixture).messages = []
    })
    await gesture('cancel')
    expect(await frame.$eval('#text', (el) => el.innerHTML)).toBe('Hello world')
    await send({ type: 'doop:settle', reqId: 'settled' })
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.reqId === 'settled'))
    expect(
      await page.evaluate(() => (window as unknown as Fixture).messages.filter((m) => m.type === 'doop:edited')),
    ).toEqual([])
    await select(0, 5)
    await gesture('begin')
    await style({ 'font-size': '40px' })
    await gesture('commit')
    await expect.poll(savedHtml).toContain('<span style="font-size: 40px;">Hello</span> world')
  })

  it('saves pending typing before a scrub on selected words, so a cancel leaves nothing of the preview', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial">Hello world</p>')
    await frame.evaluate(() => {
      const text = document.querySelector('#text')!.firstChild!
      getSelection()!.setBaseAndExtent(text, 11, text, 11)
    })
    await page.keyboard.type('!')
    await select(0, 5)
    await ask('doop:style-gesture' as 'doop:style', { selector: '#text', phase: 'begin' })
    await style({ 'font-size': '36px' })
    await ask('doop:style-gesture' as 'doop:style', { selector: '#text', phase: 'cancel' })
    await send({ type: 'doop:settle', reqId: 'settled' })
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.reqId === 'settled'))
    await new Promise((r) => setTimeout(r, 500))
    const html = await savedHtml()
    expect(html).toContain('Hello world!')
    expect(html).not.toContain('36px')
  })

  it('keeps editing scoped to the item when a list holds a locked item', async () => {
    await send({
      type: 'doop:html',
      html: '<ul><li id="text">Editable</li><li data-doop-locked>Locked</li></ul>',
      reqId: 'render',
    })
    await frame.waitForSelector('#text')
    const item = await frame.$eval('#text', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await send({ type: 'doop:edit', on: true, x: item.x, y: item.y })
    await frame.waitForSelector('[contenteditable]')
    expect(await frame.$eval('[contenteditable]', (el) => el.id)).toBe('text')
  })

  it('answers every selector afresh when a retagged layer shifts its neighbours', async () => {
    await send({
      type: 'doop:html',
      html: '<p style="margin:0">One</p><div style="margin:0">Two</div>',
      reqId: 'render',
    })
    await frame.waitForSelector('div')
    const reqId = 'shift'
    await send({
      type: 'doop:text-format',
      selectors: ['body > p:nth-of-type(1)', 'body > div:nth-of-type(1)'],
      command: 'insertUnorderedList',
      reqId,
    })
    await page.waitForFunction(
      (reqId) => (window as unknown as Fixture).messages.some((m) => m.reqId === reqId),
      {},
      reqId,
    )
    const reply = await page.evaluate(
      (reqId) =>
        (window as unknown as Fixture).messages.find((m) => m.reqId === reqId) as unknown as { selectors: string[] },
      reqId,
    )
    expect(reply.selectors).toEqual([
      'body:nth-of-type(1) > div:nth-of-type(1)',
      'body:nth-of-type(1) > div:nth-of-type(2)',
    ])
    expect(await frame.$$eval('div', (divs) => divs.map((d) => d.textContent))).toEqual(['One', 'Two'])
  })

  it('puts a Design panel edit on selected words into the native undo history', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial">Hello world</p>')
    await select(0, 5)
    await style({ color: 'rgb(255, 0, 0)' })
    expect(await frame.$eval('#text', (el) => el.innerHTML)).toBe(
      '<span style="color: rgb(255, 0, 0);">Hello</span> world',
    )
    await frame.evaluate(() => document.execCommand('undo'))
    expect(await frame.$eval('#text', (el) => el.innerHTML)).toBe('Hello world')
    await frame.evaluate(() => document.execCommand('redo'))
    expect(await frame.$eval('#text', (el) => el.innerHTML)).toBe(
      '<span style="color: rgb(255, 0, 0);">Hello</span> world',
    )
  })

  it('keeps what a paragraph owed to its rules when a list turns it into a div', async () => {
    await send({
      type: 'doop:html',
      html:
        '<style>p.card{padding:10px;background:rgb(0, 128, 0);border:2px solid rgb(0, 0, 255)}</style>' +
        '<p id="text" class="card" style="font:24px Arial">One</p>',
      reqId: 'render',
    })
    await frame.waitForSelector('#text')
    const at = await frame.$eval('#text', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await send({ type: 'doop:edit', on: true, x: at.x, y: at.y })
    await frame.waitForSelector('#text[contenteditable]')
    await format('insertUnorderedList')
    await send({ type: 'doop:edit', on: false })
    await frame.waitForSelector('div#text')
    const styles = await frame.$eval('div#text', (el) => {
      const cs = getComputedStyle(el)
      return [cs.paddingLeft, cs.backgroundColor, cs.borderTopWidth, cs.marginTop, cs.fontSize]
    })
    expect(styles).toEqual(['10px', 'rgb(0, 128, 0)', '2px', '24px', '24px'])
    const inline = (await savedHtml()).match(/<div id="text"[^>]*style="([^"]*)"/)?.[1]
    expect(inline).not.toMatch(/(^|;\s*)(width|height|transform-origin):/)
  })

  it('formats an existing list layer whole and shows its text in the panel', async () => {
    await send({ type: 'doop:html', html: '<ul id="text"><li>One</li><li>Two</li></ul>', reqId: 'render' })
    await frame.waitForSelector('#text')
    expect(await inspect()).toMatchObject({ hasText: true, textMixed: {} })
    const reqId = 'list-layer'
    await send({ type: 'doop:text-format', selectors: ['#text'], command: 'bold', reqId })
    await page.waitForFunction(
      (reqId) => (window as unknown as Fixture).messages.some((m) => m.reqId === reqId),
      {},
      reqId,
    )
    expect(await frame.$$eval('#text li b', (runs) => runs.map((r) => r.textContent))).toEqual(['One', 'Two'])
  })

  it('ignores commands after editing ends and on locked text', async () => {
    await render('<p id="text" style="margin:0;font:24px Arial">Hello world</p>')
    await send({ type: 'doop:edit', on: false })
    await frame.waitForFunction(() => !document.querySelector('[contenteditable]'))
    await send({ type: 'doop:text-format', command: 'bold' })
    await send({ type: 'doop:html', html: '<p id="text" data-doop-locked>Hello world</p>' })
    await frame.waitForSelector('#text[data-doop-locked]')
    await send({ type: 'doop:edit', on: true, x: 20, y: 20 })
    await send({ type: 'doop:text-format', command: 'bold' })
    await send({ type: 'doop:settle', reqId: 'settled' })
    await page.waitForFunction(() => (window as unknown as Fixture).messages.some((m) => m.reqId === 'settled'))
    expect(await frame.$('[contenteditable]')).toBeNull()
    expect(await frame.$('#text b')).toBeNull()
  })
})
