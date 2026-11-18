import { beforeEach, describe, expect, it } from 'vitest'
import type { Frame as BrowserFrame, Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { CSS_ATTR, HEAD_ATTR, type WireComponentDef } from '../shared/components'
import { TOKEN_BLOCK_ATTR, type DesignToken } from '../shared/designTokens'
import type { Canvas } from '../shared/types'
import { pagePerTest } from './browser'
import { canvasFrame, openCanvasPage } from './canvasPageFixture'

/* The store holds each frame's source; the canvas page composes the canvas's
   component stylesheets and token values into what it posts to the frame's
   document. So a frame shows them without carrying them, restyles when the
   store's tokens or components change with no frame update, and what an edit
   in the frame saves is the source again. */
describe.skipIf(!findBrowserPath())('shared styles in a mounted frame', () => {
  const pages = pagePerTest()
  let page: Page
  let patches: { html?: string }[]

  const token = (name: string, value: string, order: number): DesignToken => ({
    name,
    type: 'color',
    value,
    order,
    updatedAt: 0,
    updatedBy: 'Tester',
  })
  const TOKENS = [token('--ink', 'rgb(255, 0, 0)', 1), token('--unused', 'rgb(1, 2, 3)', 2)]
  const BUTTON: WireComponentDef = {
    id: 'cbutton',
    name: 'Button',
    description: '',
    template:
      '<button class="btn" data-doop-part="r"><span data-doop-part="a" data-doop-prop="label">Buy</span></button>',
    css: ':where([data-doop-instance="cbutton"]).btn { background-color: rgb(0, 0, 255); border: 0 }',
    rawCss: '.btn { background-color: rgb(0, 0, 255); border: 0 }',
    head: [],
    props: [{ name: 'label', type: 'text' }],
    slots: [],
    rev: 1,
    mainFrameId: null,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'Tester',
  }
  /* a frame's source: it names a token and holds an instance, and carries neither's styles */
  const SOURCE =
    '<!doctype html><html><head><style>body{margin:0}</style></head><body>' +
    '<h1 style="margin:0;color:var(--ink)">Title</h1>' +
    '<button class="btn" data-doop-instance="cbutton" data-doop-rev="1" data-doop-id="i1"><span data-doop-part="a">Go</span></button>' +
    '</body></html>'
  const FRAME = { ...canvasFrame({ id: 'card', name: 'Card', x: 0, y: 0, width: 400, height: 300 }), html: SOURCE }
  const SHARED = [TOKEN_BLOCK_ATTR, CSS_ATTR, HEAD_ATTR]

  beforeEach(async () => {
    patches = []
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1400, height: 900 })
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/frames/card')
        patches.push(JSON.parse(request.postData() ?? '{}') as { html?: string })
    })
    await openCanvasPage(page, [FRAME], '', { tokens: TOKENS, components: [BUTTON] } as Partial<Canvas>)
  })

  const frameDocument = async (): Promise<BrowserFrame> =>
    (await (await page.waitForSelector('iframe[data-doop-frame]'))!.contentFrame())!
  const colorOf = (doc: BrowserFrame, selector: string, property: 'color' | 'backgroundColor') =>
    doc.$eval(selector, (el, property) => getComputedStyle(el)[property], property)
  const waitForColor = (doc: BrowserFrame, selector: string, property: 'color' | 'backgroundColor', value: string) =>
    doc.waitForFunction(
      (selector, property, value) => {
        const el = document.querySelector(selector)
        return !!el && getComputedStyle(el)[property] === value
      },
      {},
      selector,
      property,
      value,
    )

  it('shows the token values and component rules the store holds, composed into the document', async () => {
    const doc = await frameDocument()
    await waitForColor(doc, 'h1', 'color', 'rgb(255, 0, 0)')
    await waitForColor(doc, '.btn', 'backgroundColor', 'rgb(0, 0, 255)')
    /* in the frame's document, not in the store's copy of the frame */
    expect(await doc.$(`style[${TOKEN_BLOCK_ATTR}]`)).not.toBeNull()
    expect(await doc.$(`style[${CSS_ATTR}="cbutton"]`)).not.toBeNull()
    expect(await doc.$eval(`style[${TOKEN_BLOCK_ATTR}]`, (el) => el.textContent)).not.toContain('--unused')
    expect(await page.evaluate(() => window.canvasPageHarness.frameHtml('card'))).toBe(SOURCE)
  })

  it('restyles when the store’s tokens or a component’s rules change, with no frame update', async () => {
    const doc = await frameDocument()
    await waitForColor(doc, 'h1', 'color', 'rgb(255, 0, 0)')
    await page.evaluate(
      (tokens) => window.canvasPageHarness.setTokens(tokens, []),
      TOKENS.map((entry) => (entry.name === '--ink' ? { ...entry, value: 'rgb(0, 128, 0)' } : entry)),
    )
    await waitForColor(doc, 'h1', 'color', 'rgb(0, 128, 0)')
    await page.evaluate((component) => window.canvasPageHarness.setComponent(component), {
      ...BUTTON,
      rev: 2,
      css: BUTTON.css.replace('rgb(0, 0, 255)', 'rgb(128, 0, 128)'),
    })
    await waitForColor(doc, '.btn', 'backgroundColor', 'rgb(128, 0, 128)')
    /* the frame itself never changed, and nothing was saved */
    expect(await page.evaluate(() => window.canvasPageHarness.frameHtml('card'))).toBe(SOURCE)
    expect(patches).toEqual([])
    /* the document kept its nodes: the change was the style blocks alone */
    expect(await colorOf(doc, 'h1', 'color')).toBe('rgb(0, 128, 0)')
  })

  it('saves an edit made in the frame as its source', async () => {
    const doc = await frameDocument()
    await waitForColor(doc, '.btn', 'backgroundColor', 'rgb(0, 0, 255)')
    const inner = await doc.$eval('h1', (el) => el.getBoundingClientRect().toJSON())
    const outer = await page.$eval('iframe[data-doop-frame]', (el) => el.getBoundingClientRect().toJSON())
    const zoom = outer.width / FRAME.width
    await page.mouse.click(outer.x + (inner.x + 5) * zoom, outer.y + (inner.y + 5) * zoom, { count: 2 })
    await doc.waitForSelector('[contenteditable]')
    await page.keyboard.type('Edited')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.canvasPageHarness.frameHtml('card').includes('Edited'))
    const stored = await page.evaluate(() => window.canvasPageHarness.frameHtml('card'))
    for (const mark of SHARED) expect(stored).not.toContain(mark)
    expect(stored).toContain('color:var(--ink)')
    expect(stored).toContain('data-doop-instance="cbutton"')
    expect(patches.length).toBeGreaterThan(0)
    for (const patch of patches) for (const mark of SHARED) expect(patch.html ?? '').not.toContain(mark)
    expect(patches.at(-1)!.html).toContain('Edited')
    /* and the frame still shows the canvas's styles after the save came back */
    expect(await colorOf(doc, 'h1', 'color')).toBe('rgb(255, 0, 0)')
    expect(await colorOf(doc, '.btn', 'backgroundColor')).toBe('rgb(0, 0, 255)')
  })
})
