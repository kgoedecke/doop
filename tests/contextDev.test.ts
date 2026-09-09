import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  contextDevConfigured,
  prepareContextHtmlForRendering,
  scrapeContextSitemap,
  scrapeContextWebsiteHtml,
} from '../server/contextDev.ts'
import { WebsiteCaptureUnavailableError } from '../server/websiteAccess.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Context.dev rendered HTML client', () => {
  it('requests a fresh settled capture with bearer auth and parses a successful response', async () => {
    vi.stubEnv('CONTEXT_DEV_API_KEY', '  context-secret  ')
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        success: true,
        type: 'html',
        html: '<!doctype html><html><body>Captured</body></html>',
        url: 'https://example.com/pricing',
        metadata: {
          finalUrl: 'https://www.example.com/pricing?plan=pro',
          title: '  Example\nPricing  ',
          description: '  Plans   for everyone  ',
        },
      }),
    )

    const captured = await scrapeContextWebsiteHtml('https://example.com/pricing', request)

    expect(request).toHaveBeenCalledOnce()
    const [input, init] = request.mock.calls[0]!
    const endpoint = new URL(String(input))
    expect(`${endpoint.origin}${endpoint.pathname}`).toBe('https://api.context.dev/v1/web/scrape/html')
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      url: 'https://example.com/pricing',
      maxAgeMs: '0',
      waitForMs: '500',
      settleAnimations: 'true',
      timeoutMS: '45000',
    })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer context-secret')
    expect(new Headers(init?.headers).get('accept')).toBe('application/json')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(captured).toEqual({
      html: '<!doctype html><html><body>Captured</body></html>',
      finalUrl: 'https://www.example.com/pricing?plan=pro',
      title: 'Example Pricing',
      description: 'Plans for everyone',
    })
  })

  it('reports whether a trimmed API key is configured and fails before requesting when it is absent', async () => {
    vi.stubEnv('CONTEXT_DEV_API_KEY', '   ')
    const request = vi.fn(async () => jsonResponse({ success: true }))

    expect(contextDevConfigured()).toBe(false)
    await expect(scrapeContextWebsiteHtml('https://example.com', request)).rejects.toThrow(
      'CONTEXT_DEV_API_KEY is not configured',
    )
    expect(request).not.toHaveBeenCalled()

    vi.stubEnv('CONTEXT_DEV_API_KEY', 'configured')
    expect(contextDevConfigured()).toBe(true)
  })

  it('maps a blocked website response to the shared capture-unavailable error', async () => {
    vi.stubEnv('CONTEXT_DEV_API_KEY', 'context-secret')
    const request = vi.fn(async () =>
      jsonResponse(
        {
          error_code: 'WEBSITE_BLOCKED',
          message: 'Cloudflare challenged the capture',
        },
        400,
      ),
    )

    const error = await scrapeContextWebsiteHtml('https://example.com', request).catch((cause) => cause)

    expect(error).toBeInstanceOf(WebsiteCaptureUnavailableError)
    expect(error).toHaveProperty(
      'reason',
      'Context.dev could not capture the website (WEBSITE_BLOCKED): Cloudflare challenged the capture',
    )
  })

  it('surfaces an invalid API key as configuration failure, not a website access failure', async () => {
    vi.stubEnv('CONTEXT_DEV_API_KEY', 'invalid-secret')
    const request = vi.fn(async () =>
      jsonResponse(
        {
          error_code: 'UNAUTHORIZED',
          message: 'The supplied key is invalid',
        },
        401,
      ),
    )

    const error = await scrapeContextWebsiteHtml('https://example.com', request).catch((cause) => cause)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(WebsiteCaptureUnavailableError)
    expect(error).toHaveProperty(
      'message',
      'Context.dev rejected CONTEXT_DEV_API_KEY (UNAUTHORIZED): The supplied key is invalid',
    )
  })

  it.each([
    [413, 'CONTENT_TOO_LARGE'],
    [415, 'UNSUPPORTED_CONTENT'],
  ])('maps HTTP %s %s to a capture-unavailable error', async (status, errorCode) => {
    vi.stubEnv('CONTEXT_DEV_API_KEY', 'context-secret')
    const request = vi.fn(async () =>
      jsonResponse({ error_code: errorCode, message: 'Cannot import this page' }, status),
    )

    const error = await scrapeContextWebsiteHtml('https://example.com', request).catch((cause) => cause)

    expect(error).toBeInstanceOf(WebsiteCaptureUnavailableError)
    expect(error).toHaveProperty(
      'reason',
      `Context.dev could not capture the website (${errorCode}): Cannot import this page`,
    )
  })

  it('rejects an unsafe final URL returned by Context.dev', async () => {
    vi.stubEnv('CONTEXT_DEV_API_KEY', 'context-secret')
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        success: true,
        type: 'html',
        html: '<html><body>Captured</body></html>',
        metadata: { finalUrl: 'http://127.0.0.1/admin' },
      }),
    )

    const error = await scrapeContextWebsiteHtml('https://example.com', request).catch((cause) => cause)

    expect(error).toBeInstanceOf(WebsiteCaptureUnavailableError)
    expect(error).toHaveProperty('reason', 'Context.dev returned an unsafe final website URL')
  })

  it('discovers a bounded sitemap through Context.dev', async () => {
    vi.stubEnv('CONTEXT_DEV_API_KEY', 'context-secret')
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        success: true,
        domain: 'example.com',
        urls: ['https://example.com/', 'https://example.com/pricing', 42, 'https://example.com/docs'],
        meta: { sitemapsDiscovered: 1, sitemapsFetched: 1, sitemapsSkipped: 0, errors: 0 },
      }),
    )

    const urls = await scrapeContextSitemap('https://example.com/start', 2, request)

    const [input, init] = request.mock.calls[0]!
    const endpoint = new URL(String(input))
    expect(`${endpoint.origin}${endpoint.pathname}`).toBe('https://api.context.dev/v1/web/scrape/sitemap')
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      domain: 'example.com',
      maxLinks: '2',
      timeoutMS: '45000',
    })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer context-secret')
    expect(urls).toEqual(['https://example.com/', 'https://example.com/pricing'])
  })
})

describe('Context.dev HTML preparation', () => {
  it('rebases relative assets and removes inherited navigation and rendering policies', () => {
    const prepared = prepareContextHtmlForRendering(
      `<!doctype html><html><head>
        <base href="/assets/?theme=dark&amp;density=compact">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
        <meta HTTP-EQUIV='refresh' content="0; url=https://other.example">
        <title>Captured</title>
      </head><body><noscript>Enable JavaScript</noscript><img src="images/hero.png"></body></html>`,
      'https://example.com/products/item?currency=usd&region=us',
    )

    expect(prepared.match(/<base\b/gi)).toHaveLength(1)
    expect(prepared).toContain('<head><base href="https://example.com/assets/?theme=dark&amp;density=compact">')
    expect(prepared).not.toMatch(/http-equiv/i)
    expect(prepared).not.toMatch(/<noscript/i)
    expect(prepared).toContain('<img src="images/hero.png">')
  })

  it('falls back to the final page URL when the document base is unsafe', () => {
    const prepared = prepareContextHtmlForRendering(
      '<html><head><base href="http://127.0.0.1/private"></head><body></body></html>',
      'https://example.com/products/item',
    )

    expect(prepared).toContain('<head><base href="https://example.com/products/item">')
    expect(prepared).not.toContain('127.0.0.1')
  })

  it('prepends a base when the returned fragment has no head', () => {
    expect(prepareContextHtmlForRendering('<main><img src="hero.png"></main>', 'https://example.com/path/')).toBe(
      '<base href="https://example.com/path/"><main><img src="hero.png"></main>',
    )
  })
})
