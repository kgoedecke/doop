import { readdirSync } from 'node:fs'
import puppeteer, { type Browser, type Page, type Permission } from 'puppeteer-core'
import { createServer, type InlineConfig, type ServerOptions } from 'vite'
import { afterAll, afterEach, beforeAll, expect, inject } from 'vitest'
import { findBrowserPath, launchBrowser } from '../server/screenshot.ts'

/**
 * Shared rig for the tests that drive a real Chromium: ONE browser and ONE
 * Vite server for the fixtures, started and warmed by tests/globalSetup.ts
 * before any worker runs.
 *
 * Every file used to launch its own Chromium and its own Vite server. On the
 * 2-vCPU CI runner that meant a cold Chrome start (30s+ on a fresh VM, past
 * puppeteer's launch timeout) and a cold transform of the whole app (past the
 * 5-10s navigation timeouts) inside the first files' hooks, and files whose
 * servers asked for different `optimizeDeps` rewrote the shared dependency
 * cache under each other. Now the cold costs are paid once, outside any test
 * timeout, and each file gets a fresh browser context (its own cookies and
 * storage, and its own window, so its pages stay visible and focused) on the
 * warm browser.
 */

declare module 'vitest' {
  interface ProvidedContext {
    /** null when no Chromium is installed; every browser test skips then */
    browserRig: { wsEndpoint: string; fixtureOrigin: string } | null
  }
}

const FIXTURES = 'tests/fixtures'

/** Chrome's first start on a fresh CI VM reads its binary and builds font
 *  caches from a cold disk; that has taken well over puppeteer's 30s. */
const COLD_START_MS = 180_000

/** A fixture load fetches and runs the app as hundreds of unbundled modules:
 *  well under a second here, several on a busy 2-vCPU runner. Files set a
 *  tight default timeout for their UI waits (5s), which puppeteer would also
 *  apply to navigation; loads get their own, roomier bound. */
const NAVIGATION_TIMEOUT_MS = 30_000

/** The bound on one UI wait (waitForSelector, waitForFunction, a locator
 *  click) when a file sets none of its own: shorter than the 30s test
 *  timeout, so a wait that never comes true fails on its own line with the
 *  condition it was waiting for, instead of the whole test timing out with
 *  nothing but its title. */
const STEP_TIMEOUT_MS = 15_000

/**
 * The Vite config every fixture server uses. One `optimizeDeps` for all of
 * them: the dependency hash covers `include`, and a server whose hash differs
 * re-bundles the cache directory out from under the others. The fixtures are
 * scan entries so their dependencies are bundled up front instead of being
 * discovered mid-test, which reloads every open page. The cache directory is
 * separate from `bun run dev`'s, so a dev server in the same checkout never
 * fights a test run over it, and nothing is watched: a file written while the
 * suite runs must not reload the pages under test.
 */
export function fixtureServerConfig(server: ServerOptions = {}): InlineConfig {
  return {
    logLevel: 'error',
    cacheDir: 'node_modules/.vite-test',
    optimizeDeps: {
      entries: ['index.html', `${FIXTURES}/*.html`],
      include: ['posthog-js/dist/posthog-recorder', 'posthog-js/dist/rrweb'],
    },
    server: { port: 0, watch: null, ...server },
  }
}

export interface BrowserRig {
  wsEndpoint: string
  fixtureOrigin: string
  close(): Promise<void>
}

/** Launch the browser and the fixture server, then load every fixture once so
 *  dependency bundling and the app's transforms are done before tests start. */
export async function startBrowserRig(): Promise<BrowserRig | null> {
  if (!findBrowserPath()) return null
  const [launched, created] = await Promise.allSettled([
    launchBrowser(COLD_START_MS),
    createServer(fixtureServerConfig()),
  ])
  const browser = launched.status === 'fulfilled' ? launched.value : null
  const vite = created.status === 'fulfilled' ? created.value : null
  const close = async () => {
    await browser?.close()
    await vite?.close()
  }
  try {
    if (!browser || !vite)
      throw launched.status === 'rejected' ? launched.reason : (created as PromiseRejectedResult).reason
    await vite.listen()
    const fixtureOrigin = vite.resolvedUrls!.local[0]!
    await warmFixtures(browser, fixtureOrigin)
    return { wsEndpoint: browser.wsEndpoint(), fixtureOrigin, close }
  } catch (error) {
    /* a half-started rig must not leave a Chromium or a server holding the run open */
    await close()
    throw error
  }
}

async function warmFixtures(browser: Browser, origin: string): Promise<void> {
  const context = await browser.createBrowserContext()
  try {
    /* one at a time: the first pays for the dependency bundle, the rest only
       for the modules that are theirs */
    for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith('.html'))) {
      const page = await context.newPage()
      await page.goto(`${origin}${FIXTURES}/${file}`, { waitUntil: 'load', timeout: COLD_START_MS })
      await page.close()
    }
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

function rig(): { wsEndpoint: string; fixtureOrigin: string } {
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
  /** why Chromium gave up on one of this test's pages, when it did */
  let lost: string | null = null

  beforeAll(async () => {
    browser = await openBrowser()
    if (options.permissions) await browser.grantPermissions(options.permissions)
  }, 60_000)

  afterEach(async () => {
    const pages = opened
    const reason = lost
    opened = []
    lost = null
    /* a page Chromium lost can no longer be closed politely; closing the
       context at the end of the file takes it */
    if (!reason) await Promise.all(pages.map((page) => (page.isClosed() ? undefined : page.close())))
    expect(reason, 'Chromium lost the page during this test').toBeNull()
  })

  afterAll(async () => {
    await browser?.close()
  })

  return {
    async open() {
      if (!browser) throw new Error('pagePerTest: open() runs inside a test or its beforeEach')
      const page = await browser.newPage()
      page.on('error', (error) => (lost = String(error)))
      opened.push(page)
      return page
    },
  }
}

/** URL of a page in tests/fixtures on the shared fixture server. */
export function fixtureUrl(file: string): string {
  return `${rig().fixtureOrigin}${FIXTURES}/${file}`
}
