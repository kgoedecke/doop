import { beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({ openIsolatedPage: vi.fn() }))
const contextMocks = vi.hoisted(() => ({ configured: vi.fn(), scrape: vi.fn(), sitemap: vi.fn() }))
const publicUrlMocks = vi.hoisted(() => ({ fetchPinned: vi.fn() }))

vi.mock('../server/screenshot.ts', () => ({ openIsolatedPage: browserMocks.openIsolatedPage }))
vi.mock('../server/contextDev.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/contextDev.ts')>()
  return {
    ...actual,
    contextDevConfigured: contextMocks.configured,
    scrapeContextSitemap: contextMocks.sitemap,
    scrapeContextWebsiteHtml: contextMocks.scrape,
  }
})
vi.mock('../server/publicUrl.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/publicUrl.ts')>()
  return {
    ...actual,
    assertPublicNetworkUrl: vi.fn(async (raw: string | URL) => actual.parsePublicHttpUrl(String(raw))),
    fetchPinnedPublicUrl: publicUrlMocks.fetchPinned,
    guardPublicPageRequests: vi.fn(async () => {}),
  }
})

import {
  comparePageUrlsByDepth,
  discoverSitePages,
  importPage,
  importedPageSource,
  normalizePageUrl,
  parseHtmlPage,
  parseSitemap,
} from '../server/importer.ts'

interface PageStubOptions {
  finalUrl?: string
  preview?: { description: string; text: string; pageHeight: number; hasVisualContent?: boolean }
  screenshot?: Buffer
  snapshot?: { baseUrl?: string; sheets: string[]; title: string; height: number; html: string }
  /** Context.dev captures render with scripts disabled, so importPage skips
   *  the scroll-walk evaluate — the stub's call sequence must match. */
  contextPath?: boolean
}

function stubPage(options: PageStubOptions = {}) {
  const finalUrl = options.finalUrl ?? 'https://example.com/final'
  const mainFrame = {}
  const evaluate = vi.fn()
  if (!options.contextPath) evaluate.mockResolvedValueOnce(undefined)
  evaluate.mockResolvedValueOnce(
    options.snapshot ?? {
      sheets: [],
      title: 'Captured page',
      height: 777,
      html: '<html><head></head><body>Captured</body></html>',
    },
  )
  if (options.preview) evaluate.mockResolvedValueOnce(options.preview)
  const page = {
    setViewport: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setJavaScriptEnabled: vi.fn().mockResolvedValue(undefined),
    setContent: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    mainFrame: vi.fn(() => mainFrame),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    url: vi.fn(() => finalUrl),
    evaluate,
    screenshot: vi.fn().mockResolvedValue(options.screenshot ?? Buffer.from('jpeg')),
    close: vi.fn().mockResolvedValue(undefined),
  }
  browserMocks.openIsolatedPage.mockResolvedValue({ page, close: page.close })
  return page
}

beforeEach(() => {
  browserMocks.openIsolatedPage.mockReset()
  contextMocks.configured.mockReset().mockReturnValue(false)
  contextMocks.scrape.mockReset()
  contextMocks.sitemap.mockReset()
  publicUrlMocks.fetchPinned.mockReset()
})

describe('website page discovery helpers', () => {
  const site = new URL('https://example.com/pricing')

  it('keeps same-site pages while normalizing tracking parameters and fragments', () => {
    const page = normalizePageUrl('http://example.com/docs/?utm_source=newsletter&b=2&a=1#overview', site, site)
    expect(page?.href).toBe('https://example.com/docs/?a=1&b=2')
    expect(normalizePageUrl('https://other.example/docs', site, site)).toBeNull()
    expect(normalizePageUrl('/assets/diagram.svg', site, site)).toBeNull()
    expect(normalizePageUrl('mailto:hello@example.com', site, site)).toBeNull()
  })

  it('extracts a readable title and resolves links against a document base', () => {
    const parsed = parseHtmlPage(
      `<!doctype html><title>Docs &amp; Guides</title>
       <base href="/help/">
       <a href="getting-started">Start</a>
       <a href='/pricing?plan=pro&amp;cycle=annual'>Pricing</a>`,
      new URL('https://example.com/docs'),
    )
    expect(parsed.title).toBe('Docs & Guides')
    expect(parsed.links).toEqual([
      'https://example.com/help/getting-started',
      'https://example.com/pricing?plan=pro&cycle=annual',
    ])
  })

  it('reads ordinary and CDATA sitemap locations', () => {
    const parsed = parseSitemap(`
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/pages.xml?part=1&amp;lang=en</loc></sitemap>
        <sitemap><loc><![CDATA[https://example.com/pages-2.xml]]></loc></sitemap>
      </sitemapindex>
    `)
    expect(parsed).toEqual({
      index: true,
      urls: ['https://example.com/pages.xml?part=1&lang=en', 'https://example.com/pages-2.xml'],
    })
  })

  it('orders first-level paths before nested pages', () => {
    const pages = [
      'https://example.com/use-cases/education',
      'https://example.com/blog/launch',
      'https://example.com/privacy',
      'https://example.com/',
      'https://example.com/blog',
      'https://example.com/use-cases',
    ]
    expect(pages.sort(comparePageUrlsByDepth)).toEqual([
      'https://example.com/',
      'https://example.com/blog',
      'https://example.com/privacy',
      'https://example.com/use-cases',
      'https://example.com/blog/launch',
      'https://example.com/use-cases/education',
    ])
  })

  it('uses Context.dev HTML and sitemap discovery without crawling from Chromium when configured', async () => {
    contextMocks.configured.mockReturnValue(true)
    contextMocks.scrape.mockResolvedValue({
      html: '<html><head><title>Fallback title</title></head><body><a href="/about">About</a><a href="https://other.example/out">Other</a></body></html>',
      finalUrl: 'https://example.com/start',
      title: 'Start here',
      description: '',
    })
    contextMocks.sitemap.mockResolvedValue(['https://example.com/pricing', 'https://example.com/products/widget'])

    const discovered = await discoverSitePages('https://example.com/original')

    expect(contextMocks.scrape).toHaveBeenCalledWith('https://example.com/original')
    expect(contextMocks.sitemap).toHaveBeenCalledWith('https://example.com/start', 101)
    expect(browserMocks.openIsolatedPage).not.toHaveBeenCalled()
    expect(discovered).toEqual({
      siteUrl: 'https://example.com',
      truncated: false,
      pages: [
        { url: 'https://example.com/', title: 'Home' },
        { url: 'https://example.com/about', title: 'About' },
        { url: 'https://example.com/pricing', title: 'Pricing' },
        { url: 'https://example.com/start', title: 'Start here' },
        { url: 'https://example.com/products/widget', title: 'Widget' },
      ],
    })
  })
})

describe('webpage capture', () => {
  it('uses direct Chromium for bare domains when Context.dev is not configured', async () => {
    const page = stubPage()

    const imported = await importPage('example.com/pricing')

    expect(page.goto).toHaveBeenCalledWith('https://example.com/pricing', {
      waitUntil: 'networkidle2',
      timeout: 30_000,
    })
    expect(page.screenshot).not.toHaveBeenCalled()
    expect(imported).not.toHaveProperty('preview')
    expect(imported).toMatchObject({ title: 'Captured page', width: 1280, height: 777 })
    expect(imported.html).toContain('<base href="https://example.com/final">')
    expect(imported.html).toContain('Content-Security-Policy')
    expect(importedPageSource(imported.html)).toBe('https://example.com/pricing')
    expect(browserMocks.openIsolatedPage).toHaveBeenCalledOnce()
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('uses Context.dev HTML without navigating Chromium when configured', async () => {
    contextMocks.configured.mockReturnValue(true)
    contextMocks.scrape.mockResolvedValue({
      html: '<!doctype html><html><head><base href="/assets/"></head><body>From Context</body></html>',
      finalUrl: 'https://www.example.com/redirected',
      title: 'Context title',
      description: 'Context description',
    })
    const page = stubPage({
      finalUrl: 'about:blank',
      contextPath: true,
      snapshot: {
        baseUrl: 'https://www.example.com/assets/',
        sheets: [],
        title: 'Captured page',
        height: 777,
        html: '<html><head></head><body>Captured</body></html>',
      },
    })

    const imported = await importPage('example.com/pricing')

    expect(contextMocks.scrape).toHaveBeenCalledWith('https://example.com/pricing')
    expect(page.goto).not.toHaveBeenCalled()
    expect(page.setJavaScriptEnabled).toHaveBeenCalledWith(false)
    expect(page.setContent).toHaveBeenCalledWith(
      expect.stringContaining('<base href="https://www.example.com/assets/">'),
      { waitUntil: 'domcontentloaded', timeout: 20_000 },
    )
    expect(imported.html).toContain('<base href="https://www.example.com/assets/">')
    expect(importedPageSource(imported.html)).toBe('https://example.com/pricing')
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('does not retry through Chromium when configured Context.dev fails', async () => {
    contextMocks.configured.mockReturnValue(true)
    contextMocks.scrape.mockRejectedValue(new Error('Context.dev unavailable'))

    await expect(importPage('https://example.com')).rejects.toThrow('Context.dev unavailable')

    expect(browserMocks.openIsolatedPage).not.toHaveBeenCalled()
  })

  const css = (body: string) => new Response(body, { headers: { 'content-type': 'text/css' } })
  const blocked = (status = 200) =>
    new Response('<html>challenge</html>', { status, headers: { 'content-type': 'text/html' } })
  const stubContextPageWithSheets = (sheets: string[]) => {
    contextMocks.configured.mockReturnValue(true)
    contextMocks.scrape.mockResolvedValue({
      html: '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>From Context</body></html>',
      finalUrl: 'https://example.com/final',
      title: 'Context title',
      description: '',
    })
    return stubPage({
      finalUrl: 'about:blank',
      contextPath: true,
      snapshot: {
        sheets,
        title: 'Context title',
        height: 777,
        html: '<html><head></head><body>From Context</body></html>',
      },
    })
  }

  it('rejects captured HTML when every external stylesheet is blocked', async () => {
    publicUrlMocks.fetchPinned.mockResolvedValue(blocked())
    const page = stubContextPageWithSheets(['https://example.com/app.css'])

    await expect(importPage('https://example.com')).rejects.toThrow('stylesheets could not be fully loaded')

    expect(publicUrlMocks.fetchPinned).toHaveBeenCalledWith(
      new URL('https://example.com/app.css'),
      expect.objectContaining({ redirect: 'manual' }),
    )
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('rejects a partial stylesheet capture instead of accepting a materially unstyled page', async () => {
    publicUrlMocks.fetchPinned
      .mockResolvedValueOnce(css('html { box-sizing: border-box }'))
      .mockResolvedValueOnce(blocked(403))
    const page = stubContextPageWithSheets(['https://example.com/reset.css', 'https://example.com/app.css'])

    await expect(importPage('https://example.com')).rejects.toThrow('stylesheets could not be fully loaded')

    expect(publicUrlMocks.fetchPinned).toHaveBeenCalledTimes(2)
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('inlines a single stylesheet that uses most of the page CSS budget', async () => {
    /* One big bundled sheet is how real sites ship CSS; a per-sheet cap below
       the page budget used to turn it away. */
    const bundled = `body { color: red } ${'/* padding */'.repeat(120_000)}`
    publicUrlMocks.fetchPinned.mockResolvedValue(css(bundled))
    const page = stubContextPageWithSheets(['https://example.com/app.css'])

    const imported = await importPage('https://example.com')

    expect(bundled.length).toBeGreaterThan(1_500_000)
    expect(imported.html).toContain('body { color: red }')
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('blames its own budget, not the site, when a declared stylesheet size exceeds it', async () => {
    publicUrlMocks.fetchPinned.mockResolvedValue(
      new Response('body { color: red }', { headers: { 'content-type': 'text/css', 'content-length': '2500000' } }),
    )
    const page = stubContextPageWithSheets(['https://example.com/app.css'])

    await expect(importPage('https://example.com')).rejects.toThrow('2 MB import limit')
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('stops reading a streamed stylesheet without content-length once it passes the budget', async () => {
    publicUrlMocks.fetchPinned.mockResolvedValue(css('x'.repeat(2_100_000)))
    const page = stubContextPageWithSheets(['https://example.com/app.css'])

    await expect(importPage('https://example.com')).rejects.toThrow('2 MB import limit')
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('charges every sheet against one page budget', async () => {
    publicUrlMocks.fetchPinned
      .mockResolvedValueOnce(css('a'.repeat(1_200_000)))
      .mockResolvedValueOnce(css('b'.repeat(1_200_000)))
    const page = stubContextPageWithSheets(['https://example.com/vendor.css', 'https://example.com/app.css'])

    await expect(importPage('https://example.com')).rejects.toThrow('2 MB import limit')
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('does not call a small stylesheet oversized when a nested @import is dropped', async () => {
    /* app.css → mid.css → deep.css. The third level is past the supported
       import depth, so the capture is incomplete — but nothing here is big,
       and the error must not claim a size limit. */
    publicUrlMocks.fetchPinned
      .mockResolvedValueOnce(css("@import url('/mid.css');"))
      .mockResolvedValueOnce(css("@import url('/deep.css');"))
    const page = stubContextPageWithSheets(['https://example.com/app.css'])

    const error = await importPage('https://example.com').catch((thrown: Error) => thrown)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('could not be fully loaded')
    expect((error as Error).message).not.toContain('import limit')
    expect(publicUrlMocks.fetchPinned).toHaveBeenCalledTimes(2)
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('stops fetching @imports after the first one fails', async () => {
    publicUrlMocks.fetchPinned
      .mockResolvedValueOnce(css("@import url('/a.css'); @import url('/b.css');"))
      .mockResolvedValueOnce(blocked(403))
    const page = stubContextPageWithSheets(['https://example.com/app.css'])

    await expect(importPage('https://example.com')).rejects.toThrow('could not be fully loaded')
    expect(publicUrlMocks.fetchPinned).toHaveBeenCalledTimes(2)
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('returns a bounded screenshot and text preview when requested', async () => {
    const screenshot = Buffer.from('agent-preview')
    const page = stubPage({
      finalUrl: 'https://www.example.com/redirected',
      preview: {
        description: 'A real product page',
        text: 'x'.repeat(6_005),
        pageHeight: 9_000,
      },
      screenshot,
    })

    const imported = await importPage('https://example.com', { includePreview: true })

    expect(page.screenshot).toHaveBeenCalledWith({
      type: 'jpeg',
      quality: 80,
      clip: { x: 0, y: 0, width: 1280, height: 4_000 },
    })
    expect(imported.preview).toEqual({
      screenshot,
      finalUrl: 'https://www.example.com/redirected',
      description: 'A real product page',
      text: 'x'.repeat(6_000),
      textTruncated: true,
      shotCropped: true,
      pageHeight: 9_000,
    })
    expect(browserMocks.openIsolatedPage).toHaveBeenCalledTimes(2)
    expect(page.close).toHaveBeenCalledTimes(2)
  })

  it('renders the Context.dev HTML locally for the agent preview', async () => {
    contextMocks.configured.mockReturnValue(true)
    contextMocks.scrape.mockResolvedValue({
      html: '<!doctype html><html><head></head><body>From Context</body></html>',
      finalUrl: 'https://example.com/final',
      title: 'Context title',
      description: 'Context description',
    })
    const screenshot = Buffer.from('local-preview')
    const page = stubPage({
      finalUrl: 'about:blank',
      contextPath: true,
      preview: { description: '', text: 'Rendered Context page', pageHeight: 700 },
      screenshot,
    })

    const imported = await importPage('https://example.com', { includePreview: true })

    expect(contextMocks.scrape).toHaveBeenCalledOnce()
    expect(page.goto).not.toHaveBeenCalled()
    expect(page.screenshot).toHaveBeenCalledOnce()
    expect(imported.preview).toMatchObject({
      screenshot,
      finalUrl: 'https://example.com/final',
      description: 'Context description',
      text: 'Rendered Context page',
    })
    expect(browserMocks.openIsolatedPage).toHaveBeenCalledTimes(2)
    expect(page.close).toHaveBeenCalledTimes(2)
  })

  it('returns a capture error when the acquired HTML renders no visible content', async () => {
    const page = stubPage({
      preview: { description: '', text: '', hasVisualContent: false, pageHeight: 400 },
    })

    await expect(importPage('https://example.com', { includePreview: true })).rejects.toThrow(
      'The acquired webpage rendered empty',
    )

    expect(page.screenshot).not.toHaveBeenCalled()
    expect(browserMocks.openIsolatedPage).toHaveBeenCalledTimes(2)
    expect(page.close).toHaveBeenCalledTimes(2)
  })
})
