import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot.ts'
import { fixtureUrl, pagePerTest } from './browser.ts'
import { acquireComponent, type StoryTab } from '../shared/storybookAcquire.ts'
import { storybookPage, CAPTURE_ROOT_ATTR, type StoryCommand } from '../shared/storybookCapture.ts'
import { buildKit } from '../shared/storybookKit.ts'

/*
 * The in-page half of the Storybook import, in Chromium, against a preview played by
 * tests/fixtures/iframe.html: reading props from the story store, re-rendering through the
 * channel, capturing from the CSSOM, stepping past decorators, dark through the theme global.
 */

describe.skipIf(!findBrowserPath())('capturing a Storybook story', () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.evaluateOnNewDocument('globalThis.__name = (target) => target')
  })

  const tab = (): StoryTab => ({
    async open(url) {
      await page.goto(url, { waitUntil: 'load' })
    },
    run: (command: StoryCommand) => page.evaluate(storybookPage, command),
    async screenshot() {
      const root = await page.$(`[${CAPTURE_ROOT_ATTR}]`)
      return root ? Buffer.from(await root.screenshot({ type: 'png' })) : undefined
    },
    async colorScheme(dark) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }])
    },
  })

  const component = {
    title: 'UI/Button',
    name: 'Button',
    baseStoryId: 'ui-button--default',
    stories: [{ id: 'ui-button--default', name: 'Default' }],
  }

  it('reads the props, renders each value and dark, and captures the button past its decorator', async () => {
    const base = new URL(fixtureUrl(''))
    const capture = await acquireComponent(tab(), base, component)

    expect(capture.description).toBe('The button for every action.')
    expect(capture.props.map((p) => `${p.name}:${p.options.join('|')}=${p.default}`)).toEqual([
      'variant:solid|ghost=solid',
      'size:md|sm=md',
      'disabled:false|true=false',
    ])
    expect(capture.texts).toEqual([{ name: 'label', arg: 'label', value: 'Save changes', description: 'What it says' }])
    expect(capture.variants.map((v) => `${v.prop}=${v.value}`)).toEqual(['variant=ghost', 'size=sm', 'disabled=true'])

    /* the decorator is gone, the generated ids too */
    expect(capture.base.html).toMatch(/^<button class="btn btn-solid h-9/)
    expect(capture.base.html).not.toContain('radix-')
    /* CSSOM rules, CSS-in-JS ones included, and only the ones that apply */
    const css = capture.base.rules.join('\n')
    expect(css).toContain('letter-spacing: 0.5px')
    expect(css).toContain(String.raw`.\[\&_svg\]\:w-4 svg`)
    expect(css).not.toContain('unused-elsewhere')
    expect(css).not.toContain('#storybook-root')
    expect(capture.base.vars).toMatchObject({ '--primary': '#0177d3', '--radius': '8px' })
    expect(capture.darkVars).toEqual({ '--primary': '#7cc4ff' })
    expect(capture.screenshot).toBeTruthy()

    const kit = buildKit([capture])
    const built = kit.components[0]!
    /* as the CSSOM serializes it: `background: transparent` is all initial values */
    expect(built.css).toContain('.sb-root[data-variant="ghost"] { color: var(--primary); background: 0px 0px; }')
    expect(built.css).toContain(
      '.sb-root[data-variant="solid"] { background: var(--primary); color: rgb(255, 255, 255); }',
    )
    expect(built.css).toContain('.sb-root[data-size="sm"] { height: 28px; }')
    expect(built.css).toContain('.btn:hover { filter: brightness(1.1); }')
    expect(built.css).not.toContain('padding: 20px')
    expect(built.html).toContain('data-doop-prop="label"')
    expect(kit.tokens).toEqual([
      { name: '--primary', type: 'color', value: '#0177d3', themes: { dark: '#7cc4ff' } },
      { name: '--radius', type: 'radius', value: '8px' },
    ])
  })

  it('keeps an inherited story font through a tag reset and lets a variant change it', async () => {
    const capture = await acquireComponent(tab(), new URL(fixtureUrl('')), component)
    capture.base.text['font-family'] = 'Georgia, serif'
    capture.base.rules.push('button, span { font-family: inherit; }', '.btn-ghost { font-family: monospace; }')
    const built = buildKit([capture]).components[0]!
    await page.setContent(`<style>${built.css}</style>${built.html}`)
    const family = () => page.$eval('.label', (label) => getComputedStyle(label).fontFamily)
    expect(await family()).toBe('Georgia, serif')
    await page.$eval('.sb-root', (root) => root.setAttribute('data-variant', 'ghost'))
    expect(await family()).toBe('monospace')
  })

  it('preserves a root class reset across the capture, including descendant and variant fonts', async () => {
    await tab().open(new URL('iframe.html?id=ui-button--default', fixtureUrl('')).href)
    await page.addStyleTag({
      content:
        '.theme-provider { font-family: Georgia; } .btn, .label { font: inherit; } .btn-ghost { font-family: monospace; }',
    })
    const capture = await acquireComponent({ ...tab(), open: async () => {} }, new URL(fixtureUrl('')), component)
    const built = buildKit([capture]).components[0]!
    await page.setContent(`<style>${built.css}</style>${built.html}`)
    const family = () => page.$eval('.label', (label) => getComputedStyle(label).fontFamily)
    expect(await family()).toBe('Georgia')
    await page.$eval('.sb-root', (root) => root.setAttribute('data-variant', 'ghost'))
    expect(await family()).toBe('monospace')
  })

  it('captures the selected label at its desktop size on a touch-only renderer', async () => {
    await page.setViewport({ width: 1280, height: 900, hasTouch: true })
    const base = new URL(fixtureUrl(''))
    const capture = await acquireComponent(tab(), base, component, { select: '.label' })
    expect(capture.base.html).toBe('<span class="label">Save changes</span>')
    expect(capture.base.height).toBeGreaterThan(0)
    expect(capture.screenshot).toBeTruthy()
  })
})
