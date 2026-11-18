import { env, windowsBrowserDirectories } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { Frame } from '../shared/types.ts'
import { composedHtml, isWholeDocument } from './frameCompose.ts'
import { guardPublicPageRequests } from './publicUrl.ts'
import { withHostedIcons } from './iconProxy.ts'
import { withHostedPhotos } from './photoProxy.ts'
import { designPx, renderedHeight } from './renderLimits.ts'
import { LayerNotFoundError } from './layerExport.ts'
import { installNameShim } from './pageShim.ts'
import { settleFonts } from './renderFonts.ts'
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

/** The document a renderer loads for a frame: its stored HTML is the source, so the
 *  canvas's component stylesheets and token values are composed in here, the one place
 *  every server render, inspection and export passes (server/frameCompose.ts). */
function renderDocument(frame: Frame): string {
  if (!frame.html) return '<!doctype html><html><body></body></html>'
  return isWholeDocument(frame) ? frame.html : composedHtml(frame.canvasId, frame.html)
}

/** A viewport of the frame's design px, whole and at least 1 each way. */
export function frameViewport(width: number, height: number, deviceScaleFactor = 1) {
  return { width: designPx(width), height: designPx(height), deviceScaleFactor }
}

async function loadFrameInto(page: Page, frame: Frame, fitting = false): Promise<void> {
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
  await page.setViewport(frameViewport(frame.width, fitting ? frame.height : Math.min(frame.height, 4000)))
  /* setContent leaves the page on about:blank, where the relative /a/...
     asset URLs of imported frames resolve nowhere. In the app an iframe
     inherits the page origin; here a <base> stands in for it — unless the
     frame brought its own (website imports do). */
  let html = withHostedPhotos(withHostedIcons(renderDocument(frame)))
  /* the editor morphs every design into a standards-mode document (FRAME_BOOTSTRAP in
     src/lib/frameRuntime.ts), so a design without a doctype renders the same way here */
  if (!/^\s*<!doctype/i.test(html)) html = `<!doctype html>${html}`
  if (!/<base\s/i.test(html)) {
    const baseTag = `<base href="${assetOrigin.replace(/"/g, '&quot;')}/">`
    /* never ahead of the doctype, which would put the page in quirks mode */
    /* <head>, never <header> */
    html = /<head(?=[\s>])[^>]*>/i.test(html)
      ? html.replace(/<head(?=[\s>])([^>]*)>/i, `<head$1>${baseTag}`)
      : /<html[^>]*>/i.test(html)
        ? html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`)
        : html.replace(/^\s*<!doctype[^>]*>/i, (doctype) => doctype + baseTag)
  }
  try {
    await page.setContent(html, {
      waitUntil: 'load',
      timeout: 8000,
    })
  } catch (error) {
    if (fitting) throw error
    /* Slow external resources: inspect whatever has rendered. */
  }
  /* `load` does not cover a face from a linked stylesheet (Google Fonts):
     without this a capture intermittently shows the fallback fonts */
  const fonts = await settleFonts(page.mainFrame())
  if (fitting && fonts !== 'loaded') throw new Error('Fonts did not settle while fitting the frame.')
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
    /** the selector asked for that found this element (inspect with `selectors`) */
    matched?: string
    tag: string
    role?: string
    text?: string
    rect: { x: number; y: number; width: number; height: number }
    style: { color: string; background: string; font: string; fontSize: string; fontWeight: string }
  }>
  /** asked-for selectors that matched nothing visible, or are not valid CSS */
  unmatched?: Array<{ selector: string; reason: 'no visible match' | 'invalid selector' }>
  /** layout faults a reviewer would flag, at most MAX_PROBLEMS of them */
  problems: InspectionProblem[]
  problemCount: number
}

export interface InspectionProblem {
  /** off-frame: past the frame's edge, where the canvas cuts it off; clipped: content cut
   *  off by its own box (overflow hidden, an ellipsis); overlap: two pieces of text or
   *  controls on top of each other */
  type: 'off-frame' | 'clipped' | 'overlap'
  selector: string
  /** the other element of an overlap */
  other?: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  detail: string
}

export interface InspectOptions {
  /** CSS selectors to report on instead of the automatic outline (up to 20 matches each) */
  selectors?: string[]
}

/** A compact, rendered representation for agents. It intentionally relies on
 * visible text, semantics, geometry and computed styles rather than classes. */
export function inspectFrame(frame: Frame, options: InspectOptions = {}): Promise<FrameInspection> {
  return renderer.withPage('inspecting the frame', RENDER_TIMEOUT_MS, (page) => inspectOn(page, frame, options))
}

const MAX_PROBLEMS = 30

async function inspectOn(page: Page, frame: Frame, options: InspectOptions): Promise<FrameInspection> {
  await loadFrameInto(page, frame)
  {
    await installNameShim(page)
    const inspection = await page.evaluate(
      ({ asked, frameWidth, frameHeight, maxProblems }) => {
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

        /* with selectors, the elements they find in place of the automatic outline */
        const matchedBy = new Map<HTMLElement, string>()
        const unmatched: Array<{ selector: string; reason: 'no visible match' | 'invalid selector' }> = []
        if (asked.length) {
          candidates.length = 0
          for (const query of asked) {
            let found: HTMLElement[]
            try {
              found = Array.from(document.querySelectorAll(query)).filter(visible).slice(0, 20)
            } catch {
              unmatched.push({ selector: query, reason: 'invalid selector' })
              continue
            }
            if (!found.length) unmatched.push({ selector: query, reason: 'no visible match' })
            for (const el of found) {
              /* each asked-for selector gets its 20, not a share of the outline's limit */
              if (matchedBy.has(el)) continue
              matchedBy.set(el, query)
              candidates.push(el)
            }
          }
        }

        const boxOf = (rect: DOMRect) => ({
          x: Math.round(rect.left + scrollX),
          y: Math.round(rect.top + scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        })

        /* Layout faults. Text and controls are what a reader notices, so overlaps are
         checked between them only: an element with text of its own, an image or a
         control, never one inside the other. */
        const problems: Array<{
          type: 'off-frame' | 'clipped' | 'overlap'
          selector: string
          other?: string
          text?: string
          rect: { x: number; y: number; width: number; height: number }
          detail: string
        }> = []
        let problemCount = 0
        const report = (problem: (typeof problems)[number]) => {
          problemCount++
          if (problems.length < maxProblems) problems.push(problem)
        }
        const ownText = (el: Element) =>
          Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim())

        /* what is left of an element's box once every clipping ancestor has cut it */
        const shownRect = (el: Element): DOMRect => {
          let { left, top, right, bottom } = el.getBoundingClientRect()
          for (let node = el.parentElement; node; node = node.parentElement) {
            const style = getComputedStyle(node)
            if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
            const clip = node.getBoundingClientRect()
            left = Math.max(left, clip.left)
            top = Math.max(top, clip.top)
            right = Math.min(right, clip.right)
            bottom = Math.min(bottom, clip.bottom)
          }
          return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top))
        }
        const leaves = all.filter(
          (el) =>
            ownText(el) ||
            ['img', 'svg', 'button', 'input', 'textarea', 'select', 'video'].includes(el.tagName.toLowerCase()),
        )
        /* Past the left or right edge: each element, since each is its own fix. Past the
           bottom: one line for the lot, since it is one fix (the frame's height or the
           page's length), led by the first element it cuts. */
        let below: { el: HTMLElement; box: ReturnType<typeof boxOf> } | undefined
        let belowCount = 0
        let lowest = 0
        for (const el of leaves) {
          const box = boxOf(shownRect(el))
          if (!box.width || !box.height) continue
          const sides = [
            box.x < -1 && `${-box.x}px past the left edge`,
            box.x + box.width > frameWidth + 1 && `${box.x + box.width - frameWidth}px past the right edge`,
          ].filter(Boolean)
          if (sides.length)
            report({
              type: 'off-frame',
              selector: selectorFor(el),
              text: cleanText(el.innerText, 80),
              rect: box,
              detail: sides.join(', '),
            })
          if (box.y + box.height > frameHeight + 1) {
            belowCount++
            lowest = Math.max(lowest, box.y + box.height)
            if (!below || box.y < below.box.y) below = { el, box }
          }
        }
        if (below)
          report({
            type: 'off-frame',
            selector: selectorFor(below.el),
            text: cleanText(below.el.innerText, 80),
            rect: below.box,
            detail: `content runs ${lowest - frameHeight}px below the frame's ${frameHeight}px height (${belowCount} element${
              belowCount === 1 ? '' : 's'
            }, from this one down): raise the frame's height or shorten the content`,
          })
        /* text its own box cuts off; an image a rounded card crops is meant to be */
        const texts = leaves.filter(ownText)
        for (const el of all) {
          const style = getComputedStyle(el)
          if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
          if (['auto', 'scroll'].includes(style.overflowX) || ['auto', 'scroll'].includes(style.overflowY)) continue
          const bounds = el.getBoundingClientRect()
          const cut = texts.find((text) => {
            if (text !== el && !el.contains(text)) return false
            const rect = text.getBoundingClientRect()
            return (
              rect.right > bounds.right + 1 ||
              rect.bottom > bounds.bottom + 1 ||
              rect.left < bounds.left - 1 ||
              (text === el && (text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1))
            )
          })
          if (!cut) continue
          report({
            type: 'clipped',
            selector: selectorFor(el),
            text: cleanText(cut.innerText, 80),
            rect: boxOf(bounds),
            detail:
              style.textOverflow === 'ellipsis'
                ? 'text cut off with an ellipsis'
                : 'text cut off by the box (overflow)',
          })
        }
        /* each line box of wrapped inline text, not the box around all its lines, which
           covers whatever sits beside the first and last line */
        const sized = leaves.slice(0, 400).map((el) => {
          const shown = shownRect(el)
          const lines = Array.from(el.getClientRects())
            .map((r) => {
              const left = Math.max(r.left, shown.left)
              const top = Math.max(r.top, shown.top)
              const right = Math.min(r.right, shown.right)
              const bottom = Math.min(r.bottom, shown.bottom)
              return new DOMRect(left, top, right - left, bottom - top)
            })
            .filter((r) => r.width > 0 && r.height > 0)
          return { el, shown, lines }
        })
        const overlapOf = (a: DOMRect[], b: DOMRect[]) => {
          for (const x of a)
            for (const y of b) {
              const w = Math.min(x.right, y.right) - Math.max(x.left, y.left)
              const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top)
              /* a few px is a tight line height or a hairline, not an overlap */
              if (w > 4 && h > 4) return { w, h }
            }
          return undefined
        }
        for (let i = 0; i < sized.length; i++) {
          for (let j = i + 1; j < sized.length; j++) {
            const a = sized[i]!
            const b = sized[j]!
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue
            const hit = overlapOf(a.lines, b.lines)
            if (!hit) continue
            report({
              type: 'overlap',
              selector: selectorFor(a.el),
              other: selectorFor(b.el),
              text: cleanText(a.el.innerText, 80),
              rect: boxOf(a.shown),
              detail: `overlaps ${b.el.tagName.toLowerCase()}${
                cleanText(b.el.innerText, 40) ? ` "${cleanText(b.el.innerText, 40)}"` : ''
              } by ${Math.round(hit.w)}×${Math.round(hit.h)}px`,
            })
          }
        }

        const elements = candidates.map((el) => {
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          const image = el instanceof HTMLImageElement ? cleanText(el.alt || el.getAttribute('aria-label')) : undefined
          return {
            selector: selectorFor(el),
            ...(matchedBy.has(el) ? { matched: matchedBy.get(el) } : {}),
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
          unmatched,
          problems,
          problemCount,
        }
      },
      {
        asked: (options.selectors ?? []).slice(0, 20),
        frameWidth: Math.round(frame.width),
        frameHeight: Math.round(frame.height),
        maxProblems: MAX_PROBLEMS,
      },
    )

    return {
      document: {
        title: inspection.title,
        width: Math.round(frame.width),
        height: Math.round(frame.height),
        htmlChars: frame.html.length,
      },
      design: inspection.design,
      elements: inspection.elements,
      ...(inspection.unmatched.length ? { unmatched: inspection.unmatched } : {}),
      problems: inspection.problems,
      problemCount: inspection.problemCount,
    }
  }
}

/** A frame's content in design px: `painted` is the lowest thing it paints, `flow` the bottom of
 *  the root's own box (what flows, overflow left out), `right` the rightmost thing it paints.
 *  `shell` says the design, as loaded, is an app shell: it fits its viewport and a large part of
 *  it scrolls inside. `spills` counts the boxes in flow that run out of their parent's content box
 *  (into its padding or past it): a box held at the viewport's height spills its content once the
 *  viewport is too short for it, where a box that grows with its content never does. */
export interface ContentExtent {
  painted: number
  flow: number
  right: number
  shell: boolean
  spills: number
}

/** Measures on one loaded page, at a viewport of `width` × `height`. A design sized in vh changes
 *  with the viewport, so the fit may measure at several heights (server/frameFit.ts). */
export interface ContentProbe {
  /** the content's height, the root and body let go of a height that follows the viewport */
  height: (width: number, height: number) => Promise<ContentExtent>
  /** Remaining document overflow at the proposed viewport, with authored dimensions restored. */
  overflow: (width: number, height: number) => Promise<{ width: number; height: number }>
  /** the width the content hugs to: the root shrunk to fit its content, never past `width` */
  width: (width: number, height: number) => Promise<number>
}

/** How much taller the viewport is made to tell a root height that follows it from a fixed one. */
const FOLLOW_PROBE_PX = 200

/** Loads the frame once and hands `settle` a probe on it. Before the first height measure at a
 *  width, the root and body are read at two viewport heights: one whose height follows the
 *  viewport (100vh, 100%, a script sizing it) is let go of while measuring the height, one that
 *  keeps its height (px, rem, calc of those, whatever rule set it) is the design's own and stays.
 *  They are read again whenever the width changes, since a width media query can fix a height
 *  that followed the viewport. A width is hugged with nothing let go of, as the canvas lays the
 *  design out. */
export function measureContent<T>(frame: Frame, settle: (probe: ContentProbe) => Promise<T>): Promise<T> {
  return renderer.withPage('measuring the frame', RENDER_TIMEOUT_MS, async (page) => {
    await loadFrameInto(page, frame, true)
    await installNameShim(page)
    let released: { width: number; rule: string } | undefined
    const layOut = async (width: number, height: number, release: boolean) => {
      await page.evaluate(holdRelease, release, released?.rule ?? '')
      await page.setViewport(frameViewport(width, height))
      await page.evaluate(settleDocument)
    }
    const followers = async (width: number, height: number) => {
      await layOut(width, height, false)
      const before = await page.evaluate(rootHeights)
      await layOut(width, height + FOLLOW_PROBE_PX, false)
      const after = await page.evaluate(rootHeights)
      return (['html', 'body'] as const).filter((name) => before[name] !== after[name])
    }
    const measure = async (width: number, height: number, hug: boolean) => {
      if (!hug && released?.width !== width) released = { width, rule: releaseRule(await followers(width, height)) }
      await layOut(width, height, !hug)
      return page.evaluate(contentExtent, hug, released?.rule ?? '')
    }
    return settle({
      overflow: async (width, height) => {
        await layOut(width, height, false)
        return page.evaluate(documentOverflow)
      },
      height: (width, height) => measure(width, height, false),
      width: async (width, height) => (await measure(width, height, true)).right,
    })
  })
}

function documentOverflow() {
  const root = document.scrollingElement
  if (!root) throw new Error('The frame has no document scrollport.')
  return {
    width: Math.max(0, root.scrollWidth - root.clientWidth),
    height: Math.max(0, root.scrollHeight - root.clientHeight),
  }
}

/** A new page starts at the candidate size before any design scripts execute. No fit styles
 * are installed. The search page has already released its renderer slot. */
export function freshFrameOverflow(frame: Frame) {
  return renderer.withPage('verifying the fitted frame', RENDER_TIMEOUT_MS, async (page) => {
    await loadFrameInto(page, frame, true)
    await page.evaluate(settleDocument)
    return page.evaluate(documentOverflow)
  })
}

/** Runs in the frame's page: switches the height release (`contentExtent` installs it) on or off
 *  and sets it to `rule`, ahead of a viewport change, so the frame's resize handlers run against
 *  the layout measured. */
function holdRelease(on: boolean, rule: string): void {
  const release = document.querySelector<HTMLStyleElement>('style[data-doop-fit]')
  if (!release) return
  release.textContent = rule
  if (release.sheet) release.sheet.disabled = !on
}

/** The rule letting go of the heights of the root and body in `released`. */
function releaseRule(released: string[]): string {
  return released.length ? `${released.join(',')}{height:auto!important;max-height:none!important}` : ''
}

/** Runs in the frame's page: the root's and body's heights. */
function rootHeights(): { html: number; body: number } {
  return {
    html: document.documentElement.getBoundingClientRect().height,
    body: document.body.getBoundingClientRect().height,
  }
}

/** Runs in the frame's page before each measure. The frame's own resize, ResizeObserver and
 *  matchMedia handlers run in the frames after a viewport change, so a layout built from
 *  innerHeight is read once they have; fonts are awaited, and animations finished, since
 *  mid-animation boxes (an entrance sliding up) measure where they will not stay. */
async function settleDocument(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await document.fonts.ready
  for (const animation of document.getAnimations()) {
    try {
      animation.finish()
    } catch {
      animation.cancel()
    }
  }
}

/** Runs in the frame's page. Measuring the height, `rule` lets the root and body whose height
 *  follows the viewport go of it (a body at 100vh or 100% would hold the frame at its current
 *  height); a min-height stays, since a px one is the design's own
 *  floor and a vh one is found by settleHeight's 1px probe. With `hug`, the root shrinks to fit
 *  its content for the one measure (`width: fit-content`, never wider than the viewport, held at
 *  the left in a right-to-left page), as a Figma frame hugs. Either way the extent is the furthest
 *  thing painted: the root's own box covers what flows, a walk adds what is positioned or
 *  overflows its box, text running past its element and absolute ::before / ::after included,
 *  each cut on the axis a box clips. Left out: what is invisible (a closed menu at
 *  visibility:hidden or opacity:0) and fixed elements, which sit on the viewport rather than the
 *  content. */
function contentExtent(hug: boolean, rule: string): ContentExtent {
  const MAX_ELEMENTS = 20_000
  const hugged = hug ? document.createElement('style') : null
  if (hugged) {
    /* a right-to-left root shrinks against the right edge: held at the left, its width is its right */
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl'
    hugged.textContent = `html{width:fit-content!important;min-width:0!important;max-width:none!important${rtl ? ';margin-left:0!important;margin-right:auto!important' : ''}}`
    document.head.append(hugged)
  }
  let release = document.querySelector('style[data-doop-fit]')
  if (!release && !hug) {
    /* judged as loaded, before the root and body are released: an app shell on the body (or on
       html,body{height:100%}) would otherwise unroll its scroller into the frame */
    const scrolls = (el: Element) => {
      const style = getComputedStyle(el)
      return (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 1 &&
        el.clientHeight >= innerHeight / 2
      )
    }
    /* the page fills its viewport and no more: a fixed-size panel that scrolls inside a shorter
       page is no shell, and the page can still shrink to it */
    const root = document.documentElement
    const fillsViewport = root.scrollHeight <= innerHeight + 1 && root.getBoundingClientRect().bottom >= innerHeight - 1
    const shell = fillsViewport && Array.from(document.body.querySelectorAll('*')).slice(0, MAX_ELEMENTS).some(scrolls)
    release = document.createElement('style')
    release.setAttribute('data-doop-fit', shell ? 'shell' : '')
    release.textContent = rule
    document.head.append(release)
  }
  const shell = release?.getAttribute('data-doop-fit') === 'shell'
  const rootBox = document.documentElement.getBoundingClientRect()
  const flow = rootBox.bottom
  let bottom = flow
  let right = rootBox.right
  let spills = 0
  const text = document.createRange()
  /* an absolute ::before / ::after has no box of its own to read: its far edges are its containing
     block's padding edges less its used offsets and margins; `own` when the element places it */
  const pseudoEdges = (el: Element, style: CSSStyleDeclaration, which: '::before' | '::after') => {
    const pseudo = getComputedStyle(el, which)
    if (pseudo.content === 'none' || pseudo.content === 'normal' || pseudo.position !== 'absolute') return null
    if (pseudo.display === 'none' || pseudo.visibility === 'hidden' || pseudo.opacity === '0') return null
    let block: Element | null = el
    let blockStyle = style
    while (block && blockStyle.position === 'static' && blockStyle.transform === 'none') {
      block = block.parentElement
      if (block) blockStyle = getComputedStyle(block)
    }
    const box = block?.getBoundingClientRect()
    const bottomEdge = box ? box.bottom - parseFloat(blockStyle.borderBottomWidth) : innerHeight - window.scrollY
    const rightEdge = box ? box.right - parseFloat(blockStyle.borderRightWidth) : innerWidth - window.scrollX
    return {
      bottom: bottomEdge - parseFloat(pseudo.bottom) - parseFloat(pseudo.marginBottom),
      right: rightEdge - parseFloat(pseudo.right) - parseFloat(pseudo.marginRight),
      own: block === el,
    }
  }
  /* `cap`: what the ancestors that clip let show, per axis; a box outside it shows nothing */
  type Cap = { right: number; bottom: number }
  const reach = (edges: { bottom: number; right: number; top?: number; left?: number } | null, cap: Cap) => {
    if (!edges) return
    if ((edges.left ?? -Infinity) >= cap.right || (edges.top ?? -Infinity) >= cap.bottom) return
    if (Number.isFinite(edges.bottom)) bottom = Math.max(bottom, Math.min(edges.bottom, cap.bottom))
    if (Number.isFinite(edges.right)) right = Math.max(right, Math.min(edges.right, cap.right))
  }
  /* the box an element lays its children out in, its border and padding taken off */
  const contentBox = (el: Element, style: CSSStyleDeclaration) => {
    const box = el.getBoundingClientRect()
    return {
      top: box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
      bottom: box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom),
    }
  }
  let seen = 0
  const walk = (el: Element, cap: Cap, holds: { top: number; bottom: number }) => {
    for (const child of Array.from(el.children)) {
      if (++seen > MAX_ELEMENTS) return
      const style = getComputedStyle(child)
      if (style.display === 'none' || style.position === 'fixed' || style.opacity === '0') continue
      const rect = child.getBoundingClientRect()
      /* each axis that does not show its overflow (hidden, clip, auto, scroll) cuts what is inside */
      const inside: Cap = {
        right: style.overflowX === 'visible' ? cap.right : Math.min(cap.right, rect.right),
        bottom: style.overflowY === 'visible' ? cap.bottom : Math.min(cap.bottom, rect.bottom),
      }
      const inFlow = style.position === 'static' || style.position === 'relative'
      if (inFlow && rect.height > 0 && (rect.top < holds.top - 1 || rect.bottom > holds.bottom + 1)) spills++
      /* a hidden box takes no paint, though a child of it may opt back in with visibility:visible */
      if (style.visibility !== 'hidden') {
        if (rect.width > 0 || rect.height > 0) reach(rect, cap)
        /* placed by the element itself, a pseudo-element is cut where the element clips */
        for (const which of ['::before', '::after'] as const) {
          const edges = pseudoEdges(child, style, which)
          reach(edges, edges?.own ? inside : cap)
        }
        /* its own text, which may run past its box; elements inside are walked themselves */
        for (const node of Array.from(child.childNodes)) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
          text.selectNodeContents(node)
          reach(text.getBoundingClientRect(), inside)
        }
      }
      walk(child, inside, contentBox(child, style))
    }
  }
  walk(document.body, { right: Infinity, bottom: Infinity }, contentBox(document.body, getComputedStyle(document.body)))
  hugged?.remove()
  return {
    painted: Math.ceil(bottom + window.scrollY),
    flow: Math.ceil(flow + window.scrollY),
    right: Math.ceil(right + window.scrollX),
    shell,
    spills,
  }
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
  const width = designPx(frame.width)
  const height = designPx(frame.height)
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
  const width = designPx(frame.width)
  const fullHeight = designPx(frame.height)
  const height = renderedHeight(frame, scale, opts.maxHeight)
  /* the viewport always spans the whole frame, so 100vh, height media
     queries and bottom-fixed elements lay out as they do on the canvas; the
     pixel budget bounds only the captured image below */
  await page.setViewport(frameViewport(width, fullHeight, scale))
  /* the new viewport can switch media queries onto faces not yet requested */
  await settleFonts(page.mainFrame())
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
