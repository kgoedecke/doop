import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot'
import type { Frame } from '../shared/types'
import type { ElementInfo, GeometryEdit } from '../src/lib/frameBridge'

declare global {
  interface Window {
    elementPanelHarness: {
      seed: (frame: Frame) => void
      remote: (frame: Frame) => void
      select: (selector: string) => void
      selectFrame: () => void
      deselect: () => void
      picked: () => string[]
      setTool: (tool: 'select' | 'hand') => void
      setZoom: (zoom: number) => void
      undo: () => Promise<void>
      geometry: (selector: string, edit: GeometryEdit) => Promise<ElementInfo | null>
      redo: () => Promise<void>
    }
  }
}

describe.skipIf(!findBrowserPath())('element design controls', () => {
  let vite: ViteDevServer
  let browser: Browser
  let page: Page
  let saved: Frame
  let seedId = 0
  let uploadStatus = 200
  let uploadGate: Promise<void> | null = null
  let imageDir: string
  const replacementSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="coral"/></svg>'
  const replacementUrl = `data:image/svg+xml;base64,${Buffer.from(replacementSvg).toString('base64')}`
  const originalUrl = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="teal"/></svg>').toString('base64')}`
  const errors: string[] = []
  beforeAll(async () => {
    imageDir = mkdtempSync(path.join(tmpdir(), 'doop-image-fill-'))
    writeFileSync(path.join(imageDir, 'replacement.svg'), replacementSvg)
    vite = await createServer({ server: { port: 0 }, logLevel: 'error' })
    await vite.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.setViewport({ width: 1000, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      if (new URL(request.url()).pathname === '/api/canvases/c/assets') {
        await uploadGate
        await request.respond({
          status: uploadStatus,
          contentType: 'application/json',
          body: JSON.stringify(
            uploadStatus === 200
              ? { url: replacementUrl, mime: 'image/svg+xml', size: replacementSvg.length }
              : { error: 'Upload failed. Please try again.' },
          ),
        })
        return
      }
      // The delayed-font test releases this stylesheet after the panel's first read.
      if (new URL(request.url()).pathname === '/tests/fixtures/late-font.css') return
      if (new URL(request.url()).pathname === '/api/frames/f' && request.method() === 'PATCH') {
        saved = { ...saved, ...JSON.parse(request.postData()!) }
        await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) })
      } else await request.continue()
    })
    await page.goto(`${vite.resolvedUrls!.local[0]}tests/fixtures/elementPanel.html`)
    await page.waitForFunction(() => !!window.elementPanelHarness)
    saved = {
      id: 'f',
      canvasId: 'c',
      name: 'Typography',
      x: 40,
      y: 60,
      width: 600,
      height: 500,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: 'Tester',
      html: `<!doctype html><html><head><style>
        @font-face { font-family: "Editorial Face"; src: local("Arial"); font-weight: 400 }
        @font-face { font-family: "Editorial Face"; src: local("Arial"); font-weight: 700 }
        @font-face { font-family: "Display Face"; src: local("Courier New") }
        body { font-family: "Editorial Face", serif; padding: 24px }
        p { font-size: 24px; width: 450px }
      </style></head><body>
        <p id="text">Typography controls should edit the selected text and save it to the frame.</p>
        <p id="rtl" dir="rtl">مرحبا بالعالم</p>
        <p id="rtl-end" dir="rtl" style="text-align:end">مرحبا بالعالم</p>
      </body></html>`,
    }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    const iframe = (await (await page.waitForSelector('iframe'))!.contentFrame())!
    await iframe.waitForSelector('#text')
    await page.evaluate(() => window.elementPanelHarness.select('#text'))
    await page.waitForSelector('select[aria-label="Font family"]')
  }, 60_000)

  afterAll(async () => {
    await page?.screenshot({ path: '/tmp/narwhal-element-panel.png' })
    await page?.close()
    await browser?.close()
    await vite?.close()
    if (imageDir) rmSync(imageDir, { recursive: true, force: true })
    expect(errors).toEqual([])
  })

  it('edits fonts and alignment through the sandbox, persists them, and supports undo and RTL', async () => {
    const selector = 'select[aria-label="Font family"]'
    const frame = (await (await page.$('iframe'))!.contentFrame())!
    const initial = await page.$eval(selector, (el) => (el as HTMLSelectElement).value)
    expect(initial).toBe('"Editorial Face", serif')
    expect(
      await page.$$eval(
        `${selector} option`,
        (options) => options.filter((o) => o.textContent === 'Editorial Face').length,
      ),
    ).toBe(1)
    expect(await page.$eval('[aria-label="Align left"]', (el) => el.getAttribute('data-state'))).toBe('on')

    await page.select(selector, 'Georgia, serif')
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('#text')!).fontFamily === 'Georgia, serif',
    )
    await expect.poll(() => saved.html).toContain('font-family: Georgia, serif')
    await page.evaluate(() => window.elementPanelHarness.undo())
    await page.waitForFunction(
      (value) => document.querySelector<HTMLSelectElement>('select[aria-label="Font family"]')?.value === value,
      {},
      initial,
    )
    expect(await frame.$eval('#text', (el) => getComputedStyle(el).fontFamily)).toBe(initial)

    const displayFace = await page.$eval(
      selector,
      (el) =>
        Array.from((el as HTMLSelectElement).options).find((option) => option.textContent === 'Display Face')!.value,
    )
    await page.select(selector, displayFace)
    await frame.waitForFunction(() =>
      getComputedStyle(document.querySelector('#text')!).fontFamily.includes('Display Face'),
    )
    await page.select(selector, 'Georgia, serif')
    await page.click('[aria-label="Align center"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#text')!).textAlign === 'center')
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Align right')
    await page.keyboard.press('Space')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#text')!).textAlign === 'right')
    await page.click('[aria-label="Justify"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#text')!).textAlign === 'justify')
    await expect.poll(() => saved.html).toContain('text-align: justify')
    await page.screenshot({ path: '/tmp/narwhal-element-panel.png' })

    await page.evaluate(() => window.elementPanelHarness.select('#rtl'))
    await page.waitForSelector('[aria-label="Align right"][data-state="on"]')
    await page.waitForFunction(() => !document.querySelector('[aria-busy]'))
    expect(await page.$eval(selector, (el) => (el as HTMLSelectElement).value)).toBe(initial)
    await page.evaluate(() => window.elementPanelHarness.select('#rtl-end'))
    await page.waitForSelector('[aria-label="Align left"][data-state="on"]')
    await page.waitForFunction(() => !document.querySelector('[aria-busy]'))
    await page.click('[aria-label="Align center"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#rtl-end')!).textAlign === 'center')
    expect(await frame.$eval('#text', (el) => getComputedStyle(el).textAlign)).toBe('justify')
  }, 30_000)

  it('offers unused fonts when a linked stylesheet arrives after inspection', async () => {
    const stylesheetRequest = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/tests/fixtures/late-font.css',
    )
    saved = {
      ...saved,
      html: `<!doctype html><html><head>
        <link rel="stylesheet" href="/tests/fixtures/late-font.css">
      </head><body>
        <p id="late-text" style="font-family:Arial,sans-serif">Waiting for font choices</p>
      </body></html>`,
    }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    const frame = (await (await page.$('iframe'))!.contentFrame())!
    await frame.waitForSelector('#late-text')
    await page.evaluate(() => window.elementPanelHarness.select('#late-text'))
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLSelectElement>('select[aria-label="Font family"]')?.value === 'Arial, sans-serif',
    )
    const options = 'select[aria-label="Font family"] option'
    expect(await page.$$eval(options, (options) => options.map((o) => o.textContent))).not.toContain('Late Arrival')

    await (
      await stylesheetRequest
    ).respond({
      status: 200,
      contentType: 'text/css',
      body: '@font-face { font-family: "Late Arrival"; src: local("Arial") }',
    })
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('select[aria-label="Font family"] option')).some(
        (option) => option.textContent === 'Late Arrival',
      ),
    )
    // The font is unused: no font load (and hence no loadingdone event) was needed.
    expect(
      await frame.evaluate(
        () => Array.from(document.fonts).find((font) => font.family.includes('Late Arrival'))?.status,
      ),
    ).toBe('unloaded')
  }, 15_000)
  async function selectLayer(selector: string) {
    await page.evaluate(async (value) => {
      window.elementPanelHarness.select(value)
      await new Promise(requestAnimationFrame)
    }, selector)
    await page.waitForFunction(() => !document.querySelector('[aria-busy]'))
  }

  async function seedPanel(html: string, selector: string, width = '120') {
    const fixture = String(++seedId)
    saved = { ...saved, html: html.replace('<body', `<body data-panel-fixture="${fixture}"`) }
    await page.evaluate((value) => window.elementPanelHarness.seed(value), saved)
    const frame = (await (await page.waitForSelector('iframe'))!.contentFrame())!
    await frame.waitForFunction((fixture) => document.body.dataset.panelFixture === fixture, {}, fixture)
    await frame.waitForSelector(selector)
    await selectLayer(selector)
    // Selection may initially show the previous read while the new one is debounced.
    await page.waitForFunction(
      (width) => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === width,
      {},
      width,
    )
    return frame
  }

  async function chooseReplacement() {
    if (!(await page.$('[aria-label="Image fill settings"]'))) await page.click('[aria-label="Image fill"]')
    const chooser = page.waitForFileChooser()
    await page.click('[aria-label="Upload image"]')
    await (await chooser).accept([path.join(imageDir, 'replacement.svg')])
  }

  it.each([false, true])(
    'opens image settings, shows upload for hover or touch, and dismisses with Escape (touch: %s)',
    async (hasTouch) => {
      await page.setViewport({ width: 1000, height: 900, hasTouch })
      await page.waitForFunction(() => !!window.elementPanelHarness)
      try {
        await seedPanel(
          `<body><img id="photo" src="${originalUrl}" style="width:120px;height:80px;object-fit:cover"></body>`,
          '#photo',
        )
        await page.waitForSelector('[aria-label="Image fill"]')
        expect(await page.$eval('[aria-label="Image fill"]', (el) => el.textContent?.trim())).toBe('Image')
        await page.click('[aria-label="Image fill"]')
        await page.waitForSelector('[aria-label="Image fill settings"]')
        const placement = await page.evaluate(() => {
          const panel = document.querySelector('[aria-label="Image fill settings"]')!.getBoundingClientRect()
          const trigger = document.querySelector('[aria-label="Image fill"]')!.getBoundingClientRect()
          return {
            right: panel.right,
            left: panel.left,
            top: panel.top,
            bottom: panel.bottom,
            triggerLeft: trigger.left,
          }
        })
        expect(placement.right).toBeLessThan(placement.triggerLeft)
        expect(placement.left).toBeGreaterThanOrEqual(12)
        expect(placement.top).toBeGreaterThanOrEqual(12)
        expect(placement.bottom).toBeLessThanOrEqual(888)
        expect(await page.$eval('[aria-label="Image URL"]', (el) => (el as HTMLInputElement).value)).toBe(originalUrl)
        await expect
          .poll(
            async () => {
              // Reposition the pointer if fonts or collision handling move the
              // newly opened editor. Touch users must see the action without hover.
              if (!hasTouch) await page.hover('[aria-label="Upload image"]')
              return page.$eval('[aria-label="Upload image"] > span', (el) => getComputedStyle(el).opacity)
            },
            { timeout: 5000 },
          )
          .toBe('1')
        await page.screenshot({ path: '/tmp/doop-image-fill-editor.png' })
        await page.keyboard.press('Escape')
        await page.waitForSelector('[aria-label="Image fill settings"]', { hidden: true })
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Image fill')
      } finally {
        await page.setViewport({ width: 1000, height: 900, hasTouch: false })
        await page.waitForFunction(() => !!window.elementPanelHarness)
      }
    },
    15_000,
  )

  it('validates image URLs, replaces through Enter, and persists sizing with undo', async () => {
    const frame = await seedPanel(
      `<body><img id="photo" src="${originalUrl}" style="width:120px;height:80px;object-fit:cover"></body>`,
      '#photo',
    )
    await page.waitForSelector('[aria-label="Image fill"]')
    await page.click('[aria-label="Image fill"]')
    const before = saved.html
    await number('Image URL', 'javascript:alert(1)')
    await page.waitForSelector('[role="alert"]')
    expect(saved.html).toBe(before)
    await number('Image URL', 'data:image/png;base64,aGVsbG8=')
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes('Couldn’t load'))
    expect(saved.html).toBe(before)
    await number('Image URL', replacementUrl)
    await expect.poll(() => saved.html).toContain(replacementUrl)
    await page.waitForFunction(() => !document.querySelector('[aria-busy]'))
    await page.select('[aria-label="Image sizing"]', 'contain')
    await expect.poll(() => saved.html).toContain('object-fit: contain')
    expect(await frame.$eval('#photo', (el) => [getComputedStyle(el).width, getComputedStyle(el).height])).toEqual([
      '120px',
      '80px',
    ])
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#photo')!).objectFit === 'cover')
    await page.waitForFunction(
      () => document.querySelector<HTMLSelectElement>('[aria-label="Image sizing"]')?.value === 'cover',
    )
    await page.evaluate(() => window.elementPanelHarness.redo())
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#photo')!).objectFit === 'contain')
    await page.waitForFunction(
      () => document.querySelector<HTMLSelectElement>('[aria-label="Image sizing"]')?.value === 'contain',
    )
    for (const mode of ['fill', 'none', 'scale-down', 'cover']) {
      await page.select('[aria-label="Image sizing"]', mode)
      await frame.waitForFunction(
        (mode) => getComputedStyle(document.querySelector('#photo')!).objectFit === mode,
        {},
        mode,
      )
    }
    await expect.poll(() => saved.html).toContain('object-fit: cover')
  }, 20_000)

  it('replaces responsive images from a local file, preserving their box and supporting undo/redo', async () => {
    const frame = await seedPanel(
      `<body><picture><source srcset="${originalUrl}"><img id="photo" src="${originalUrl}" srcset="${originalUrl}" sizes="100vw" alt="A landscape" style="object-fit:cover;border-radius:12px"></picture></body>`,
      '#photo',
    )
    await page.waitForSelector('[aria-label="Image fill"]')
    await chooseReplacement()
    await expect.poll(() => saved.html).toContain(replacementUrl)
    await frame.waitForFunction(
      (url) => document.querySelector<HTMLImageElement>('#photo')?.currentSrc === url,
      {},
      replacementUrl,
    )
    expect(
      await frame.$eval('#photo', (el) => {
        const cs = getComputedStyle(el)
        return {
          width: cs.width,
          height: cs.height,
          fit: cs.objectFit,
          radius: cs.borderRadius,
          alt: el.getAttribute('alt'),
          srcset: el.getAttribute('srcset'),
        }
      }),
    ).toEqual({ width: '120px', height: '80px', fit: 'cover', radius: '12px', alt: 'A landscape', srcset: null })
    expect(await frame.$('source')).toBeNull()
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForSelector('source')
    expect(saved.html).not.toContain(replacementUrl)
    await page.evaluate(() => window.elementPanelHarness.redo())
    await expect.poll(() => saved.html).toContain(replacementUrl)
    await page.waitForFunction(
      (url) => document.querySelector<HTMLImageElement>('[aria-label="Image fill"] img')?.src === url,
      {},
      replacementUrl,
    )
    await page.screenshot({ path: '/tmp/doop-image-fill.png' })
  })

  it('replaces CSS image fills without changing their positioning or background color', async () => {
    const frame = await seedPanel(
      `<body><div id="photo" style="width:120px;height:80px;background: #123456 url('${originalUrl}') center / cover no-repeat"></div></body>`,
      '#photo',
    )
    await page.waitForSelector('[aria-label="Image fill"]')
    await chooseReplacement()
    await expect.poll(() => saved.html).toContain(replacementUrl)
    expect(
      await frame.$eval('#photo', (el) => {
        const cs = getComputedStyle(el)
        return {
          image: cs.backgroundImage,
          size: cs.backgroundSize,
          position: cs.backgroundPosition,
          color: cs.backgroundColor,
        }
      }),
    ).toEqual({ image: `url("${replacementUrl}")`, size: 'cover', position: '50% 50%', color: 'rgb(18, 52, 86)' })
    for (const [mode, size, repeat] of [
      ['contain', 'contain', 'no-repeat'],
      ['tile', 'auto', 'repeat'],
      ['fill', '100% 100%', 'no-repeat'],
      ['contain', 'contain', 'no-repeat'],
    ]) {
      await page.select('[aria-label="Image sizing"]', mode!)
      await frame.waitForFunction(
        (size, repeat) => {
          const cs = getComputedStyle(document.querySelector('#photo')!)
          return cs.backgroundSize === size && cs.backgroundRepeat === repeat
        },
        {},
        size,
        repeat,
      )
    }
    await expect.poll(() => saved.html).toContain('background-size: contain')
  })

  it.each(['', '#photo { width: 50%; height: auto; }'])('preserves image sizing without Typed OM (%s)', async (css) => {
    const frame = await seedPanel(
      `<body><style>${css}</style><div id="parent" style="width:240px"><img id="photo" src="${originalUrl}"></div></body>`,
      '#photo',
    )
    await frame.evaluate(() => {
      Object.defineProperty(document.querySelector('#photo'), 'computedStyleMap', {
        value: undefined,
        configurable: true,
      })
    })
    try {
      await chooseReplacement()
      await expect.poll(() => saved.html).toContain(replacementUrl)
      await frame.waitForFunction(
        (url) => document.querySelector<HTMLImageElement>('#photo')?.currentSrc === url,
        {},
        replacementUrl,
      )
      expect(await frame.$eval('#photo', (el) => [getComputedStyle(el).width, getComputedStyle(el).height])).toEqual([
        '120px',
        '80px',
      ])
      if (css) {
        await frame.$eval('#parent', (el) => {
          ;(el as HTMLElement).style.width = '480px'
        })
        expect(await frame.$eval('#photo', (el) => [getComputedStyle(el).width, getComputedStyle(el).height])).toEqual([
          '240px',
          '160px',
        ])
      }
    } finally {
      await frame.evaluate(() => {
        delete (document.querySelector('#photo') as unknown as { computedStyleMap?: unknown }).computedStyleMap
      })
    }
  })

  it.each(['row', 'column'])(
    'keeps flex %s distribution and intrinsic sizing across repeated replacements',
    async (direction) => {
      const frame = await seedPanel(
        `<body><div id="parent" style="display:flex;flex-direction:${direction};width:${direction === 'row' ? 600 : 300}px;${direction === 'column' ? 'height:600px' : ''}"><img id="photo" src="${originalUrl}" style="flex:1 1 auto"><img id="sibling" src="${originalUrl}" style="flex:1 1 auto"></div></body>`,
        '#photo',
        '300',
      )
      const dimensions = () =>
        frame.$$eval('#photo, #sibling', (els) =>
          els.map((el) => [getComputedStyle(el).width, getComputedStyle(el).height]),
        )
      const before = await dimensions()
      const resize = (value: string) =>
        frame.$eval(
          '#parent',
          (el, axis, value) => {
            ;(el as HTMLElement).style.setProperty(axis, value)
          },
          direction === 'row' ? 'width' : 'height',
          value,
        )
      await resize('480px')
      const resized = await dimensions()
      await resize('600px')
      await chooseReplacement()
      await expect.poll(() => saved.html).toContain(replacementUrl)
      await frame.waitForFunction(
        (url) => document.querySelector<HTMLImageElement>('#photo')?.currentSrc === url,
        {},
        replacementUrl,
      )
      expect(await dimensions()).toEqual(before)
      await resize('480px')
      expect(await dimensions()).toEqual(resized)
      await resize('600px')
      expect(
        await frame.$eval('#photo', (el) => [
          getComputedStyle(el).flexGrow,
          getComputedStyle(el).flexShrink,
          getComputedStyle(el).flexBasis,
        ]),
      ).toEqual(['1', '1', 'auto'])
      // A second replacement must keep the first file's layout inputs.
      await page.waitForFunction(
        (url) => document.querySelector<HTMLImageElement>('[aria-label="Image fill"] img')?.src === url,
        {},
        replacementUrl,
      )
      await number('Image URL', originalUrl)
      await expect.poll(() => saved.html).not.toContain(replacementUrl)
      await frame.waitForFunction(
        (url) => document.querySelector<HTMLImageElement>('#photo')?.currentSrc === url,
        {},
        originalUrl,
      )
      expect(await dimensions()).toEqual(before)
      await page.evaluate(() => window.elementPanelHarness.undo())
      await frame.waitForFunction(
        (url) => document.querySelector<HTMLImageElement>('#photo')?.currentSrc === url,
        {},
        replacementUrl,
      )
      expect(await dimensions()).toEqual(before)
    },
    15_000,
  )

  it('keeps background color and opacity editable alongside an image fill', async () => {
    const frame = await seedPanel(
      `<body><img id="photo" src="${originalUrl}" style="width:120px;height:80px;object-fit:contain;background-color:rgba(255,0,0,.5)"></body>`,
      '#photo',
    )
    await page.waitForSelector('[aria-label="Image fill"]')
    await number('Fill color', '#123456')
    await number('Fill opacity', 75)
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('#photo')!).backgroundColor === 'rgba(18, 52, 86, 0.75)',
    )
    expect(await frame.$eval('#photo', (el) => (el as HTMLImageElement).src)).toBe(originalUrl)
    expect(await frame.$eval('#photo', (el) => getComputedStyle(el).objectFit)).toBe('contain')
    await expect.poll(() => saved.html).toContain('rgba(18, 52, 86, 0.75)')
  })

  it('keeps the old image after upload failure and allows retrying the same file', async () => {
    await seedPanel(`<body><img id="photo" src="${originalUrl}" style="width:120px;height:80px"></body>`, '#photo')
    await page.waitForSelector('[aria-label="Image fill"]')
    const before = saved.html
    uploadStatus = 500
    try {
      await chooseReplacement()
      await page.waitForSelector('[role="alert"]')
      expect(saved.html).toBe(before)
    } finally {
      uploadStatus = 200
    }
    await chooseReplacement()
    await expect.poll(() => saved.html).toContain(replacementUrl)
  })

  it('does not overwrite a layer changed while its image is uploading', async () => {
    await seedPanel(`<body><img id="photo" src="${originalUrl}" style="width:120px;height:80px"></body>`, '#photo')
    await page.waitForSelector('[aria-label="Image fill"]')
    let release!: () => void
    uploadGate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await chooseReplacement()
      await page.waitForSelector('[aria-label="Upload image"][disabled]')
      saved = { ...saved, html: saved.html.replace('height:80px', 'height:90px') }
      await page.evaluate((value) => window.elementPanelHarness.remote(value), saved)
      release()
      await page.waitForSelector('[role="alert"]')
      expect(saved.html).not.toContain(replacementUrl)
      expect(saved.html).toContain('height:90px')
    } finally {
      release()
      uploadGate = null
    }
  })

  async function number(label: string, value: number | string) {
    const selector = `input[aria-label="${label}"]`
    await page.click(selector, { count: 3 })
    await page.keyboard.press('Backspace')
    await page.type(selector, String(value))
    await page.keyboard.press('Enter')
  }

  it('edits flex direction, alignment, spacing and padding without overwriting the other axes; saves and undoes', async () => {
    const frame = await seedPanel(
      `<!doctype html><html><head><style>
        #flex { display: inline-flex; width: 120px; height: 160px; gap: 7px 11px; padding: 8px 12px 16px 20px; align-items: center; justify-content: center }
        #flex > div { flex: none; width: 20px; height: 20px }
      </style></head><body><div id="flex"><div>A</div><div>B</div></div></body></html>`,
      '#flex',
    )
    await page.waitForSelector('[aria-label="Align children middle center"][aria-pressed="true"]')
    expect(await page.$eval('[aria-label="Horizontal padding"]', (el) => (el as HTMLInputElement).placeholder)).toBe(
      'Mixed',
    )
    expect(await page.$eval('[aria-label="Horizontal padding"]', (el) => (el as HTMLInputElement).value)).toBe('')
    await page.click('[aria-label="Space between"]')
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('#flex')!).justifyContent === 'space-between',
    )
    await page.click('[aria-label="Align children bottom right"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#flex')!).alignItems === 'flex-end')
    expect(await frame.$eval('#flex', (el) => getComputedStyle(el).justifyContent)).toBe('space-between')
    await number('Gap', 14)
    expect(await frame.$eval('#flex', (el) => getComputedStyle(el).rowGap)).toBe('7px')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#flex')!).columnGap === '14px')
    await page.click('[aria-label="Column direction"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#flex')!).flexDirection === 'column')
    expect(await frame.$eval('#flex', (el) => getComputedStyle(el).display)).toBe('inline-flex')
    await page.click('[aria-label="Reverse direction"]')
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('#flex')!).flexDirection === 'column-reverse',
    )
    await page.click('[aria-label="Wrap children"]')
    await page.waitForSelector('[aria-label="Line gap"]')
    await number('Line gap', 18)
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#flex')!).columnGap === '18px')
    expect(await frame.$eval('#flex', (el) => getComputedStyle(el).rowGap)).toBe('7px')
    await number('Horizontal padding', 24)
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#flex')!).padding === '8px 24px 16px')
    await expect.poll(() => saved.html).toContain('padding-right: 24px')
    // Reopen the saved result, starting a fresh undo history outside the edit burst.
    await seedPanel(saved.html, '#flex')
    await page.click('[aria-label="Individual padding"]')
    await number('Padding top', 30)
    await expect.poll(() => saved.html).toContain('padding-top: 30px')
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#flex')!).padding === '8px 24px 16px')
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('[aria-label="Padding top"]')?.value === '8',
    )
  }, 20_000)

  it.each([
    ['row', 'ltr', 'horizontal-tb', 'nowrap'],
    ['column', 'ltr', 'horizontal-tb', 'nowrap'],
    ['row-reverse', 'ltr', 'horizontal-tb', 'nowrap'],
    ['column-reverse', 'ltr', 'horizontal-tb', 'nowrap'],
    ['row', 'rtl', 'horizontal-tb', 'nowrap'],
    ['row', 'ltr', 'vertical-rl', 'nowrap'],
    ['column', 'ltr', 'vertical-lr', 'nowrap'],
    ['row', 'ltr', 'sideways-lr', 'nowrap'],
    ['row', 'ltr', 'horizontal-tb', 'wrap-reverse'],
  ])('aligns children to the physical bottom right in %s / %s / %s / %s', async (direction, bidi, writing, wrap) => {
    const frame = await seedPanel(
      `<!doctype html><html><head><style>
        #flex { display: flex; width: 120px; height: 120px; flex-direction: ${direction}; direction: ${bidi}; writing-mode: ${writing}; flex-wrap: ${wrap} }
        #flex > div { flex: none; width: 20px; height: 20px }
      </style></head><body><div id="flex"><div></div><div></div></div></body></html>`,
      '#flex',
    )
    await page.click('[aria-label="Align children bottom right"]')
    await frame.waitForFunction(() => {
      const parent = document.querySelector('#flex')!
      const bounds = parent.getBoundingClientRect()
      const children = [...parent.children].map((el) => el.getBoundingClientRect())
      return (
        Math.abs(Math.max(...children.map((r) => r.right)) - bounds.right) < 0.1 &&
        Math.abs(Math.max(...children.map((r) => r.bottom)) - bounds.bottom) < 0.1 &&
        Math.min(...children.map((r) => r.left)) > bounds.left + 60 &&
        Math.min(...children.map((r) => r.top)) > bounds.top + 60
      )
    })
    await page.waitForSelector('[aria-label="Align children bottom right"][aria-pressed="true"]')
  })

  it('positions and aligns transformed layers without disturbing siblings; saves and undoes geometry', async () => {
    const frame = await seedPanel(
      `<!doctype html><html><head><style>
      body { margin: 0 }
      #parent { display: flex; width: 400px; height: 240px; margin: 60px; transform: scale(.8); transform-origin: top left }
      #box { width: 120px; height: 80px; flex: none; background: #ddd; transform: rotate(20deg); scale: 1.2 .8; translate: 10% 5px }
      #sibling { width: 60px; height: 40px; flex: none }
    </style></head><body><div id="parent"><div id="box">Move me</div><div id="sibling" data-doop-locked>Sibling</div></div><span id="inline">Inline text</span><canvas id="canvas" width="20" height="20"></canvas></body></html>`,
      '#box',
    )
    const sibling = await frame.$eval('#sibling', (el) => el.getBoundingClientRect().toJSON())
    const originalTransform = await frame.$eval('#box', (el) => getComputedStyle(el).transform)
    const before = await frame.$eval('#box', (el) => (el as HTMLElement).style.translate)
    await number('X position', 40)
    await frame.waitForFunction(
      () =>
        Math.abs(
          document.querySelector('#box')!.getBoundingClientRect().x -
            document.querySelector('#parent')!.getBoundingClientRect().x -
            40,
        ) < 0.1,
    )
    await number('Y position', 30)
    await frame.waitForFunction(
      () =>
        Math.abs(
          document.querySelector('#box')!.getBoundingClientRect().y -
            document.querySelector('#parent')!.getBoundingClientRect().y -
            30,
        ) < 0.1,
    )

    for (const [label, axis, fraction] of [
      ['Align layer left', 'x', 0],
      ['Center layer horizontally', 'x', 0.5],
      ['Align layer right', 'x', 1],
      ['Align layer top', 'y', 0],
      ['Center layer vertically', 'y', 0.5],
      ['Align layer bottom', 'y', 1],
    ] as const) {
      await page.click(`[aria-label="${label}"]`)
      await frame.waitForFunction(
        (axis, fraction) => {
          const box = document.querySelector('#box')!.getBoundingClientRect()
          const parent = document.querySelector('#parent')!.getBoundingClientRect()
          const size = axis === 'x' ? 'width' : 'height'
          return Math.abs(box[axis] - parent[axis] - (parent[size] - box[size]) * fraction) < 0.1
        },
        {},
        axis,
        fraction,
      )
    }
    expect(await frame.$eval('#sibling', (el) => el.getBoundingClientRect().toJSON())).toEqual(sibling)
    expect(await frame.$eval('#box', (el) => getComputedStyle(el).position)).toBe('static')
    await number('Rotation', 45)
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#box')!).rotate === '25deg')
    await page.click('[aria-label="Flip horizontally"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#box')!).scale === '-1.2 0.8')
    await page.click('[aria-label="Flip horizontally"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#box')!).scale === '1.2 0.8')
    await page.click('[aria-label="Flip vertically"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#box')!).scale === '1.2 -0.8')
    expect(await frame.$eval('#box', (el) => getComputedStyle(el).transform)).toBe(originalTransform)
    await expect.poll(() => saved.html).toContain('scale: 1.2 -0.8')
    const previousSave = saved.html
    await number('X position', 80)
    await expect.poll(() => saved.html).not.toBe(previousSave)
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(
      (before) => document.querySelector<HTMLElement>('#box')?.style.translate === before,
      {},
      before,
    )
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('[aria-label="Rotation"]')?.value === '20',
    )
    await page.screenshot({ path: '/tmp/narwhal-panel-controls.png' })
    await selectLayer('#sibling')
    await page.waitForSelector('[aria-label="X position"][disabled]')
    expect(await frame.$eval('#sibling', (el) => el.getAttribute('style'))).toBeNull()
    await selectLayer('#inline')
    await page.waitForFunction(
      () => document.querySelector<HTMLSelectElement>('[aria-label="Display"]')?.value === 'inline',
    )
    expect(await page.$eval('[aria-label="Rotation"]', (el) => (el as HTMLInputElement).disabled)).toBe(true)
    await selectLayer('#canvas')
    await page.waitForSelector('[aria-label="Rotation"]:not([disabled])')
  }, 30_000)

  it('preserves fill RGB/alpha independently of element opacity, clips content, and reads nonstandard weights', async () => {
    const frame = await seedPanel(
      `<!doctype html><html><head><style>
      #paint { width: 120px; height: 80px; overflow: hidden; opacity: .5; background: rgba(10,20,30,.35); font-weight: 450 }
      #modern { width: 120px; height: 80px; background: oklch(60% .15 30 / .4) }
    </style></head><body><div id="paint">Appearance controls</div><div id="modern">Modern color</div></body></html>`,
      '#paint',
    )
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('[aria-label="Fill opacity"]')?.value === '35',
    )
    expect(await page.$eval('[aria-label="Font weight"]', (el) => (el as HTMLSelectElement).value)).toBe('450')
    await number('Fill opacity', 80)
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('#paint')!).backgroundColor === 'rgba(10, 20, 30, 0.8)',
    )
    await number('Fill color', '#e5533c')
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('#paint')!).backgroundColor === 'rgba(229, 83, 60, 0.8)',
    )
    await number('Fill opacity', 0)
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('#paint')!).backgroundColor === 'rgba(229, 83, 60, 0)',
    )
    await number('Fill opacity', 60)
    await frame.waitForFunction(
      () => getComputedStyle(document.querySelector('#paint')!).backgroundColor === 'rgba(229, 83, 60, 0.6)',
    )
    expect(await frame.$eval('#paint', (el) => getComputedStyle(el).opacity)).toBe('0.5')
    await page.click('[aria-label="Clip content"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#paint')!).overflow === 'visible')
    await number('Corner radius', 12)
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#paint')!).borderRadius === '12px')
    await expect.poll(() => saved.html).toContain('overflow: visible')
    await page.click('[aria-label="Hide element"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#paint')!).visibility === 'hidden')
    await page.click('[aria-label="Show element"]')
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#paint')!).visibility === 'visible')
    await selectLayer('#modern')
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('[aria-label="Fill opacity"]')?.value === '40',
    )
    await number('Fill opacity', 25)
    await frame.waitForFunction(() =>
      getComputedStyle(document.querySelector('#modern')!).backgroundColor.endsWith('/ 0.25)'),
    )
    expect(await frame.$eval('#modern', (el) => (el as HTMLElement).style.backgroundColor)).toContain('oklch')
  }, 20_000)

  it('reads stylesheet sizes and switches between flex fill, fixed, and content sizing', async () => {
    const frame = await seedPanel(
      `<!doctype html><html><head><style>
      #row { display: flex; width: 400px; height: 240px; gap: 16px }
      #sized { width: 120px; height: 80px; padding: 10px; border: 2px solid; }
      #other { width: 60px; flex: none }
    </style></head><body><div id="row"><div id="sized">Size</div><div id="other">Other</div></div></body></html>`,
      '#sized',
    )
    expect(await page.$eval('[aria-label="Width sizing"]', (el) => (el as HTMLSelectElement).value)).toBe('fixed')
    await page.select('[aria-label="Width sizing"]', 'fill')
    await frame.waitForFunction(() => document.querySelector('#sized')!.getBoundingClientRect().width === 324)
    await page.select('[aria-label="Height sizing"]', 'fill')
    await frame.waitForFunction(() => document.querySelector('#sized')!.getBoundingClientRect().height === 240)
    await page.waitForFunction(
      () => document.querySelector<HTMLSelectElement>('[aria-label="Height sizing"]')?.value === 'fill',
    )
    await number('Width', 140)
    await frame.waitForFunction(() => getComputedStyle(document.querySelector('#sized')!).width === '140px')
    expect(await frame.$eval('#sized', (el) => getComputedStyle(el).flexGrow)).toBe('0')
    await page.select('[aria-label="Width sizing"]', 'hug')
    await frame.waitForFunction(() => document.querySelector<HTMLElement>('#sized')!.style.width === 'fit-content')
    expect(await frame.$eval('#sized', (el) => el.getBoundingClientRect().width)).toBeLessThan(120)
    await page.select('[aria-label="Width sizing"]', 'auto')
    await frame.waitForFunction(() => document.querySelector<HTMLElement>('#sized')!.style.width === 'auto')
    await expect.poll(() => saved.html).toContain('width: auto')
  }, 20_000)
  it.each(['stylesheet', 'inline'])(
    'settles position and alignment before restoring %s transitions',
    async (source) => {
      const inline =
        source === 'inline'
          ? 'style="transition-property: all !important; transition-duration: 1s; transition-delay: .1s"'
          : ''
      const frame = await seedPanel(
        `<!doctype html><html><head><style>
      body { margin: 0 }
      #transition-parent { width: 400px; height: 240px }
      #transition-layer { width: 120px; height: 80px; translate: 10% 5px; ${source === 'stylesheet' ? 'transition: all 1s' : ''} }
    </style></head><body><div id="transition-parent"><div id="transition-layer" ${inline}>Animated layer</div></div></body></html>`,
        '#transition-layer',
      )
      // Morphing this fixture over the previous document can itself start a transition.
      await frame.$eval('#transition-layer', (el) => el.getAnimations().forEach((animation) => animation.finish()))
      const before = await frame.$eval('#transition-layer', (el) => {
        const css = getComputedStyle(el)
        return [
          css.transitionProperty,
          css.transitionDuration,
          css.transitionDelay,
          (el as HTMLElement).style.getPropertyPriority('transition-property'),
        ]
      })
      const position = await page.evaluate(() =>
        window.elementPanelHarness.geometry('#transition-layer', { kind: 'position', axis: 'x', value: 40 }),
      )
      expect(position?.geometry.x).toBe(40)
      expect(position?.geometry.y).toBe(5)
      const aligned = await page.evaluate(() =>
        window.elementPanelHarness.geometry('#transition-layer', { kind: 'align', axis: 'y', edge: 'end' }),
      )
      expect(aligned?.geometry.x).toBe(40)
      expect(aligned?.geometry.y).toBe(160)
      expect(
        await frame.$eval(
          '#transition-layer',
          (el) => el.getAnimations().filter((animation) => animation instanceof CSSTransition).length,
        ),
      ).toBe(0)
      expect(
        await frame.$eval('#transition-layer', (el) => {
          const css = getComputedStyle(el)
          return [
            css.transitionProperty,
            css.transitionDuration,
            css.transitionDelay,
            (el as HTMLElement).style.getPropertyPriority('transition-property'),
          ]
        }),
      ).toEqual(before)
      await expect.poll(() => saved.html).toContain('translate: 40px 160px')
      expect(saved.html).not.toContain('transition: none')
    },
    15_000,
  )

  it.each(['row', 'column'])(
    'fills the physical dimensions of a vertical-writing flex %s',
    async (direction) => {
      const frame = await seedPanel(
        `<!doctype html><html><head><style>
      #vertical { writing-mode: vertical-rl; display: flex; flex-direction: ${direction}; width: 400px; height: 240px; gap: 16px }
      #vertical-child { width: 120px; height: 80px }
      #vertical-sibling { width: 60px; height: 40px; flex: none }
    </style></head><body><div id="vertical"><div id="vertical-child">Size</div><div id="vertical-sibling">Other</div></div></body></html>`,
        '#vertical-child',
      )
      const main = direction === 'row' ? 'Height' : 'Width'
      const cross = direction === 'row' ? 'Width' : 'Height'
      await page.select(`[aria-label="${cross} sizing"]`, 'fill')
      await frame.waitForFunction(
        (direction) => {
          const r = document.querySelector('#vertical-child')!.getBoundingClientRect()
          return direction === 'row' ? r.width === 400 && r.height === 80 : r.width === 120 && r.height === 240
        },
        {},
        direction,
      )
      expect(await frame.$eval('#vertical-child', (el) => getComputedStyle(el).flexGrow)).toBe('0')
      await page.select(`[aria-label="${main} sizing"]`, 'fill')
      await frame.waitForFunction(
        (direction) => {
          const r = document.querySelector('#vertical-child')!.getBoundingClientRect()
          return direction === 'row' ? r.width === 400 && r.height === 184 : r.width === 324 && r.height === 240
        },
        {},
        direction,
      )
      await number(main, 100)
      await frame.waitForFunction(
        (direction) =>
          getComputedStyle(document.querySelector('#vertical-child')!)[direction === 'row' ? 'height' : 'width'] ===
          '100px',
        {},
        direction,
      )
      expect(await frame.$eval('#vertical-child', (el) => getComputedStyle(el).flexGrow)).toBe('0')
      await expect.poll(() => saved.html).toContain(`${main.toLowerCase()}: 100px`)
    },
    15_000,
  )

  it('fills to the parent edge with fractional borders and padding', async () => {
    const frame = await seedPanel(
      `<!doctype html><html><head><style>
      #fractional { zoom: 2; width: 200px; height: 160px }
      #fractional-child { width: 120px; height: 80px; border: 1.5px solid; padding: 3.25px }
    </style></head><body><div id="fractional"><div id="fractional-child">Size</div></div></body></html>`,
      '#fractional-child',
    )
    expect(await frame.$eval('#fractional-child', (el) => getComputedStyle(el).borderLeftWidth)).toBe('1.5px')
    for (const axis of ['Width', 'Height']) {
      await page.select(`[aria-label="${axis} sizing"]`, 'fill')
      await frame.waitForFunction(
        (axis) => {
          const parent = document.querySelector('#fractional')!.getBoundingClientRect()
          const child = document.querySelector('#fractional-child')!.getBoundingClientRect()
          return Math.abs(axis === 'Width' ? parent.right - child.right : parent.bottom - child.bottom) < 0.01
        },
        {},
        axis,
      )
    }
    await expect.poll(() => saved.html).toContain('calc(100% - 9.5px)')
  }, 15_000)

  async function seedScrubTarget(
    styles = 'width:120px;height:80px;min-width:1.5rem;padding:4px 8px 12px 16px;gap:6px;column-gap:10px;opacity:0.8;border-left:2px solid black;border-radius:3px;font-size:18px',
    { css = '', target = `<div id="scrub" style="display:flex;${styles}">Scrub me</div>` } = {},
  ) {
    const seed = String(++seedId)
    saved = {
      ...saved,
      html: `<!doctype html><html><head><style>${css}</style></head><body data-seed="${seed}">
        ${target}
        <div id="other" style="width:200px">Another element</div>
      </body></html>`,
    }
    await page.evaluate((frame) => window.elementPanelHarness.seed(frame), saved)
    const frame = (await (await page.$('iframe'))!.contentFrame())!
    await frame.waitForFunction((seed) => document.body.dataset.seed === seed, {}, seed)
    await frame.waitForFunction(() => Array.from(document.images).every((image) => image.complete))
    await page.evaluate(() => window.elementPanelHarness.select('#scrub'))
    const width = await frame.$eval('#scrub', (el) => String(parseFloat(getComputedStyle(el).width)))
    await page.waitForFunction(
      (width) => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === width,
      {},
      width,
    )
    await page.click('[aria-label="Individual padding"]')
    return frame
  }

  async function startScrub(label: string) {
    const unit = (await page.$(`label:has(input[aria-label="${label}"]) > span:last-child`))!
    await unit.scrollIntoView()
    expect(await unit.evaluate((el) => getComputedStyle(el).cursor)).toBe('ew-resize')
    const box = (await unit.boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    return { x, y }
  }

  async function drag(label: string, dx: number, modifier?: 'Shift' | 'Alt') {
    const { x, y } = await startScrub(label)
    if (modifier) await page.keyboard.down(modifier)
    await page.mouse.move(x + dx, y, { steps: 5 })
    await page.mouse.up()
    if (modifier) await page.keyboard.up(modifier)
  }

  it('scrubs negative geometry without probe animations and restores translations on cancel and undo', async () => {
    const frame = await seedPanel(
      `<!doctype html><html><head><style>
        body { margin: 0 } #box { width: 120px; height: 80px }
      </style></head><body><div id="box" style="translate: 10px 5px">Move</div></body></html>`,
      '#box',
    )
    await frame.$eval('#box', (el) => {
      ;(el as HTMLElement).style.transition = 'all 1s'
    })
    const original = saved.html
    const point = await startScrub('X position')
    await page.mouse.move(point.x - 30, point.y)
    await frame.waitForFunction(() => (document.querySelector('#box') as HTMLElement).style.translate === '-20px 5px')
    expect(await frame.$eval('#box', (el) => el.getBoundingClientRect().x)).toBe(-20)
    expect(await frame.$eval('#box', (el) => el.getAnimations().length)).toBe(0)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await frame.waitForFunction(() => (document.querySelector('#box') as HTMLElement).style.translate === '10px 5px')
    expect(saved.html).toBe(original)
    await frame.$eval('#box', (el) => el.getAnimations().forEach((animation) => animation.finish()))
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>('[aria-label="X position"]')?.value === '10',
    )
    await drag('X position', -30)
    await expect.poll(() => saved.html).toContain('translate: -20px 5px')
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(() => (document.querySelector('#box') as HTMLElement).style.translate === '10px 5px')
  }, 15_000)

  it('scrubs live in both directions, saves, and undoes/redoes the edit', async () => {
    const frame = await seedScrubTarget()
    const original = saved.html
    const { x, y } = await startScrub('Width')
    await page.mouse.move(x + 2, y)
    await page.mouse.up()
    expect(saved.html).toBe(original)
    expect(await page.$eval('[aria-label="Width"]', (el) => (el as HTMLInputElement).value)).toBe('120')

    await startScrub('Width')
    // Capture keeps the drag alive even when the pointer crosses the iframe.
    await page.mouse.move(200, y)
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '0px')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '120px')
    await startScrub('Width')
    await page.mouse.move(x + 24, y, { steps: 6 })
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '144px')
    // The live canvas changes before release; reversing is relative to the same drag.
    await page.mouse.move(x + 14, y, { steps: 3 })
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '134px')
    await page.screenshot({ path: '/tmp/doop-element-scrubbing.png' })
    await page.mouse.up()
    await expect.poll(() => saved.html).toContain('width: 134px')
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '120px')
    await page.evaluate(() => window.elementPanelHarness.redo())
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '134px')
  }, 15_000)

  it('covers numeric units, padding shorthand, CSS lengths, modifiers, and bounds', async () => {
    const frame = await seedScrubTarget()
    for (const [label, dx, property, expected, modifier] of [
      ['Height', 4, 'height', '120px', 'Shift'],
      ['Gap', 8, 'column-gap', '18px'],
      ['Padding top', 5, 'padding-top', '9px'],
      ['Element opacity', 40, 'opacity', '1'],
      ['Element opacity', -150, 'opacity', '0'],
      ['Border width', 4, 'border-width', '6px'],
      ['Corner radius', -10, 'border-radius', '0px'],
      ['Font size', 4, 'font-size', '18.4px', 'Alt'],
      ['Minimum width', 5, 'min-width', '2rem', 'Alt'],
    ] as const) {
      await drag(label, dx, modifier)
      await frame.waitForFunction(
        (property, expected) =>
          (document.querySelector('#scrub') as HTMLElement).style.getPropertyValue(property) === expected,
        {},
        property,
        expected,
      )
    }
    // Reversing after hitting a bound responds immediately, without a dead zone.
    const { x, y } = await startScrub('Element opacity')
    await page.mouse.move(x - 20, y)
    await page.mouse.move(x - 15, y)
    await page.mouse.up()
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.opacity === '0.05')
    await expect.poll(() => saved.html).toContain('opacity: 0.05')
    expect(saved.html).toContain('min-width: 2rem')
  }, 15_000)

  it('cancels with Escape and cleans up capture when interrupted or selection changes', async () => {
    const frame = await seedScrubTarget()
    let point = await startScrub('Width')
    await page.mouse.move(point.x + 20, point.y)
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '140px')
    await page.keyboard.press('Escape')
    await page.mouse.move(point.x + 40, point.y)
    await page.mouse.up()
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '120px')

    point = await startScrub('Height')
    await page.mouse.move(point.x + 10, point.y)
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.height === '90px')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.mouse.move(point.x + 30, point.y)
    await page.mouse.up()
    expect(await frame.$eval('#scrub', (el) => (el as HTMLElement).style.height)).toBe('90px')

    point = await startScrub('Width')
    await page.evaluate(() => window.elementPanelHarness.select('#other'))
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === '200')
    await page.mouse.move(point.x + 30, point.y)
    await page.mouse.up()
    expect(await frame.$eval('#other', (el) => (el as HTMLElement).style.width)).toBe('200px')
    expect(await page.$eval('body', (el) => getComputedStyle(el).cursor)).not.toBe('ew-resize')
  }, 15_000)

  it('preserves typing and keyboard adjustment and leaves nonnumeric lengths alone', async () => {
    const frame = await seedScrubTarget()
    await page.click('[aria-label="Width"]', { count: 3 })
    await page.keyboard.type('123')
    await page.keyboard.press('Enter')
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '123px')
    await page.click('[aria-label="Width"]')
    await page.keyboard.press('ArrowUp')
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '124px')
    await page.click('[aria-label="Minimum width"]', { count: 3 })
    await page.keyboard.type('auto')
    await page.keyboard.press('Enter')
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.minWidth === 'auto')
    const unit = (await page.$('label:has(input[aria-label="Minimum width"]) > span'))!
    expect(await unit.evaluate((el) => getComputedStyle(el).cursor)).not.toBe('ew-resize')
    await expect.poll(() => saved.html).toContain('min-width: auto')
  }, 15_000)

  it('reconciles the displayed value with computed CSS after a drag finishes', async () => {
    const frame = await seedScrubTarget()
    const { x, y } = await startScrub('Width')
    await page.mouse.move(x - 150, y)
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '0px')
    // CSS min-width prevents the rendered width from reaching zero. The live
    // draft stays under pointer control until release, then reflects that limit.
    expect(await page.$eval('[aria-label="Width"]', (el) => (el as HTMLInputElement).value)).toBe('0')
    const computed = await frame.$eval('#scrub', (el) => String(parseFloat(getComputedStyle(el).width)))
    await page.mouse.up()
    await expect.poll(() => page.$eval('[aria-label="Width"]', (el) => (el as HTMLInputElement).value)).toBe(computed)

    const padding = await startScrub('Padding top')
    await page.mouse.move(padding.x - 30, padding.y)
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.paddingTop === '0px')
    await page.mouse.up()
    await expect.poll(() => page.$eval('[aria-label="Padding top"]', (el) => (el as HTMLInputElement).value)).toBe('0')
    await expect.poll(() => saved.html).toContain('padding: 0px 8px 12px 16px')
  }, 15_000)

  it('restores original CSS units, absent properties, priorities, and shorthands on Escape without saving', async () => {
    const frame = await seedScrubTarget(
      'width:50% !important;padding:1em 2em !important;row-gap:6px;column-gap:10px;border-left:2px solid black',
    )
    const originalHtml = saved.html
    const inline = () =>
      frame.$eval('#scrub', (el) => {
        const style = (el as HTMLElement).style
        return Object.fromEntries(
          Array.from(style).map((key) => [key, [style.getPropertyValue(key), style.getPropertyPriority(key)]]),
        )
      })
    const original = await inline()
    for (const label of ['Width', 'Height', 'Padding top', 'Gap', 'Border width']) {
      const point = await startScrub(label)
      await page.mouse.move(point.x + 10, point.y)
      await expect.poll(inline).not.toEqual(original)
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await expect.poll(inline).toEqual(original)
    }
    expect(saved.html).toBe(originalHtml)
    await page.evaluate(() => window.elementPanelHarness.undo())
    expect(saved.html).toBe(originalHtml)
    await expect.poll(inline).toEqual(original)
  }, 15_000)

  it('saves a paused drag as one undo step and drops a paused cancellation', async () => {
    const frame = await seedScrubTarget()
    const original = saved.html
    let point = await startScrub('Width')
    await page.mouse.move(point.x + 20, point.y)
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '140px')
    // Longer than both the runtime's save debounce and history's merge window.
    await new Promise((resolve) => setTimeout(resolve, 2100))
    expect(saved.html).toBe(original)
    await page.mouse.move(point.x + 40, point.y)
    await page.mouse.up()
    await expect.poll(() => saved.html).toContain('width: 160px')
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '120px')
    await page.evaluate(() => window.elementPanelHarness.redo())
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '160px')
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === '160')

    // A second completed drag remains a separate undo step, even immediately afterward.
    await drag('Width', 10)
    await expect.poll(() => saved.html).toContain('width: 170px')
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '160px')
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === '160')
    const beforeCancel = saved.html
    point = await startScrub('Width')
    await page.mouse.move(point.x + 30, point.y)
    await new Promise((resolve) => setTimeout(resolve, 2100))
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '160px')
    expect(saved.html).toBe(beforeCancel)
    // Cancellation leaves the previous real edit on top of the undo stack.
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '120px')
  }, 20_000)

  it('keeps remote edits when a preview is cancelled', async () => {
    const frame = await seedScrubTarget('width:50%;height:80px')
    const point = await startScrub('Width')
    await page.mouse.move(point.x + 20, point.y)
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width.endsWith('px'))
    const preview = await frame.$eval('#scrub', (el) => (el as HTMLElement).style.width)
    saved = { ...saved, html: saved.html.replace('width:50%', 'width:60%;color:red') }
    const remote = saved.html
    await page.evaluate((frame) => window.elementPanelHarness.remote(frame), saved)
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.color === 'red')
    expect(await frame.$eval('#scrub', (el) => (el as HTMLElement).style.width)).toBe(preview)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '60%')
    expect(await frame.$eval('#scrub', (el) => (el as HTMLElement).style.color)).toBe('red')
    expect(saved.html).toBe(remote)
  }, 15_000)

  it('links dimensions for typing and dragging, persists the ratio, and restores both dimensions on cancel/undo', async () => {
    const frame = await seedScrubTarget()
    const toggle = '[aria-label="Link width and height"]'
    expect(await page.$eval(toggle, (el) => el.getAttribute('aria-pressed'))).toBe('false')
    await page.click(toggle)
    await page.waitForSelector(`${toggle}[aria-pressed="true"]`)
    await expect.poll(() => saved.html).toContain('aspect-ratio: 120 / 80')

    await page.click('[aria-label="Width"]', { count: 3 })
    await page.keyboard.type('240')
    await page.keyboard.press('Enter')
    await frame.waitForFunction(() => {
      const style = (document.querySelector('#scrub') as HTMLElement).style
      return style.width === '240px' && style.height === '160px'
    })
    await expect.poll(() => saved.html).toContain('height: 160px')
    await page.evaluate(() => window.elementPanelHarness.select('#other'))
    await page.waitForSelector(`${toggle}[aria-pressed="false"]`)
    await page.evaluate(() => window.elementPanelHarness.select('#scrub'))
    await page.waitForSelector(`${toggle}[aria-pressed="true"]`)

    await page.click('[aria-label="Height"]', { count: 3 })
    await page.keyboard.type('100')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === '150')
    const point = await startScrub('Width')
    await page.mouse.move(point.x + 30, point.y)
    await frame.waitForFunction(() => {
      const style = (document.querySelector('#scrub') as HTMLElement).style
      return style.width === '180px' && style.height === '120px'
    })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === '150')
    expect(await frame.$eval('#scrub', (el) => (el as HTMLElement).style.height)).toBe('100px')

    await drag('Width', 30)
    await expect.poll(() => saved.html).toContain('width: 180px')
    await page.screenshot({ path: '/tmp/doop-linked-dimensions.png' })
    await page.evaluate(() => window.elementPanelHarness.undo())
    await frame.waitForFunction(() => {
      const style = (document.querySelector('#scrub') as HTMLElement).style
      return style.width === '150px' && style.height === '100px'
    })
    await page.evaluate(() => window.elementPanelHarness.redo())
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.width === '180px')
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('[aria-label="Width"]')?.value === '180')
    await page.click(toggle)
    await page.waitForSelector(`${toggle}[aria-pressed="false"]`)
    await expect.poll(() => saved.html).toContain('aspect-ratio: auto')
    await page.click('[aria-label="Width"]', { count: 3 })
    await page.keyboard.type('200')
    await page.keyboard.press('Enter')
    await expect.poll(() => saved.html).toContain('width: 200px')
    expect(await frame.$eval('#scrub', (el) => (el as HTMLElement).style.height)).toBe('120px')
  }, 20_000)

  it('recognizes authored aspect ratios and maintains them in Fill mode', async () => {
    const frame = await seedScrubTarget('width:160px;height:90px;aspect-ratio:16 / 9', {
      css: '#scrub { height: 90px }',
    })
    await page.waitForSelector('[aria-label="Link width and height"][aria-pressed="true"]')
    await page.select('[aria-label="Width sizing"]', 'fill')
    await frame.waitForFunction(() => {
      const el = document.querySelector('#scrub') as HTMLElement
      const style = getComputedStyle(el)
      return (
        el.style.width === '100%' &&
        el.style.height === 'auto' &&
        Math.abs(parseFloat(style.width) / parseFloat(style.height) - 16 / 9) < 0.001
      )
    })
    await expect.poll(() => saved.html).toContain('width: 100%')
    expect(saved.html).toContain('aspect-ratio: 16 / 9')
    const height = await frame.$eval('#scrub', (el) => getComputedStyle(el).height)
    await page.waitForFunction(
      (height) =>
        document.querySelector<HTMLInputElement>('[aria-label="Height"]')?.value === String(parseFloat(height)),
      {},
      height,
    )
    await page.click('[aria-label="Link width and height"]')
    await expect.poll(() => saved.html).toContain('aspect-ratio: auto')
    expect(await frame.$eval('#scrub', (el) => getComputedStyle(el).height)).toBe(height)
    expect(await frame.$eval('#scrub', (el) => (el as HTMLElement).style.width)).toBe('100%')
  }, 15_000)

  it.each(['width', 'height'] as const)(
    'keeps an existing %s Fill proportional when linking',
    async (axis) => {
      const other = axis === 'width' ? 'height' : 'width'
      const frame = await seedScrubTarget(`${axis}:100%;${other}:80px`, {
        css: 'body { width: 240px; height: 240px } #scrub { width: 80px; height: 80px }',
      })
      await page.click('[aria-label="Link width and height"]')
      await page.waitForSelector('[aria-label="Link width and height"][aria-pressed="true"]')
      await frame.waitForFunction(
        (other) => (document.querySelector('#scrub') as HTMLElement).style.getPropertyValue(other) === 'auto',
        {},
        other,
      )
      await expect.poll(() => saved.html).toContain(`${other}: auto`)
      await frame.evaluate((axis) => {
        document.body.style[axis] = '300px'
      }, axis)
      await frame.waitForFunction(
        (other) => getComputedStyle(document.querySelector('#scrub')!).getPropertyValue(other) === '100px',
        {},
        other,
      )
    },
    15_000,
  )

  it('preserves stylesheet-derived image dimensions when unlinking', async () => {
    const src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>')}`
    const frame = await seedScrubTarget('', {
      css: '#scrub { height:100px; width:auto; aspect-ratio:2 / 1 }',
      target: `<img id="scrub" src="${src}">`,
    })
    await page.waitForSelector('[aria-label="Link width and height"][aria-pressed="true"]')
    expect(await frame.$eval('#scrub', (el) => getComputedStyle(el).width)).toBe('200px')
    await page.click('[aria-label="Link width and height"]')
    await expect.poll(() => saved.html).toContain('aspect-ratio: auto')
    expect(await frame.$eval('#scrub', (el) => [getComputedStyle(el).width, getComputedStyle(el).height])).toEqual([
      '200px',
      '100px',
    ])
  }, 15_000)

  it('uses a loaded image natural ratio instead of its auto fallback while editing', async () => {
    const src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>')}`
    const frame = await seedScrubTarget('', {
      target: `<img id="scrub" src="${src}" style="width:200px;height:auto;aspect-ratio:auto 1 / 1">`,
    })
    await page.waitForSelector('[aria-label="Link width and height"][aria-pressed="true"]')
    await page.click('[aria-label="Width"]', { count: 3 })
    await page.keyboard.type('400')
    await page.keyboard.press('Enter')
    await expect.poll(() => saved.html).toContain('height: 200px')
    expect(await frame.$eval('#scrub', (el) => getComputedStyle(el).width)).toBe('400px')
  }, 15_000)

  it('requires positive dimensions before linking and supports the keyboard toggle', async () => {
    const frame = await seedScrubTarget('width:0px;height:0px')
    const toggle = '[aria-label="Link width and height"]'
    expect(await page.$eval(toggle, (el) => (el as HTMLButtonElement).disabled)).toBe(true)
    for (const [label, value] of [
      ['Width', '80'],
      ['Height', '40'],
    ]) {
      await page.click(`[aria-label="${label}"]`, { count: 3 })
      await page.keyboard.type(value!)
      await page.keyboard.press('Enter')
    }
    await page.waitForSelector(`${toggle}:not([disabled])`)
    await page.focus(toggle)
    await page.keyboard.press('Space')
    await page.waitForSelector(`${toggle}[aria-pressed="true"]`)
    await frame.waitForFunction(() => (document.querySelector('#scrub') as HTMLElement).style.aspectRatio === '80 / 40')
    await expect.poll(() => saved.html).toContain('aspect-ratio: 80 / 40')
  }, 15_000)
})
