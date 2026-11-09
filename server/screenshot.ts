import { env, windowsBrowserDirectories } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import { guardPublicPageRequests } from './publicUrl.ts'
import { renderedHeight } from './renderLimits.ts'
import {
  createRenderer,
  remoteConnectFailure,
  withDeadline,
  type PageOptions,
  type RenderPage,
  type RendererStatus,
} from './renderBrowser.ts'

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

/** Whether the server has a browser to render with: a remote one
 *  (REMOTE_BROWSER_URL) or a local executable. */
export function rendererAvailable(): boolean {
  return !!env.REMOTE_BROWSER_URL || findBrowserPath() !== null
}

function findBrowser(): string {
  const path = findBrowserPath()
  if (!path) throw new Error('No Chrome/Chromium found. Set CHROME_PATH to a browser executable.')
  return path
}

/** A fresh headless Chrome with the server's flags. `timeout` bounds the wait
 *  for its DevTools endpoint (puppeteer's default, 30s, unless given);
 *  `protocolTimeout` bounds every DevTools command (puppeteer's 180s unless
 *  given). */
export function launchBrowser(timeout?: number, protocolTimeout?: number): Promise<Browser> {
  return puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    timeout,
    protocolTimeout,
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

/* a stuck DevTools command fails in a minute rather than puppeteer's three,
   so the renderer's health probe gets to judge the browser sooner */
const PROTOCOL_TIMEOUT_MS = 60_000

/** One render attempt, page open to encoded bytes. */
const RENDER_TIMEOUT_MS = 45_000

/* a remote session is billed while it is open: close it this long after its
   last page, well inside the provider's own idle timeout (Cloudflare: 60s) */
const REMOTE_IDLE_CLOSE_MS = 30_000
const REMOTE_CONNECT_TIMEOUT_MS = 30_000
/* closing a heavy page's context is a round trip that waits on the page's
   teardown: a remote one took over 5s after a full website import */
const REMOTE_CLOSE_TIMEOUT_MS = 15_000

/** A Chrome somewhere else, over the DevTools protocol (REMOTE_BROWSER_URL).
 *  Everything past the connect is the same puppeteer API a local one has. */
export function connectRemoteBrowser(url: string, token: string | undefined): Promise<Browser> {
  const connecting = puppeteer.connect({
    browserWSEndpoint: url,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
  })
  return withDeadline(connecting, REMOTE_CONNECT_TIMEOUT_MS, 'connecting to the remote browser').catch(
    (error: unknown) => {
      /* a session that opens after its deadline is still billed: close it */
      connecting.then(
        (late) => void late.close().catch(() => {}),
        () => {},
      )
      throw remoteConnectFailure(error)
    },
  )
}

const remoteBrowserUrl = env.REMOTE_BROWSER_URL

const renderer = createRenderer({
  launch: () =>
    remoteBrowserUrl
      ? connectRemoteBrowser(remoteBrowserUrl, env.REMOTE_BROWSER_TOKEN)
      : launchBrowser(undefined, PROTOCOL_TIMEOUT_MS),
  tuning: {
    maxConcurrent: Math.max(1, env.RENDER_CONCURRENCY),
    ...(remoteBrowserUrl ? { idleCloseMs: REMOTE_IDLE_CLOSE_MS, closeTimeoutMs: REMOTE_CLOSE_TIMEOUT_MS } : {}),
  },
})

/** The live shared browser, launched if need be. */
export function getBrowser(): Promise<Browser> {
  return renderer.browser()
}

/** Counters for logs and health checks. */
export function rendererStatus(): RendererStatus {
  return renderer.status()
}

export type IsolatedPage = Pick<RenderPage, 'page' | 'close'>

/** External pages never share cookies, cache or service workers across users
 *  or imports. Closing the wrapper tears down the entire browser context and
 *  returns the page's render slot; a page that is never closed is closed for
 *  its caller when its lease runs out (see renderBrowser.ts). */
export function openIsolatedPage(options?: PageOptions): Promise<IsolatedPage> {
  return renderer.openPage(options)
}

export async function loadFramePage(frame: Frame, options?: PageOptions): Promise<IsolatedPage> {
  const loaded = await openIsolatedPage(options)
  try {
    await loadFrameInto(loaded.page, frame)
    return loaded
  } catch (error) {
    await loaded.close()
    throw error
  }
}

async function loadFrameInto(page: Page, frame: Frame): Promise<void> {
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
  return renderer.withPage('inspecting the frame', RENDER_TIMEOUT_MS, (page) => inspectOn(page, frame))
}

async function inspectOn(page: Page, frame: Frame): Promise<FrameInspection> {
  await loadFrameInto(page, frame)
  {
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
  }
}

export interface RenderOptions extends PageOptions {
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
  return renderer.withPage(
    'rendering the frame',
    RENDER_TIMEOUT_MS,
    async (page) => {
      await loadFrameInto(page, frame)
      return screenshotOn(page, frame, scale, opts)
    },
    { priority: opts.priority },
  )
}

async function screenshotOn(page: Page, frame: Frame, scale: number, opts: RenderOptions): Promise<Buffer> {
  const width = Math.max(1, Math.round(frame.width))
  const fullHeight = Math.max(1, Math.round(frame.height))
  const height = renderedHeight(frame, scale, opts.maxHeight)
  /* the viewport always spans the whole frame, so 100vh, height media
     queries and bottom-fixed elements lay out as they do on the canvas; the
     pixel budget bounds only the captured image below */
  await page.setViewport({ width, height: fullHeight, deviceScaleFactor: scale })
  const type = opts.type ?? 'png'
  const clip = height < fullHeight ? { x: 0, y: 0, width, height } : undefined
  const buf = await page.screenshot({
    type,
    ...(type === 'jpeg' ? { quality: opts.quality ?? 90 } : {}),
    ...(clip ? { clip } : {}),
  })
  return Buffer.from(buf)
}
