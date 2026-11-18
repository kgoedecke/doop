import { env, windowsBrowserDirectories } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import { guardPublicPageRequests } from './publicUrl.ts'
import { withHostedIcons } from './iconProxy.ts'
import { withHostedPhotos } from './photoProxy.ts'
import { renderedHeight } from './renderLimits.ts'
import { LayerNotFoundError } from './layerExport.ts'
import { installNameShim } from './pageShim.ts'
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

/** A viewport of the frame's design px, whole and at least 1 each way. */
function frameViewport(width: number, height: number, deviceScaleFactor = 1) {
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), deviceScaleFactor }
}

async function loadFrameInto(page: Page, frame: Frame): Promise<void> {
  const assetOrigin = new URL(env.BETTER_AUTH_URL).origin
  await guardPublicPageRequests(page, {
    allowUrl: (url) =>
      (url.origin === assetOrigin && /^\/(?:a|icons|photos)\//.test(url.pathname)) ||
      /* webfonts referenced by imported frames (imports request the
         source design's families from Google Fonts) */
      url.origin === 'https://fonts.googleapis.com' ||
      url.origin === 'https://fonts.gstatic.com',
  })
  /* A viewport does not need to span an entire imported landing page for
     layout/computed-style inspection; full-page content remains in the DOM. */
  await page.setViewport(frameViewport(frame.width, Math.min(frame.height, 4000)))
  /* setContent leaves the page on about:blank, where the relative /a/...
     asset URLs of imported frames resolve nowhere. In the app an iframe
     inherits the page origin; here a <base> stands in for it — unless the
     frame brought its own (website imports do). */
  let html = withHostedPhotos(withHostedIcons(frame.html || '<!doctype html><html><body></body></html>'))
  /* the editor morphs every design into a standards-mode document (FRAME_BOOTSTRAP in
     src/lib/frameRuntime.ts), so a design without a doctype renders the same way here */
  if (!/^\s*<!doctype/i.test(html)) html = `<!doctype html>${html}`
  if (!/<base\s/i.test(html)) {
    const baseTag = `<base href="${assetOrigin.replace(/"/g, '&quot;')}/">`
    /* never ahead of the doctype, which would put the page in quirks mode */
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
      : /<html[^>]*>/i.test(html)
        ? html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`)
        : html.replace(/^\s*<!doctype[^>]*>/i, (doctype) => doctype + baseTag)
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
    await installNameShim(page)
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

/** A frame's content height in design px, at the frame's width: `painted`
 *  is the lowest thing it paints, `flow` the bottom of the root's own box (what
 *  flows, overflow left out). */
export interface ContentHeight {
  painted: number
  flow: number
}

/** Measures the frame with the viewport `viewportHeight` tall. A design sized
 *  in vh changes with the viewport, so `settle` may measure at several heights
 *  on one loaded page (server/frameFit.ts). */
export type ContentMeasure = (viewportHeight: number) => Promise<ContentHeight>

/** Loads the frame once and hands `settle` a measure on it. */
export function measureContentHeight<T>(frame: Frame, settle: (measure: ContentMeasure) => Promise<T>): Promise<T> {
  return renderer.withPage('measuring the frame', RENDER_TIMEOUT_MS, async (page) => {
    await loadFrameInto(page, frame)
    await installNameShim(page)
    return settle(async (viewportHeight) => {
      await page.setViewport(frameViewport(frame.width, viewportHeight))
      return page.evaluate(contentBottom)
    })
  })
}

/** Runs in the frame's page. The document's height with the root and body
 *  let go of any viewport size (a body at 100vh or 100% would hold the frame
 *  at its current height), taken as the lowest thing it paints: the root's own
 *  box covers what flows, a walk adds what is positioned or overflows its box,
 *  text running past its element included. Left out: what a scroller or clipper hides, what is
 *  invisible (a closed menu at visibility:hidden or opacity:0), and fixed
 *  elements, which sit on the viewport rather than the content. */
async function contentBottom(): Promise<ContentHeight> {
  const MAX_ELEMENTS = 20_000
  await document.fonts.ready
  /* mid-animation boxes (an entrance sliding up) measure where they will not stay */
  for (const animation of document.getAnimations()) {
    try {
      animation.finish()
    } catch {
      animation.cancel()
    }
  }
  if (!document.querySelector('style[data-doop-fit]')) {
    const release = document.createElement('style')
    release.setAttribute('data-doop-fit', '')
    release.textContent = 'html,body{height:auto!important;min-height:0!important;max-height:none!important}'
    document.head.append(release)
  }
  const flow = document.documentElement.getBoundingClientRect().bottom
  let bottom = flow
  const text = document.createRange()
  let seen = 0
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (++seen > MAX_ELEMENTS) return
      const style = getComputedStyle(child)
      if (style.display === 'none' || style.position === 'fixed' || style.opacity === '0') continue
      /* overflow-x hidden, auto or scroll compute overflow-y to auto; only clip leaves it visible */
      const clips = style.overflowY !== 'visible'
      /* a hidden box takes no paint, though a child of it may opt back in with visibility:visible */
      if (style.visibility !== 'hidden') {
        const rect = child.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) bottom = Math.max(bottom, rect.bottom)
        /* its own text, which may run past its box; elements inside are walked themselves */
        if (!clips)
          for (const node of Array.from(child.childNodes)) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
            text.selectNodeContents(node)
            bottom = Math.max(bottom, text.getBoundingClientRect().bottom)
          }
      }
      if (!clips) walk(child)
    }
  }
  walk(document.body)
  return { painted: Math.ceil(bottom + window.scrollY), flow: Math.ceil(flow + window.scrollY) }
}

export interface RenderOptions extends PageOptions {
  type?: 'png' | 'jpeg'
  quality?: number
  maxHeight?: number
  /** cut the render to the box of the first element this CSS selector
   *  matches (a layer export); rejects with LayerNotFoundError when nothing
   *  visible matches */
  layer?: string
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

interface Clip {
  x: number
  y: number
  width: number
  height: number
}

/** The layer's rendered box in design px, whole pixels outward, within
 *  the frame: what the canvas shows of it, since a frame clips what
 *  overflows it. The pixel budget bounds the crop itself, not the frame,
 *  so a layer low on a huge frame still renders. */
async function layerClip(page: Page, selector: string, frame: Frame, scale: number): Promise<Clip> {
  const box = await page.evaluate((sel: string) => {
    let el: Element | null
    try {
      el = document.querySelector(sel)
    } catch {
      return 'invalid' as const
    }
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      right: r.right + window.scrollX,
      bottom: r.bottom + window.scrollY,
    }
  }, selector)
  if (box === 'invalid') throw new LayerNotFoundError(`"${selector}" is not a valid CSS selector`)
  if (!box) throw new LayerNotFoundError(`no element matches ${selector}`)
  const width = Math.max(1, Math.round(frame.width))
  const height = Math.max(1, Math.round(frame.height))
  /* judged before rounding outward, which would give an empty box a pixel */
  const visible =
    Math.min(width, box.right) - Math.max(0, box.left) > 0 && Math.min(height, box.bottom) - Math.max(0, box.top) > 0
  if (!visible) throw new LayerNotFoundError(`${selector} has no visible size inside the frame`)
  const x = Math.max(0, Math.floor(box.left))
  const y = Math.max(0, Math.floor(box.top))
  const clipWidth = Math.min(width, Math.ceil(box.right)) - x
  const budget = renderedHeight({ width: clipWidth, height }, scale)
  return { x, y, width: clipWidth, height: Math.min(Math.ceil(box.bottom), height, y + budget) - y }
}

async function screenshotOn(page: Page, frame: Frame, scale: number, opts: RenderOptions): Promise<Buffer> {
  const width = Math.max(1, Math.round(frame.width))
  const fullHeight = Math.max(1, Math.round(frame.height))
  const height = renderedHeight(frame, scale, opts.maxHeight)
  /* the viewport always spans the whole frame, so 100vh, height media
     queries and bottom-fixed elements lay out as they do on the canvas; the
     pixel budget bounds only the captured image below */
  await page.setViewport(frameViewport(width, fullHeight, scale))
  const type = opts.type ?? 'png'
  const clip = opts.layer
    ? await layerClip(page, opts.layer, frame, scale)
    : height < fullHeight
      ? { x: 0, y: 0, width, height }
      : undefined
  const buf = await page.screenshot({
    type,
    ...(type === 'jpeg' ? { quality: opts.quality ?? 90 } : {}),
    ...(clip ? { clip } : {}),
  })
  return Buffer.from(buf)
}
