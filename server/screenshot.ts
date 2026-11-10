import { env, windowsBrowserDirectories } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import { guardPublicPageRequests, type PublicRequestSession } from './publicUrl.ts'
import { privatePublicMedia } from './privatePublicMedia.ts'
import {
  assertRenderRead,
  assertPrivateRenderBytes,
  resourceReadError,
  PrivateResourceError,
  type PrivateRenderScope,
} from './privateResources.ts'
import { renderAdmission } from './renderAdmission.ts'
import { materializePrivateResources } from './privateMaterialization.ts'
import { assertRenderPixels, PrivateMaterializationError, PrivateMediaBudget } from '../shared/privateMedia.ts'

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

export async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise
    if (b.connected) return b
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
  ownRequests(session: PublicRequestSession): void
  assertReady(): void
  /** Begin owned cleanup without making a failed caller await uncancellable IO. */
  cancel(): void
  close: () => Promise<void>
}

// Each entry still occupies its original context permit. This is a cleanup
// registry, not replacement capacity; failed closure retains its slot.
const closingContexts = new Set<Promise<void>>()

function contextCloser(
  context: Awaited<ReturnType<Browser['createBrowserContext']>>,
  drain: () => Promise<void> | undefined,
  release: () => void,
) {
  let closing: Promise<void> | undefined
  return () => {
    if (closing) return closing
    closing = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => context.close()),
        Promise.resolve().then(drain),
      ])
      if (results.some((result) => result.status === 'rejected')) throw new PrivateMaterializationError('aborted')
      release()
    })()
    closingContexts.add(closing)
    const owned = closing
    void owned.then(
      () => closingContexts.delete(owned),
      () => {
        console.warn('[render] context cleanup is unconfirmed; capacity retained')
      },
    )
    return owned
  }
}

/** External pages never share cookies, cache or service workers across users
 *  or imports. Closing the wrapper tears down the entire browser context. */
const acquireContext = renderAdmission(4)

export async function openIsolatedPage(scope?: PrivateRenderScope): Promise<IsolatedPage> {
  if (scope) await assertRenderRead(scope)
  const release = await acquireContext()
  let context: Awaited<ReturnType<Browser['createBrowserContext']>> | undefined
  try {
    if (scope) await assertRenderRead(scope)
    const browser = await getBrowser()
    if (scope) await assertRenderRead(scope)
    context = await browser.createBrowserContext()
    const ownedContext = context
    const page = await ownedContext.newPage()
    let requests: PublicRequestSession | undefined
    let closed = false
    const closeContext = contextCloser(ownedContext, () => requests?.cancelAndDrain(), release)
    const close = () => {
      closed = true
      return closeContext()
    }
    return {
      page,
      ownRequests: (session) => {
        if (closed || requests) throw new PrivateMaterializationError('aborted')
        requests = session
      },
      assertReady: () => requests?.assertSettled(),
      cancel: () => {
        void close()
      },
      close,
    }
  } catch (error) {
    if (context) void contextCloser(context, () => undefined, release)()
    else release()
    throw scope ? resourceReadError(error) : error
  }
}

export async function loadFramePage(frame: Frame, scope: PrivateRenderScope): Promise<IsolatedPage> {
  frame = { ...frame }
  assertRenderPixels(frame.width, frame.height)
  await assertRenderRead(scope, frame)
  const loaded = await openIsolatedPage(scope)
  const { page } = loaded
  try {
    const assetOrigin = new URL(env.BETTER_AUTH_URL).origin
    const budget = new PrivateMediaBudget()
    const preparedRequests = new Set<string>()
    const prepared = await materializePrivateResources(
      frame.html || '<!doctype html><html><body></body></html>',
      scope,
      { budget, publicReference: (url) => preparedRequests.add(url) },
    )
    let deniedPrivateRequest = false
    const requests = await guardPublicPageRequests(page, {
      privateResources: privatePublicMedia(scope, budget, preparedRequests),
      rejectUrl: (url) => {
        if (url.origin !== assetOrigin) return false
        let pathname = url.pathname
        try {
          pathname = decodeURIComponent(pathname)
        } catch {
          /* malformed paths remain blocked by the HTTP owner */
        }
        if (!/^\/(?:a|i)(?:\/|$)/.test(pathname)) return false
        deniedPrivateRequest = true
        return true
      },
    })
    loaded.ownRequests(requests)
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
    let html = prepared.html
    if (!/<base\s/i.test(html)) {
      const baseTag = `<base href="${assetOrigin.replace(/"/g, '&quot;')}/">`
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`) : baseTag + html
    }
    const contentStarted = Date.now()
    try {
      await page.setContent(html, {
        waitUntil: 'load',
        timeout: 8000,
      })
    } catch {
      /* Slow external resources: inspect whatever has rendered. */
    }
    const remaining = Math.max(0, 8_000 - (Date.now() - contentStarted))
    let readinessTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([
          requests.settle(),
          page.evaluate(
            async (resources) => {
              await document.fonts.ready
              for (const font of document.fonts) if (font.status === 'error') throw new Error('font unavailable')
              await Promise.all(
                Array.from(document.images)
                  .filter((image) => image.currentSrc || image.src)
                  .map((image) => image.decode()),
              )
              await Promise.all(
                resources.map(async (source) => {
                  if (source.startsWith('data:font/')) {
                    await new FontFace('doop-private-resource-check', `url("${source}")`).load()
                  } else {
                    const image = new Image()
                    image.src = source
                    await image.decode()
                  }
                }),
              )
            },
            prepared.replacements.map((value) => value.inline),
          ),
        ]),
        new Promise<never>((_resolve, reject) => {
          readinessTimer = setTimeout(() => reject(new PrivateMaterializationError('aborted')), remaining)
        }),
      ])
    } catch (error) {
      throw error instanceof PrivateMaterializationError ? error : new PrivateMaterializationError('invalid')
    } finally {
      clearTimeout(readinessTimer)
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    requests.assertSettled()
    if (deniedPrivateRequest) throw new PrivateResourceError()
    await assertRenderRead(scope, frame)
    return loaded
  } catch (error) {
    loaded.cancel()
    throw resourceReadError(error)
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
export async function inspectFrame(frame: Frame, scope: PrivateRenderScope): Promise<FrameInspection> {
  frame = { ...frame }
  let loaded: IsolatedPage | undefined
  try {
    loaded = await loadFramePage(frame, scope)
    const { page } = loaded
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

    loaded.assertReady()
    await loaded.close()
    await assertRenderRead(scope, frame)
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
  } catch (error) {
    loaded?.cancel()
    throw resourceReadError(error)
  }
}

export async function renderFrame(
  frame: Frame,
  scope: PrivateRenderScope,
  /* output pixel density — fractional values downscale huge frames */
  scale: number = 1,
  opts: { type?: 'png' | 'jpeg'; quality?: number; maxHeight?: number } = {},
): Promise<Buffer> {
  frame = { ...frame }
  let loaded: IsolatedPage | undefined
  try {
    assertRenderPixels(frame.width, Math.min(frame.height, opts.maxHeight ?? frame.height), scale)
    loaded = await loadFramePage(frame, scope)
    const { page } = loaded
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
    loaded.assertReady()
    assertPrivateRenderBytes(buf)
    await loaded.close()
    await assertRenderRead(scope, frame)
    return Buffer.from(buf)
  } catch (error) {
    loaded?.cancel()
    throw resourceReadError(error)
  }
}
