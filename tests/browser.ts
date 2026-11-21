import { execFile } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import puppeteer, { type Browser, type Page, type Permission } from 'puppeteer-core'
import { preview, type ProxyOptions } from 'vite'
import { afterAll, afterEach, beforeAll, expect, inject } from 'vitest'
import { findBrowserPath, launchBrowser } from '../server/screenshot.ts'

/**
 * Shared rig for the tests that drive a real Chromium: ONE browser and ONE
 * server for the fixtures, started by tests/globalSetup.ts before any worker
 * runs.
 *
 * The server hands out a production build of the fixtures (and of the app's
 * own index.html), made once per run by tests/fixtures.vite.config.ts. A page
 * is a few bundled files, so a load costs much the same on a 2-vCPU CI runner
 * as it does here, and it is the code that ships. A dev server would serve
 * the app as hundreds of unbundled modules, a second or two per load on CI,
 * and its live-reload client gives a stalled load up for a lost server and
 * never recovers the page.
 *
 * Chrome's cold start (30s+ on a fresh VM, past puppeteer's launch timeout)
 * and the build are paid once, outside any test timeout, and each file gets a
 * fresh browser context (its own cookies and storage, and its own window, so
 * its pages stay visible and focused) on the warm browser.
 */

declare module 'vitest' {
  interface ProvidedContext {
    /** null when no Chromium is installed; every browser test skips then */
    browserRig: { wsEndpoint: string; fixtureOrigin: string; builtDir: string } | null
  }
}

const FIXTURES = 'tests/fixtures'

/** Chrome's first start on a fresh CI VM reads its binary and builds font
 *  caches from a cold disk; that has taken well over puppeteer's 30s. */
const COLD_START_MS = 180_000

/** A fixture load is a handful of bundled files, well under a second. Files
 *  set a tight default timeout for their UI waits (5s), which puppeteer would
 *  also apply to navigation; loads get their own, roomier bound for a runner
 *  that stalls. */
const NAVIGATION_TIMEOUT_MS = 30_000

/** The bound on one UI wait (waitForSelector, waitForFunction, a locator
 *  click) when a file sets none of its own: shorter than the 30s test
 *  timeout, so a wait that never comes true fails on its own line with the
 *  condition it was waiting for, instead of the whole test timing out with
 *  nothing but its title. */
const STEP_TIMEOUT_MS = 15_000

/**
 * Build every fixture and the app into a fresh directory outside the tree.
 * Vite runs as its own process because a production build is decided by
 * NODE_ENV, which vitest has already set to `test` in this one. What the
 * fixtures fetch by path at run time (a stylesheet, an image) is not part of
 * the bundle, so those files are copied next to the built pages.
 */
async function buildFixtures(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'doop-test-fixtures-'))
  try {
    await promisify(execFile)(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'build', '--config', 'tests/fixtures.vite.config.ts', '--outDir', dir],
      { env: { ...process.env, NODE_ENV: 'production' } },
    )
    cpSync(FIXTURES, path.join(dir, FIXTURES), {
      recursive: true,
      filter: (source) => !/\.(html|ts)$/.test(source),
    })
    return dir
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

export interface BuiltServer {
  /** without a trailing slash */
  origin: string
  close(): Promise<void>
}

/**
 * Serve the built pages. The shared fixture server answers only the files
 * that exist. A test that puts the app in front of a real backend starts its
 * own with `proxy`, and that one also answers every app route with
 * index.html, as the production server does.
 */
export async function serveBuilt(
  proxy?: Record<string, ProxyOptions>,
  builtDir = rig().builtDir,
): Promise<BuiltServer> {
  const server = await preview({
    configFile: false,
    logLevel: 'error',
    appType: proxy ? 'spa' : 'mpa',
    build: { outDir: builtDir },
    preview: { port: 0, proxy },
  })
  return {
    origin: server.resolvedUrls!.local[0]!.replace(/\/$/, ''),
    close: () => server.close(),
  }
}

export interface BrowserRig {
  wsEndpoint: string
  fixtureOrigin: string
  builtDir: string
  close(): Promise<void>
}

/** Launch the browser and build and serve the fixtures, then load one page so
 *  the browser's first render is behind it before tests start. */
export async function startBrowserRig(): Promise<BrowserRig | null> {
  if (!findBrowserPath()) return null
  const [launched, built] = await Promise.allSettled([launchBrowser(COLD_START_MS), buildFixtures()])
  const browser = launched.status === 'fulfilled' ? launched.value : null
  const builtDir = built.status === 'fulfilled' ? built.value : null
  let server: BuiltServer | null = null
  const close = async () => {
    await browser?.close()
    await server?.close()
    if (builtDir) rmSync(builtDir, { recursive: true, force: true })
  }
  try {
    if (!browser || !builtDir)
      throw launched.status === 'rejected' ? launched.reason : (built as PromiseRejectedResult).reason
    server = await serveBuilt(undefined, builtDir)
    const fixtureOrigin = `${server.origin}/`
    await warmBrowser(browser, fixtureOrigin)
    return { wsEndpoint: browser.wsEndpoint(), fixtureOrigin, builtDir, close }
  } catch (error) {
    /* a half-started rig must not leave a Chromium or a server holding the run open */
    await close()
    throw error
  }
}

/** A fresh Chrome's first page starts a renderer and fills its font and code
 *  caches; one load here keeps that out of the first test's timeout. */
async function warmBrowser(browser: Browser, origin: string): Promise<void> {
  const context = await browser.createBrowserContext()
  try {
    const page = await context.newPage()
    await page.goto(`${origin}${FIXTURES}/drawing.html`, { waitUntil: 'load', timeout: COLD_START_MS })
  } finally {
    await context.close()
  }
}

/** What a test file drives: pages in its own context of the shared browser. */
export interface TestBrowser {
  newPage(): Promise<Page>
  /** grants this file's context the permissions on the fixture origin */
  grantPermissions(permissions: Permission[]): Promise<void>
  /** closes this file's context and lets go of the shared browser (which keeps running) */
  close(): Promise<void>
}

function rig(): { wsEndpoint: string; fixtureOrigin: string; builtDir: string } {
  const provided = inject('browserRig')
  if (!provided) throw new Error('no browser rig: tests/globalSetup.ts found no Chromium')
  return provided
}

export async function openBrowser(): Promise<TestBrowser> {
  const { wsEndpoint, fixtureOrigin } = rig()
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint })
  const context = await browser.createBrowserContext()
  return {
    async newPage() {
      const page = await context.newPage()
      page.setDefaultTimeout(STEP_TIMEOUT_MS)
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
      /* a renderer Chromium lost takes its page with it, and every later wait
         on that page only times out: say so once, where the log can be read */
      page.on('error', (error) => {
        process.stderr.write(`[browser] Chromium lost the tab at ${page.url()}: ${String(error)}\n`)
      })
      /* files running side by side each have a window in the one browser, and
         only one window holds the focus at a time: a page that lost it stops
         moving focus between its iframes. Emulated focus keeps every page
         focused, as it was alone in its own browser. */
      const session = await page.createCDPSession()
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      /* DOOP_TEST_CPU_THROTTLE=6 slows the page's main thread the way a busy
         CI runner does, for chasing a race locally */
      const rate = Number(process.env.DOOP_TEST_CPU_THROTTLE ?? '0')
      if (rate > 1) await session.send('Emulation.setCPUThrottlingRate', { rate })
      return page
    },
    grantPermissions: (permissions) => context.overridePermissions(fixtureOrigin, permissions),
    async close() {
      await context.close()
      await browser.disconnect()
    },
  }
}

/** What `pagePerTest` hands a file: a way to open this test's page. */
export interface TestPages {
  /** a new page for the running test (most tests open one; a test about two
   *  people opens a second), closed when the test ends */
  open(): Promise<Page>
}

/**
 * A page of its own for every test in the file. Call it once inside the
 * file's `describe`, then open the page in `beforeEach`:
 *
 *     const pages = pagePerTest()
 *     beforeEach(async () => {
 *       page = await pages.open()
 *       await page.goto(fixtureUrl('drawing.html'))
 *     })
 *
 * One page for a whole file made every test depend on the ones before it. A
 * page load that stalled on a CI runner left the page unusable, so each later
 * test's setup timed out too: one stall failed forty tests. A request still in
 * flight when a test ended arrived during the next one and was counted as its
 * own. A page that ends with its test takes both with it: its requests stop
 * when it closes, and the next test starts on a page nothing has touched.
 *
 * A file whose tests need clipboard or other permissions passes them here;
 * they are granted once, to the file's browser context.
 */
export function pagePerTest(options: { permissions?: Permission[] } = {}): TestPages {
  let browser: TestBrowser | undefined
  let opened: Page[] = []
  /** the pages of this test Chromium gave up on, and why */
  let lost = new Map<Page, string>()

  beforeAll(async () => {
    browser = await openBrowser()
    if (options.permissions) await browser.grantPermissions(options.permissions)
  }, 60_000)

  afterEach(async () => {
    const pages = opened
    const crashed = lost
    opened = []
    lost = new Map()
    /* a page Chromium lost can no longer be closed politely (closing the
       context at the end of the file takes it); every other page of the test
       still closes here, so nothing of it runs on into the next test */
    await Promise.all(pages.map((page) => (page.isClosed() || crashed.has(page) ? undefined : page.close())))
    expect([...crashed.values()], 'Chromium lost a page during this test').toEqual([])
  })

  afterAll(async () => {
    await browser?.close()
  })

  return {
    async open() {
      if (!browser) throw new Error('pagePerTest: open() runs inside a test or its beforeEach')
      const page = await browser.newPage()
      page.on('error', (error) => lost.set(page, String(error)))
      opened.push(page)
      return page
    },
  }
}

/** URL of a page in tests/fixtures on the shared fixture server. */
export function fixtureUrl(file: string): string {
  return `${rig().fixtureOrigin}${FIXTURES}/${file}`
}
