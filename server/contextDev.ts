import { parsePublicHttpUrl } from './publicUrl.ts'
import { WebsiteCaptureUnavailableError } from './websiteAccess.ts'
import { MAX_FRAME_HTML_BYTES } from './limits.ts'

const CONTEXT_HTML_ENDPOINT = 'https://api.context.dev/v1/web/scrape/html'
const CONTEXT_SITEMAP_ENDPOINT = 'https://api.context.dev/v1/web/scrape/sitemap'
const CONTEXT_TIMEOUT_MS = 45_000
const MAX_ERROR_MESSAGE_CHARS = 240

export interface ContextWebsiteHtml {
  html: string
  finalUrl: string
  title: string
  description: string
}

interface ContextSitemapBody {
  success?: unknown
  urls?: unknown
}

interface ContextErrorBody {
  message?: unknown
  error_code?: unknown
}

interface ContextHtmlBody {
  success?: unknown
  html?: unknown
  url?: unknown
  type?: unknown
  metadata?: {
    finalUrl?: unknown
    title?: unknown
    description?: unknown
  }
}

export function contextDevConfigured(): boolean {
  return !!process.env.CONTEXT_DEV_API_KEY?.trim()
}

function shortMessage(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS) : ''
}

/** Context.dev owns remote navigation, JavaScript rendering, proxy escalation,
 * and challenge handling. Doop still turns the returned DOM into a passive,
 * editable frame and renders that HTML locally for previews. */
export async function scrapeContextWebsiteHtml(
  rawUrl: string,
  request: typeof fetch = fetch,
): Promise<ContextWebsiteHtml> {
  const apiKey = process.env.CONTEXT_DEV_API_KEY?.trim()
  if (!apiKey) throw new Error('CONTEXT_DEV_API_KEY is not configured')

  const requestedUrl = parsePublicHttpUrl(rawUrl)
  const endpoint = new URL(CONTEXT_HTML_ENDPOINT)
  endpoint.searchParams.set('url', requestedUrl.href)
  endpoint.searchParams.set('maxAgeMs', '0')
  endpoint.searchParams.set('waitForMs', '500')
  endpoint.searchParams.set('settleAnimations', 'true')
  endpoint.searchParams.set('timeoutMS', String(CONTEXT_TIMEOUT_MS))

  let response: Response
  try {
    response = await request(endpoint, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CONTEXT_TIMEOUT_MS + 5_000),
    })
  } catch {
    throw new WebsiteCaptureUnavailableError('Context.dev could not reach or finish capturing the website')
  }

  let body: ContextErrorBody & ContextHtmlBody
  try {
    body = (await response.json()) as ContextErrorBody & ContextHtmlBody
  } catch {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Context.dev returned an invalid authentication response (HTTP ${response.status})`)
    }
    throw new WebsiteCaptureUnavailableError(`Context.dev returned an invalid response (HTTP ${response.status})`)
  }

  if (!response.ok) {
    const code = shortMessage(body.error_code)
    const detail = shortMessage(body.message)
    const suffix = detail ? `: ${detail}` : ''
    if (response.status === 401 || (response.status === 403 && code !== 'WEBSITE_BLOCKED')) {
      throw new Error(`Context.dev rejected CONTEXT_DEV_API_KEY${code ? ` (${code})` : ''}${suffix}`)
    }
    if (
      code === 'WEBSITE_BLOCKED' ||
      code === 'WEBSITE_ACCESS_ERROR' ||
      code === 'CONTENT_TOO_LARGE' ||
      code === 'UNSUPPORTED_CONTENT' ||
      response.status === 404 ||
      response.status === 408 ||
      response.status === 413 ||
      response.status === 415 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new WebsiteCaptureUnavailableError(
        `Context.dev could not capture the website${code ? ` (${code})` : ` (HTTP ${response.status})`}${suffix}`,
      )
    }
    throw new WebsiteCaptureUnavailableError(
      `Context.dev could not scrape the URL${code ? ` (${code})` : ` (HTTP ${response.status})`}${suffix}`,
    )
  }

  if (body.success !== true || typeof body.html !== 'string' || !body.html.trim()) {
    throw new WebsiteCaptureUnavailableError('Context.dev returned no webpage HTML')
  }
  if (Buffer.byteLength(body.html) > MAX_FRAME_HTML_BYTES) {
    throw new WebsiteCaptureUnavailableError('Context.dev returned webpage HTML that is too large to import safely')
  }
  if (body.type !== 'html') {
    throw new WebsiteCaptureUnavailableError(
      `The URL returned ${shortMessage(body.type) || 'non-HTML content'}, not a webpage`,
    )
  }

  const rawFinalUrl =
    typeof body.metadata?.finalUrl === 'string'
      ? body.metadata.finalUrl
      : typeof body.url === 'string'
        ? body.url
        : requestedUrl.href
  let finalUrl: string
  try {
    finalUrl = parsePublicHttpUrl(rawFinalUrl).href
  } catch {
    throw new WebsiteCaptureUnavailableError('Context.dev returned an unsafe final website URL')
  }

  return {
    html: body.html,
    finalUrl,
    title: shortMessage(body.metadata?.title),
    description: shortMessage(body.metadata?.description),
  }
}

/** Discover declared pages through Context.dev without asking Doop's server to
 * crawl arbitrary website URLs itself. The rendered seed page still supplies
 * ordinary links when a site has no sitemap. */
export async function scrapeContextSitemap(
  rawUrl: string,
  maxLinks: number,
  request: typeof fetch = fetch,
): Promise<string[]> {
  const apiKey = process.env.CONTEXT_DEV_API_KEY?.trim()
  if (!apiKey) throw new Error('CONTEXT_DEV_API_KEY is not configured')

  const requestedUrl = parsePublicHttpUrl(rawUrl)
  const boundedMaxLinks = Math.min(Math.max(Math.round(maxLinks), 1), 100_000)
  const endpoint = new URL(CONTEXT_SITEMAP_ENDPOINT)
  endpoint.searchParams.set('domain', requestedUrl.hostname)
  endpoint.searchParams.set('maxLinks', String(boundedMaxLinks))
  endpoint.searchParams.set('timeoutMS', String(CONTEXT_TIMEOUT_MS))

  let response: Response
  try {
    response = await request(endpoint, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CONTEXT_TIMEOUT_MS + 5_000),
    })
  } catch {
    throw new WebsiteCaptureUnavailableError('Context.dev could not finish discovering the website pages')
  }

  let body: ContextErrorBody & ContextSitemapBody
  try {
    body = (await response.json()) as ContextErrorBody & ContextSitemapBody
  } catch {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Context.dev returned an invalid sitemap authentication response (HTTP ${response.status})`)
    }
    throw new WebsiteCaptureUnavailableError(
      `Context.dev returned an invalid sitemap response (HTTP ${response.status})`,
    )
  }

  if (!response.ok) {
    const code = shortMessage(body.error_code)
    const detail = shortMessage(body.message)
    const suffix = detail ? `: ${detail}` : ''
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Context.dev rejected CONTEXT_DEV_API_KEY${code ? ` (${code})` : ''}${suffix}`)
    }
    if (
      code === 'WEBSITE_ACCESS_ERROR' ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new WebsiteCaptureUnavailableError(
        `Context.dev could not discover the website pages${code ? ` (${code})` : ` (HTTP ${response.status})`}${suffix}`,
      )
    }
    throw new WebsiteCaptureUnavailableError(
      `Context.dev could not discover the website pages${code ? ` (${code})` : ` (HTTP ${response.status})`}${suffix}`,
    )
  }

  if (body.success !== true || !Array.isArray(body.urls)) {
    throw new WebsiteCaptureUnavailableError('Context.dev returned no website sitemap')
  }
  return body.urls.filter((url): url is string => typeof url === 'string').slice(0, boundedMaxLinks)
}

/** `page.setContent` starts at about:blank. Rebase relative CSS/images onto
 * the post-redirect URL while removing document policies that would navigate
 * or prevent the returned snapshot from rendering in its isolated page. */
export function prepareContextHtmlForRendering(html: string, finalUrl: string): string {
  const safeFinalUrl = parsePublicHttpUrl(finalUrl).href
  const originalBase = html.match(/<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i)
  let resolvedBase = safeFinalUrl
  if (originalBase) {
    const rawHref = (originalBase[1] ?? originalBase[2] ?? originalBase[3] ?? '')
      .replace(/&amp;/gi, '&')
      .replace(/&#0*38;|&#x0*26;/gi, '&')
    try {
      resolvedBase = parsePublicHttpUrl(new URL(rawHref, safeFinalUrl).href).href
    } catch {
      /* Ignore an unsafe or malformed document base and use the final page URL. */
    }
  }
  const base = `<base href="${resolvedBase.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`
  const prepared = html
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
  const head = prepared.match(/<head\b[^>]*>/i)
  if (head) return prepared.replace(head[0], head[0] + base)
  return base + prepared
}
