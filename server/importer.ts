import { openIsolatedPage } from './screenshot.ts'
import {
  contextDevConfigured,
  prepareContextHtmlForRendering,
  scrapeContextSitemap,
  scrapeContextWebsiteHtml,
  type ContextWebsiteHtml,
} from './contextDev.ts'
import {
  assertPublicNetworkUrl,
  fetchPinnedPublicUrl,
  guardPublicPageRequests,
  normalizePublicHttpUrl,
  parsePublicHttpUrl,
} from './publicUrl.ts'
import { navigateWebsitePage, WebsiteCaptureUnavailableError } from './websiteAccess.ts'

/**
 * Website importer: discover a bounded set of same-site pages, or acquire one
 * rendered page and turn it into a self-contained frame. Context.dev performs
 * remote acquisition when configured; local Chromium is the no-key fallback
 * and always renders the passive snapshot. Scripts are stripped from imported
 * frames so they stay editable (WYSIWYG and agents reject script-bearing frames).
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 DoopImporter/1.0'
const VIEWPORT_WIDTH = 1280
const MAX_HEIGHT = 6000
const MAX_PREVIEW_HEIGHT = 4000
const MAX_PREVIEW_TEXT_CHARS = 6000
/* One budget for all of a page's CSS, shared by every sheet and @import.
   Real sites ship one big bundled stylesheet, so a per-sheet cap below the
   page budget only rejected pages that fit. */
const MAX_CSS_BYTES = 2_000_000
const MAX_DOCUMENT_BYTES = 3_000_000
const MAX_DISCOVERY_BYTES = 2_000_000
const MAX_SITEMAPS = 12
const DISCOVERY_CONCURRENCY = 6
const MAX_CSS_IMPORTS = 16
export const MAX_SITE_PAGES = 100

const IMPORT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob: http: https:',
  'font-src data: http: https:',
  'media-src data: blob: http: https:',
].join('; ')

const NON_PAGE_EXTENSIONS =
  /\.(?:avif|bmp|css|csv|docx?|eot|gif|gz|ico|jpe?g|js|json|map|mov|mp3|mp4|mpeg|ogg|otf|pdf|png|pptx?|rar|rss|svg|tar|tiff?|txt|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i

/** Kept as the synchronous parser used by discovery and REST validation. All
 *  actual network requests additionally use the DNS-aware async guard. */
export const assertPublicHttpUrl = parsePublicHttpUrl

export function normalizeImportUrl(raw: string): URL {
  return normalizePublicHttpUrl(raw)
}

/** A website is scoped to one hostname and (when explicit) port. We allow an
 * http URL on a page to resolve to https without treating it as another site. */
export function isSameSiteUrl(candidate: URL, site: URL): boolean {
  return candidate.hostname.toLowerCase() === site.hostname.toLowerCase() && candidate.port === site.port
}

/** Normalize a navigable page URL and reject links that cannot represent an
 * importable web page. Exported because the crawler rules are useful to test
 * without making network requests. */
export function normalizePageUrl(raw: string, base: URL, site: URL): URL | null {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isSameSiteUrl(url, site)) return null
  if (url.username || url.password || NON_PAGE_EXTENSIONS.test(url.pathname)) return null
  if (site.protocol === 'https:' && url.protocol === 'http:') url.protocol = 'https:'
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid|dclid|msclkid)$/i.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  return url
}

function pageKey(url: URL): string {
  const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}${url.search}`
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"', nbsp: ' ' }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1].toLowerCase() === 'x'
      const parsed = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff ? String.fromCodePoint(parsed) : all
    }
    return named[entity.toLowerCase()] ?? all
  })
}

function cleanTitle(value: string): string {
  return decodeEntities(
    value
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ).slice(0, 160)
}

export function parseHtmlPage(html: string, pageUrl: URL): { title: string; links: string[] } {
  const title = cleanTitle(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
  const baseHref = html.match(/<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i)
  let base = pageUrl
  try {
    if (baseHref) base = new URL(baseHref[1] ?? baseHref[2] ?? baseHref[3], pageUrl)
  } catch {
    /* malformed base; ordinary document-relative resolution is safer */
  }
  const links: string[] = []
  const hrefs = html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)
  for (const match of hrefs) {
    try {
      links.push(new URL(decodeEntities(match[1] ?? match[2] ?? match[3]), base).href)
    } catch {
      /* malformed link */
    }
  }
  return { title, links }
}

export function parseSitemap(xml: string): { index: boolean; urls: string[] } {
  const urls: string[] = []
  for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    let value = match[1].trim()
    if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) value = value.slice(9, -3)
    value = decodeEntities(value.trim())
    if (value) urls.push(value)
  }
  return { index: /<sitemapindex\b/i.test(xml), urls }
}

function fallbackTitle(url: URL): string {
  if (url.pathname === '/') return 'Home'
  const last = url.pathname.split('/').filter(Boolean).pop() ?? url.hostname
  try {
    return decodeURIComponent(last)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  } catch {
    return last
  }
}

/** Homepage first, then shallower paths before deeper descendants. Within a
 * level, keep the deterministic alphabetical/numeric order users expect. */
export function comparePageUrlsByDepth(a: string, b: string): number {
  const left = new URL(a)
  const right = new URL(b)
  const leftDepth = left.pathname.split('/').filter(Boolean).length
  const rightDepth = right.pathname.split('/').filter(Boolean).length
  if (leftDepth !== rightDepth) return leftDepth - rightDepth
  return `${left.pathname}${left.search}`.localeCompare(`${right.pathname}${right.search}`, undefined, {
    numeric: true,
  })
}

interface TextResponse {
  url: URL
  text: string
  contentType: string
}

/** Read decompressed response bytes with a hard cap instead of buffering an
 *  untrusted chunked body before truncating it. */
async function readTextBounded(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes || !response.body) return response.body ? null : ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Follow redirects manually so every hop is re-checked before it is fetched. */
async function fetchSiteText(rawUrl: string, site: URL, timeout = 8_000): Promise<TextResponse | null> {
  let url = parsePublicHttpUrl(rawUrl)
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!isSameSiteUrl(url, site)) return null
    let res: Response
    try {
      res = await fetchPinnedPublicUrl(url, {
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml,text/xml,*/*;q=0.1' },
        signal: AbortSignal.timeout(timeout),
      })
    } catch {
      return null
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return null
      try {
        url = parsePublicHttpUrl(new URL(location, url).href)
      } catch {
        return null
      }
      continue
    }
    if (!res.ok) return null
    if (res.headers.get('cf-mitigated')?.toLowerCase() === 'challenge') return null
    const text = await readTextBounded(res, MAX_DISCOVERY_BYTES)
    if (text === null) return null
    return { url, text, contentType: res.headers.get('content-type') ?? '' }
  }
  return null
}

async function sitemapPages(site: URL): Promise<string[]> {
  const sitemapQueue = [`${site.origin}/sitemap.xml`]
  const robots = await fetchSiteText(`${site.origin}/robots.txt`, site)
  if (robots) {
    for (const match of robots.text.matchAll(/^\s*sitemap:\s*(\S+)\s*$/gim)) sitemapQueue.push(match[1])
  }

  const seen = new Set<string>()
  const pages: string[] = []
  while (sitemapQueue.length && seen.size < MAX_SITEMAPS && pages.length < MAX_SITE_PAGES) {
    const raw = sitemapQueue.shift()!
    let sitemapUrl: URL
    try {
      sitemapUrl = assertPublicHttpUrl(new URL(raw, site).href)
    } catch {
      continue
    }
    if (!isSameSiteUrl(sitemapUrl, site) || seen.has(sitemapUrl.href)) continue
    seen.add(sitemapUrl.href)
    const response = await fetchSiteText(sitemapUrl.href, site)
    if (!response) continue
    const parsed = parseSitemap(response.text)
    if (parsed.index) sitemapQueue.push(...parsed.urls)
    else pages.push(...parsed.urls)
  }
  return pages
}

export interface DiscoveredPage {
  url: string
  title: string
}

export interface DiscoveredSite {
  siteUrl: string
  pages: DiscoveredPage[]
  truncated: boolean
}

/** Discover the homepage and sitemap entries. Without Context.dev, the local
 * fallback also scans linked HTML pages recursively. The hard cap keeps an
 * accidental calendar/archive crawl from becoming unbounded. */
export async function discoverSitePages(rawUrl: string): Promise<DiscoveredSite> {
  const useContext = contextDevConfigured()
  const requestedUrl = useContext ? normalizeImportUrl(rawUrl) : await assertPublicNetworkUrl(rawUrl)
  let seed: { url: URL; title: string; links: string[] }
  let contextSitemapUrls: string[] = []
  if (useContext) {
    const captured = await scrapeContextWebsiteHtml(requestedUrl.href)
    const finalUrl = new URL(captured.finalUrl)
    const parsed = parseHtmlPage(captured.html, finalUrl)
    seed = { url: finalUrl, title: cleanTitle(captured.title || parsed.title), links: parsed.links }
    try {
      contextSitemapUrls = await scrapeContextSitemap(finalUrl.href, MAX_SITE_PAGES + 1)
    } catch (error) {
      /* A missing/inaccessible sitemap does not invalidate the rendered seed
         page and the ordinary links Context already found there. */
      if (!(error instanceof WebsiteCaptureUnavailableError)) throw error
    }
  } else {
    const isolated = await openIsolatedPage()
    const { page } = isolated
    try {
      await guardPublicPageRequests(page)
      await page.setViewport({ width: VIEWPORT_WIDTH, height: 900 })
      await page.setUserAgent(UA)
      await navigateWebsitePage(
        page,
        requestedUrl.href,
        { waitUntil: 'domcontentloaded', timeout: 25_000 },
        { settleMs: 700 },
      )
      const finalUrl = await assertPublicNetworkUrl(page.url())
      const snapshot = await page.evaluate(() => ({
        title: document.title,
        links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'), (a) => a.href),
      }))
      seed = { url: finalUrl, title: cleanTitle(snapshot.title), links: snapshot.links }
    } finally {
      await isolated.close()
    }
  }

  const pages = new Map<string, DiscoveredPage>()
  let truncated = false
  const add = (raw: string, base = seed.url, title = '') => {
    const url = normalizePageUrl(raw, base, seed.url)
    if (!url) return
    const key = pageKey(url)
    const existing = pages.get(key)
    if (existing) {
      if (title && !existing.title) existing.title = cleanTitle(title)
      return
    }
    if (pages.size >= MAX_SITE_PAGES) {
      truncated = true
      return
    }
    pages.set(key, { url: url.href, title: cleanTitle(title) })
  }

  add(`${seed.url.origin}/`)
  add(seed.url.href, seed.url, seed.title)
  for (const link of seed.links) add(link)
  for (const link of useContext ? contextSitemapUrls : await sitemapPages(seed.url)) add(link)

  /* The rendered seed already gave us its links. Fetch the remaining pages
     in small batches to obtain titles and discover deeper static links. */
  if (!useContext) {
    const scanned = new Set<string>([pageKey(seed.url)])
    for (;;) {
      const batch = [...pages.entries()].filter(([key]) => !scanned.has(key)).slice(0, DISCOVERY_CONCURRENCY)
      if (!batch.length) break
      batch.forEach(([key]) => scanned.add(key))
      const results = await Promise.all(
        batch.map(async ([key, found]) => ({ key, found, response: await fetchSiteText(found.url, seed.url) })),
      )
      for (const { key, found, response } of results) {
        if (!response || (response.contentType && !/html|xhtml/i.test(response.contentType))) continue
        const parsed = parseHtmlPage(response.text, response.url)
        if (parsed.title) pages.get(key)!.title = parsed.title
        for (const link of parsed.links) add(link, response.url)
        /* Preserve the requested URL in the list; importPage follows the same
           redirect and the label remains recognizable to the user. */
        if (!pages.get(key)?.title) pages.get(key)!.title = fallbackTitle(new URL(found.url))
      }
    }
  }

  const result = [...pages.values()]
    .map((found) => ({ ...found, title: found.title || fallbackTitle(new URL(found.url)) }))
    .sort((a, b) => comparePageUrlsByDepth(a.url, b.url))

  return { siteUrl: seed.url.origin, pages: result, truncated }
}

export interface ImportedPageResult {
  url: string
  page?: ImportedPage
  error?: string
}

/** Capture several pages without opening an unbounded number of Chromium tabs. */
export async function importSitePages(rawUrls: string[], concurrency = 3): Promise<ImportedPageResult[]> {
  const results = new Array<ImportedPageResult>(rawUrls.length)
  let cursor = 0
  async function worker() {
    for (;;) {
      const index = cursor++
      if (index >= rawUrls.length) return
      const url = rawUrls[index]
      try {
        results[index] = { url, page: await importPage(url) }
      } catch (error) {
        results[index] = { url, error: error instanceof Error ? error.message : 'import failed' }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), rawUrls.length) }, () => worker()))
  return results
}

type CapturedCss = { ok: true; css: string } | { ok: false; reason: 'oversized' | 'unreachable' }

const OVERSIZED: CapturedCss = { ok: false, reason: 'oversized' }
const UNREACHABLE: CapturedCss = { ok: false, reason: 'unreachable' }

const CSS_OVERSIZED_MESSAGE = `This page's stylesheets are larger than Doop's ${MAX_CSS_BYTES / 1_000_000} MB import limit`
const CSS_UNREACHABLE_MESSAGE = 'The webpage HTML was captured, but one or more stylesheets could not be fully loaded'

/** Fetch a stylesheet within the bytes still available for the page's CSS,
 *  resolve depth-1 @imports against the same budget, absolutize its url() refs.
 *  Fetching stops at the first failure: the import cannot succeed anyway, and
 *  the budget bounds how much an untrusted host can make us download. */
async function fetchCss(sheetUrl: string, budget: number, depth = 0): Promise<CapturedCss> {
  if (depth > 1) return UNREACHABLE
  let url: URL
  let res: Response | undefined
  let css: string
  try {
    url = parsePublicHttpUrl(sheetUrl)
    for (let redirects = 0; redirects <= 5; redirects++) {
      res = await fetchPinnedPublicUrl(url, {
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/css,*/*;q=0.1' },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status < 300 || res.status >= 400) break
      const location = res.headers.get('location')
      if (!location) return UNREACHABLE
      url = parsePublicHttpUrl(new URL(location, url).href)
      res = undefined
    }
    if (!res?.ok) return UNREACHABLE
    if (res.headers.get('cf-mitigated')?.toLowerCase() === 'challenge') return UNREACHABLE
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType && !/text\/css|text\/plain|application\/octet-stream/i.test(contentType)) return UNREACHABLE
    const bounded = await readTextBounded(res, budget)
    if (bounded === null) return OVERSIZED
    css = bounded
  } catch {
    return UNREACHABLE
  }

  const imports = [...css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s]+)['"]?\s*\)?[^;]*;/g)]
  for (const [index, m] of imports.entries()) {
    if (index >= MAX_CSS_IMPORTS) return UNREACHABLE
    let child: CapturedCss
    try {
      child = await fetchCss(new URL(m[1], url).href, budget - Buffer.byteLength(css), depth + 1)
    } catch {
      child = UNREACHABLE
    }
    if (!child.ok) return child
    /* Inline the import rather than leave it active in the snapshot for a
       later browser to fetch. */
    css = css.replace(m[0], child.css)
    if (Buffer.byteLength(css) > budget) return OVERSIZED
  }
  /* relative url(...) inside the sheet must resolve against the SHEET's URL,
     not the document base */
  css = css.replace(/url\(\s*(['"]?)(?!data:|https?:|\/\/|#)([^'")]+)\1\s*\)/g, (_all, q, p) => {
    try {
      return `url(${q}${new URL(p, url).href}${q})`
    } catch {
      return _all
    }
  })
  return { ok: true, css }
}

export interface ImportedPage {
  title: string
  width: number
  height: number
  html: string
  /** Optional bounded visual/text result for agent-facing imports. The normal
   *  UI importer omits this so multi-page imports do not retain many images. */
  preview?: {
    screenshot: Buffer
    finalUrl: string
    description: string
    text: string
    textTruncated: boolean
    shotCropped: boolean
    pageHeight: number
  }
}

const IMPORT_SOURCE_META = 'doop-import-source'

/** Identify snapshots created from a particular requested URL. The value is
 *  encoded so an arbitrary query string cannot break the HTML attribute. */
export function importedPageSource(html: string): string | undefined {
  const encoded = html.match(
    new RegExp(`<meta\\s+name=["']${IMPORT_SOURCE_META}["']\\s+content=["']([^"']+)["']`, 'i'),
  )?.[1]
  if (!encoded) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

export async function importPage(rawUrl: string, options: { includePreview?: boolean } = {}): Promise<ImportedPage> {
  const requestedUrl = normalizeImportUrl(rawUrl)
  let contextCapture: ContextWebsiteHtml | undefined
  if (contextDevConfigured()) contextCapture = await scrapeContextWebsiteHtml(requestedUrl.href)
  else await assertPublicNetworkUrl(requestedUrl)
  const isolated = await openIsolatedPage()
  const { page } = isolated
  try {
    await guardPublicPageRequests(page)
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 900 })
    await page.setUserAgent(UA)
    if (contextCapture) {
      /* Context already ran the site's JavaScript. Do not execute scripts a
         second time when laying out its returned DOM for the editable frame. */
      await page.setJavaScriptEnabled(false)
      try {
        await page.setContent(prepareContextHtmlForRendering(contextCapture.html, contextCapture.finalUrl), {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        })
      } catch {
        throw new WebsiteCaptureUnavailableError('Context.dev returned HTML that Doop could not render')
      }
    } else {
      await navigateWebsitePage(page, requestedUrl.href, { waitUntil: 'networkidle2', timeout: 30_000 })
      /* redirects can land somewhere private — re-check where Chromium landed */
      await assertPublicNetworkUrl(page.url())
    }
    /* walk the page before capturing: scroll-reveal animations and lazy
       images only materialize once their elements have been in view. Skip it
       for Context.dev captures: scripts are disabled there, which makes
       Chromium load loading="lazy" images eagerly, run no scroll-reveal
       code — and never fire the timers this walk awaits, so the evaluate
       promise would hang until Chromium collects it and the import fails. */
    if (!contextCapture) {
      await page.evaluate(async () => {
        /* the window isn't always the scroller — app-shell pages scroll an
         overflow container. Walk the tallest scrollables too. */
        const scrollables: (Element | null)[] = [document.scrollingElement]
        for (const el of Array.from(document.querySelectorAll('body, body *')).slice(0, 4000)) {
          if (el.scrollHeight > el.clientHeight + 300 && el.clientHeight > 200) {
            const o = getComputedStyle(el).overflowY
            if (o === 'auto' || o === 'scroll') scrollables.push(el)
          }
        }
        const targets = scrollables
          .filter((el): el is Element => !!el)
          .sort((a, b) => b.scrollHeight - a.scrollHeight)
          .slice(0, 3)
        for (const el of targets) {
          let y = 0
          for (let i = 0; i < 40; i++) {
            y += 700
            el.scrollTop = y
            window.scrollTo(0, y)
            await new Promise((r) => setTimeout(r, 120))
            if (y >= el.scrollHeight) break
          }
          el.scrollTop = 0
        }
        window.scrollTo(0, 0)
        await new Promise((r) => setTimeout(r, 400))
      })
      await new Promise((r) => setTimeout(r, 600)) // late layout/lazy paint
    }

    const snap = await page.evaluate((maxHeight: number) => {
      for (const el of document.querySelectorAll(
        'script, noscript, iframe, frame, frameset, object, embed, applet, portal, fencedframe',
      ))
        el.remove()
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[http-equiv]')) meta.remove()

      /* A snapshot is passive HTML. Inline handlers and executable URL
         schemes would otherwise run again inside the canvas iframe. */
      const executableUrlAttributes = new Set(['action', 'formaction', 'href', 'poster', 'src', 'xlink:href'])
      for (const el of document.querySelectorAll('*')) {
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase()
          if (name.startsWith('on') || name === 'srcdoc' || name === 'ping') el.removeAttribute(attr.name)
          else if (executableUrlAttributes.has(name) && /^\s*javascript:/i.test(attr.value)) {
            el.removeAttribute(attr.name)
          }
        }
      }
      const sheets: string[] = []
      for (const l of document.querySelectorAll<HTMLLinkElement>('link')) {
        if (
          l.relList.contains('stylesheet') &&
          l.href &&
          !l.disabled &&
          (!l.media || window.matchMedia(l.media).matches)
        ) {
          sheets.push(l.href)
        }
        l.remove()
      }
      const baseUrl = document.baseURI
      for (const base of document.querySelectorAll('base')) base.remove()
      return {
        baseUrl,
        sheets,
        title: document.title,
        height: Math.min(Math.max(document.documentElement.scrollHeight, 400), maxHeight),
        html: document.documentElement.outerHTML,
      }
    }, MAX_HEIGHT)

    let css = ''
    for (const sheet of snap.sheets) {
      const captured = await fetchCss(sheet, MAX_CSS_BYTES - Buffer.byteLength(css))
      if (!captured.ok) {
        throw new WebsiteCaptureUnavailableError(
          captured.reason === 'oversized' ? CSS_OVERSIZED_MESSAGE : CSS_UNREACHABLE_MESSAGE,
        )
      }
      css += captured.css + '\n'
    }

    /* Scrolling/lazy loading can trigger a delayed navigation. Re-check the
       destination at the last possible moment and base the snapshot on it. */
    const finalUrl = contextCapture ? contextCapture.finalUrl : (await assertPublicNetworkUrl(page.url())).href
    let documentBase = finalUrl
    try {
      if (typeof snap.baseUrl === 'string') documentBase = parsePublicHttpUrl(snap.baseUrl).href
    } catch {
      /* Unsafe or malformed bases fall back to the already validated page URL. */
    }

    /* self-contained document: a base tag so in-document relative URLs
       (images, srcset) keep resolving, plus every stylesheet inlined */
    const inject =
      `<meta name="${IMPORT_SOURCE_META}" content="${encodeURIComponent(requestedUrl.href)}">` +
      `<meta http-equiv="Content-Security-Policy" content="${IMPORT_CSP}">` +
      `<base href="${documentBase.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">` +
      (css.trim() ? `<style data-doop-import>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>` : '')
    let html = snap.html
    const headMatch = html.match(/<head[^>]*>/i)
    if (headMatch) html = html.replace(headMatch[0], headMatch[0] + inject)
    else html = inject + html
    html = '<!doctype html>\n' + html

    if (html.length > MAX_DOCUMENT_BYTES) {
      throw new WebsiteCaptureUnavailableError('The captured webpage is too large to import safely')
    }

    let preview: ImportedPage['preview']
    let renderedHeight = snap.height
    if (options.includePreview) {
      const previewIsolated = await openIsolatedPage()
      const previewPage = previewIsolated.page
      try {
        /* Preview the exact passive artifact that will land on the canvas. This
           avoids a second Context.dev screenshot request and keeps view_website
           visually aligned with import_webpage. */
        await guardPublicPageRequests(previewPage)
        await previewPage.setViewport({ width: VIEWPORT_WIDTH, height: 900 })
        await previewPage.setUserAgent(UA)
        await previewPage.setJavaScriptEnabled(false)
        try {
          await previewPage.setContent(html, { waitUntil: 'load', timeout: 8_000 })
        } catch {
          /* Slow external images/fonts should not discard an otherwise usable
             snapshot; capture whatever the isolated renderer completed. */
        }
        await new Promise((resolve) => setTimeout(resolve, 120))
        const info = await previewPage.evaluate(() => {
          const description = document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? ''
          const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim()
          const visualElements = Array.from(
            document.querySelectorAll<HTMLElement | SVGElement>('img, video, svg, input, select'),
          )
          const hasVisualContent = visualElements.some((element) => {
            const rect = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            const visible =
              rect.width >= 2 &&
              rect.height >= 2 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0'
            if (!visible) return false
            if (element instanceof HTMLImageElement) return element.complete && element.naturalWidth > 0
            if (element instanceof HTMLVideoElement) return element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            if (element instanceof SVGElement) return element.childElementCount > 0
            return element instanceof HTMLInputElement || element instanceof HTMLSelectElement
          })
          return { description, text, hasVisualContent, pageHeight: document.documentElement.scrollHeight }
        })
        if (!info.text && !info.hasVisualContent) {
          throw new WebsiteCaptureUnavailableError('The acquired webpage rendered empty')
        }
        renderedHeight = Math.min(Math.max(info.pageHeight, 400), MAX_HEIGHT)
        const shotHeight = Math.min(Math.max(info.pageHeight, 400), MAX_PREVIEW_HEIGHT)
        const screenshot = (await previewPage.screenshot({
          type: 'jpeg',
          quality: 80,
          clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height: shotHeight },
        })) as Buffer
        preview = {
          screenshot,
          finalUrl,
          description: info.description || contextCapture?.description || '',
          text: info.text.slice(0, MAX_PREVIEW_TEXT_CHARS),
          textTruncated: info.text.length > MAX_PREVIEW_TEXT_CHARS,
          shotCropped: info.pageHeight > MAX_PREVIEW_HEIGHT,
          pageHeight: info.pageHeight,
        }
      } catch (error) {
        if (error instanceof WebsiteCaptureUnavailableError) throw error
        throw new WebsiteCaptureUnavailableError('Doop could not render a local preview of the webpage')
      } finally {
        await previewIsolated.close()
      }
    }

    return {
      title: snap.title || contextCapture?.title || new URL(finalUrl).hostname,
      width: VIEWPORT_WIDTH,
      height: Math.round(renderedHeight),
      html,
      ...(preview ? { preview } : {}),
    }
  } catch (error) {
    if (error instanceof WebsiteCaptureUnavailableError) throw error
    throw new WebsiteCaptureUnavailableError('Doop could not finish rendering the webpage HTML')
  } finally {
    await isolated.close()
  }
}
