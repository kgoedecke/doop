import { env, windowsBrowserDirectories } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import { guardPublicPageRequests } from './publicUrl.ts'

/**
 * Render a frame's HTML in headless Chrome so agents can *see* their work.
 * Uses the system browser via puppeteer-core — no bundled download.
 */

const windowsDirectories = process.platform === 'win32' ? windowsBrowserDirectories() : []

const CHROME_PATHS = [
  env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  ...windowsDirectories.map((dir) => path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ...windowsDirectories.map((dir) => path.join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ...windowsDirectories.map((dir) => path.join(dir, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
].filter((p): p is string => !!p)

/** The first usable local browser executable, or null when there is none. */
export function findBrowserPath(): string | null {
  for (const p of CHROME_PATHS) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* keep looking */
    }
  }
  return null
}

function findBrowser(): string {
  const path = findBrowserPath()
  if (!path) throw new Error('No Chrome/Chromium found. Set CHROME_PATH to a browser executable.')
  return path
}

let browserPromise: Promise<Browser> | null = null

/** Bounds every step a wedged Chromium can stall on. Exported so tests can
 *  shorten them; production keeps these values. */
export const renderTuning = {
  /** one render attempt, page creation to encoded bytes */
  renderTimeoutMs: 20_000,
  /** the liveness probe a reused browser must answer before it is handed out */
  pingTimeoutMs: 2_000,
  /** tearing down a browser context */
  closeTimeoutMs: 5_000,
}

export class RenderTimeoutError extends Error {
  constructor(step: string, ms: number) {
    super(`${step} did not finish within ${ms}ms`)
    this.name = 'RenderTimeoutError'
  }
}

function withDeadline<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RenderTimeoutError(step, ms)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** The hosted server's one long-lived Chromium has been seen to stop creating
 *  pages while its DevTools socket stays open: `connected` says yes, every
 *  `newPage` waits 30s for a target that never comes. Such a browser is
 *  dropped from the cache and killed, so the next caller launches a fresh one. */
function discardBrowser(browser: Browser): void {
  if (browserPromise) {
    const cached = browserPromise
    cached.then(
      (b) => {
        if (b === browser && browserPromise === cached) browserPromise = null
      },
      () => {},
    )
  }
  const child = browser.process()
  browser
    .close()
    .catch(() => {})
    .finally(() => {
      if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL')
    })
}

/** Did the failure come from the browser rather than the frame? A stall, a
 *  closed target or a broken DevTools session all mean the browser is gone
 *  for good; a fresh one may well succeed. */
export function isBrowserFailure(error: unknown): boolean {
  if (error instanceof RenderTimeoutError) return true
  if (!(error instanceof Error)) return false
  return (
    error.name === 'TargetCloseError' ||
    error.name === 'ProtocolError' ||
    /Target closed|Session closed|Protocol error|Connection closed|waiting for target|Browser was disconnected|Navigating frame was detached/i.test(
      error.message,
    )
  )
}

async function pingBrowser(browser: Browser): Promise<boolean> {
  if (!browser.connected) return false
  try {
    await withDeadline(browser.version(), renderTuning.pingTimeoutMs, 'browser liveness check')
    return true
  } catch {
    return false
  }
}

export async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise
    if (await pingBrowser(b)) return b
    discardBrowser(b)
    browserPromise = null
  }
  const launching = launchBrowser()
  browserPromise = launching
  /* a launch that failed (a slow cold start past puppeteer's timeout) must not
     be handed to every later caller: the next one tries again */
  launching.catch(() => {
    if (browserPromise === launching) browserPromise = null
  })
  return launching
}

/** Run a render against the shared browser, under the render deadline. When
 *  the attempt fails for a reason that points at the browser, that browser is
 *  discarded and the work runs once more on a fresh launch. */
export async function withBrowserRetry<T>(step: string, work: (browser: Browser) => Promise<T>): Promise<T> {
  const attempt = async () => {
    const browser = await getBrowser()
    try {
      return await withDeadline(work(browser), renderTuning.renderTimeoutMs, step)
    } catch (error) {
      if (isBrowserFailure(error)) discardBrowser(browser)
      throw error
    }
  }
  try {
    return await attempt()
  } catch (error) {
    if (!isBrowserFailure(error)) throw error
    console.warn(`${step}: browser failed (${error instanceof Error ? error.message : String(error)}), relaunching`)
    return attempt()
  }
}

/** A fresh headless Chrome with the server's flags. `timeout` bounds the wait
 *  for its DevTools endpoint (puppeteer's default, 30s, unless given). */
export function launchBrowser(timeout?: number): Promise<Browser> {
  return puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    timeout,
    args: [
      '--no-first-run',
      '--disable-extensions',
      '--disable-quic',
      '--disable-webrtc-multiple-routes',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--hide-scrollbars',
      /* containers: no user namespaces for the sandbox, tiny /dev/shm */
      ...(env.CHROME_NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  })
}

export interface IsolatedPage {
  page: Page
  close: () => Promise<void>
}

/** External pages never share cookies, cache or service workers across users
 *  or imports. Closing the wrapper tears down the entire browser context. */
export async function openIsolatedPage(browser?: Browser): Promise<IsolatedPage> {
  const b = browser ?? (await getBrowser())
  const context = await b.createBrowserContext()
  try {
    const page = await context.newPage()
    let closed = false
    return {
      page,
      close: async () => {
        if (closed) return
        closed = true
        /* a wedged browser stalls here too; the deadline keeps the caller's
           finally from hanging on the teardown */
        await withDeadline(context.close(), renderTuning.closeTimeoutMs, 'closing the page').catch(() => {})
      },
    }
  } catch (error) {
    await context.close().catch(() => {})
    throw error
  }
}

export async function loadFramePage(frame: Frame, browser?: Browser): Promise<IsolatedPage> {
  const loaded = await openIsolatedPage(browser)
  const { page } = loaded
  try {
    const assetOrigin = new URL(env.BETTER_AUTH_URL).origin
    await guardPublicPageRequests(page, {
      allowUrl: (url) =>
        (url.origin === assetOrigin && url.pathname.startsWith('/a/')) ||
        /* webfonts referenced by imported frames (imports request the
           source design's families from Google Fonts) */
        url.origin === 'https://fonts.googleapis.com' ||
        url.origin === 'https://fonts.gstatic.com',
    })
    await page.setViewport({
      width: Math.max(1, Math.round(frame.width)),
      /* A viewport does not need to span an entire imported landing page for
         layout/computed-style inspection; full-page content remains in the DOM. */
      height: Math.max(1, Math.min(Math.round(frame.height), 4000)),
      deviceScaleFactor: 1,
    })
    /* setContent leaves the page on about:blank, where the relative /a/...
       asset URLs of imported frames resolve nowhere. In the app an iframe
       inherits the page origin; here a <base> stands in for it — unless the
       frame brought its own (website imports do). */
    let html = frame.html || '<!doctype html><html><body></body></html>'
    if (!/<base\s/i.test(html)) {
      const baseTag = `<base href="${assetOrigin.replace(/"/g, '&quot;')}/">`
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`) : baseTag + html
    }
    try {
      await page.setContent(html, {
        waitUntil: 'load',
        timeout: 8000,
      })
    } catch {
      /* Slow external resources: inspect whatever has rendered. */
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    return loaded
  } catch (error) {
    await loaded.close()
    throw error
  }
}

export interface FrameInspection {
  document: { title: string; width: number; height: number; htmlChars: number }
  design: {
    colors: string[]
    backgrounds: string[]
    fonts: string[]
    fontSizes: string[]
    radii: string[]
    shadows: string[]
    cssVariables: Record<string, string>
  }
  elements: Array<{
    selector: string
    tag: string
    role?: string
    text?: string
    rect: { x: number; y: number; width: number; height: number }
    style: { color: string; background: string; font: string; fontSize: string; fontWeight: string }
  }>
}

/** A compact, rendered representation for agents. It intentionally relies on
 * visible text, semantics, geometry and computed styles rather than classes. */
export function inspectFrame(frame: Frame): Promise<FrameInspection> {
  return withBrowserRetry('inspecting the frame', (browser) => inspectFrameOnce(frame, browser))
}

async function inspectFrameOnce(frame: Frame, browser: Browser): Promise<FrameInspection> {
  const loaded = await loadFramePage(frame, browser)
  const { page } = loaded
  try {
    /* tsx/esbuild annotates nested functions with __name; page.evaluate
       serializes the callback without that runtime helper. A tiny in-page
       identity shim keeps the evaluated code independent of the loader. */
    await page.evaluate('globalThis.__name = (target) => target')
    const inspection = await page.evaluate(() => {
      const MAX_ELEMENTS = 64
      const MAX_STYLE_SAMPLES = 500
      const semanticTags = new Set([
        'header',
        'nav',
        'main',
        'section',
        'article',
        'aside',
        'footer',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'p',
        'a',
        'button',
        'input',
        'textarea',
        'select',
        'form',
        'img',
        'ul',
        'ol',
        'table',
      ])

      function visible(el: Element): el is HTMLElement {
        if (!(el instanceof HTMLElement)) return false
        const style = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          rect.width > 1 &&
          rect.height > 1
        )
      }

      function selectorFor(el: Element): string {
        const doopId = el.getAttribute('data-doop-id')
        if (doopId) return `[data-doop-id="${doopId}"]`
        if (el.id && el.id.length < 80) return `#${CSS.escape(el.id)}`
        const parts: string[] = []
        let node: Element | null = el
        while (node && node !== document.body && parts.length < 7) {
          const tag = node.tagName.toLowerCase()
          const parent: Element | null = node.parentElement
          if (!parent) {
            parts.unshift(tag)
            break
          }
          const sameTag = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName)
          const suffix = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(node) + 1})` : ''
          parts.unshift(tag + suffix)
          node = parent
        }
        return `body > ${parts.join(' > ')}`
      }

      function cleanText(value: string | null | undefined, max = 180): string | undefined {
        const text = (value || '').replace(/\s+/g, ' ').trim()
        if (!text) return undefined
        return text.length > max ? `${text.slice(0, max - 1)}…` : text
      }

      function normalizedColor(value: string): string | undefined {
        if (!value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent') return undefined
        return value
      }

      const counts = {
        colors: new Map<string, number>(),
        backgrounds: new Map<string, number>(),
        fonts: new Map<string, number>(),
        fontSizes: new Map<string, number>(),
        radii: new Map<string, number>(),
        shadows: new Map<string, number>(),
      }
      const bump = (map: Map<string, number>, value?: string) => {
        if (value) map.set(value, (map.get(value) || 0) + 1)
      }

      const all = Array.from(document.body.querySelectorAll('*')).filter(visible)
      for (const el of all.slice(0, MAX_STYLE_SAMPLES)) {
        const style = getComputedStyle(el)
        bump(counts.colors, normalizedColor(style.color))
        bump(counts.backgrounds, normalizedColor(style.backgroundColor))
        bump(counts.fonts, style.fontFamily)
        bump(counts.fontSizes, style.fontSize)
        if (style.borderRadius !== '0px') bump(counts.radii, style.borderRadius)
        if (style.boxShadow !== 'none') bump(counts.shadows, style.boxShadow)
      }

      const semantic = all
        .filter((el) => semanticTags.has(el.tagName.toLowerCase()) || !!el.getAttribute('role'))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const candidates: HTMLElement[] = []
      const selected = new Set<HTMLElement>()
      const take = (limit: number, predicate: (el: HTMLElement) => boolean) => {
        for (const el of semantic) {
          if (candidates.length >= MAX_ELEMENTS || limit <= 0) break
          if (selected.has(el) || !predicate(el)) continue
          selected.add(el)
          candidates.push(el)
          limit--
        }
      }
      take(18, (el) =>
        ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'].includes(el.tagName.toLowerCase()),
      )
      take(16, (el) => /^h[1-6]$/.test(el.tagName.toLowerCase()))
      take(
        16,
        (el) =>
          ['button', 'a', 'input', 'textarea', 'select', 'form'].includes(el.tagName.toLowerCase()) ||
          !!el.getAttribute('role'),
      )
      take(14, (el) => ['p', 'img', 'ul', 'ol', 'table'].includes(el.tagName.toLowerCase()))
      take(MAX_ELEMENTS - candidates.length, () => true)

      const elements = candidates.map((el) => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const image = el instanceof HTMLImageElement ? cleanText(el.alt || el.getAttribute('aria-label')) : undefined
        return {
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          text: image || cleanText(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder')),
          rect: {
            x: Math.round(rect.left + scrollX),
            y: Math.round(rect.top + scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          style: {
            color: style.color,
            background: style.backgroundColor,
            font: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
          },
        }
      })

      const top = (map: Map<string, number>, limit: number) =>
        [...map.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([value]) => value)
      const rootStyle = getComputedStyle(document.documentElement)
      const cssVariables: Record<string, string> = {}
      for (const name of Array.from(rootStyle)) {
        if (!name.startsWith('--') || Object.keys(cssVariables).length >= 40) continue
        const value = rootStyle.getPropertyValue(name).trim()
        if (value && value.length <= 160) cssVariables[name] = value
      }

      return {
        title: document.title,
        design: {
          colors: top(counts.colors, 10),
          backgrounds: top(counts.backgrounds, 10),
          fonts: top(counts.fonts, 8),
          fontSizes: top(counts.fontSizes, 10),
          radii: top(counts.radii, 8),
          shadows: top(counts.shadows, 6),
          cssVariables,
        },
        elements,
      }
    })

    return {
      document: {
        title: inspection.title,
        width: Math.round(frame.width),
        height: Math.round(frame.height),
        htmlChars: frame.html.length,
      },
      design: inspection.design,
      elements: inspection.elements,
    }
  } finally {
    await loaded.close()
  }
}

export interface RenderOptions {
  type?: 'png' | 'jpeg'
  quality?: number
  maxHeight?: number
}

export function renderFrame(
  frame: Frame,
  /* output pixel density — fractional values downscale huge frames */
  scale: number = 1,
  opts: RenderOptions = {},
): Promise<Buffer> {
  return withBrowserRetry('rendering the frame', (browser) => renderFrameOnce(frame, scale, opts, browser))
}

async function renderFrameOnce(frame: Frame, scale: number, opts: RenderOptions, browser: Browser): Promise<Buffer> {
  const loaded = await loadFramePage(frame, browser)
  const { page } = loaded
  try {
    await page.setViewport({
      width: Math.max(1, Math.round(frame.width)),
      height: Math.max(1, Math.round(frame.height)),
      deviceScaleFactor: scale,
    })
    const type = opts.type ?? 'png'
    const clip =
      opts.maxHeight && frame.height > opts.maxHeight
        ? { x: 0, y: 0, width: Math.round(frame.width), height: Math.round(opts.maxHeight) }
        : undefined
    const buf = await page.screenshot({
      type,
      ...(type === 'jpeg' ? { quality: opts.quality ?? 90 } : {}),
      ...(clip ? { clip } : {}),
    })
    return Buffer.from(buf)
  } finally {
    await loaded.close()
  }
}
