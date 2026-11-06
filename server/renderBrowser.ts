import type { Browser, BrowserContext, Page } from 'puppeteer-core'

/**
 * The lifecycle of the server's headless Chromium: who may open a page, on
 * which browser, for how long, and what happens when that browser stops
 * answering.
 *
 * Every server-side render (frame images, MCP screenshots, the resident
 * agent's checks, PDF / PSD / Figma / Canva exports, website imports) shares
 * one browser process. On 2026-11-05 that process wedged on prod: it kept its
 * DevTools socket open, so `connected` stayed true, but no new page ever
 * appeared and every render waited out puppeteer's 30s target timeout for
 * two hours, until a manual restart. Before that, ~45 full-size renders had
 * been started at once with no bound at all.
 *
 * So:
 *  - a gate bounds concurrent pages (background thumbnails get a smaller
 *    share, interactive callers are served first) and queues the rest for a
 *    bounded time, then refuses with `RendererBusyError` instead of piling up;
 *  - opening a page has a short deadline; a browser that cannot open one is
 *    killed (its whole process group) and the open retried once on a fresh
 *    launch, so a wedge costs one slow render, not an outage;
 *  - a render that fails like a browser failure (a timeout, a closed target,
 *    a broken session) triggers a health probe outside the gate, and a
 *    browser that fails the probe is killed the same way;
 *  - every page has a lease: one held past it is closed and its slot
 *    returned, so a stuck caller cannot starve the gate;
 *  - a browser is recycled (drained, then closed) after a number of pages
 *    or an age, so slow leaks inside Chromium never accumulate for days.
 */

export type RenderPriority = 'interactive' | 'background'

export interface RendererTuning {
  /** pages open at once, across every caller */
  maxConcurrent: number
  /** of those, how many background work (thumbnail revalidation) may hold */
  maxBackground: number
  /** callers waiting for a slot before new ones are refused */
  maxQueued: number
  /** how long a caller waits for a slot before it is refused */
  queueTimeoutMs: number
  /** creating a context and a page on a healthy browser takes milliseconds */
  openTimeoutMs: number
  /** the longest any caller may hold a page */
  leaseMs: number
  /** the health probe: a context, a page and one evaluation */
  probeTimeoutMs: number
  /** graceful browser / context close before the process is killed */
  closeTimeoutMs: number
  /** pages one browser serves before it is recycled */
  maxPagesPerBrowser: number
  /** how long one browser lives before it is recycled */
  maxBrowserAgeMs: number
  /** close a browser that has had no page open this long; unset keeps it.
   *  A remote browser is billed while its session is open, so it gets one */
  idleCloseMs?: number
}

export const DEFAULT_RENDERER_TUNING: RendererTuning = {
  maxConcurrent: 4,
  maxBackground: 2,
  maxQueued: 48,
  queueTimeoutMs: 30_000,
  openTimeoutMs: 15_000,
  leaseMs: 120_000,
  probeTimeoutMs: 10_000,
  closeTimeoutMs: 5_000,
  maxPagesPerBrowser: 500,
  maxBrowserAgeMs: 60 * 60_000,
}

export class RenderTimeoutError extends Error {
  constructor(step: string, ms: number) {
    super(`${step} did not finish within ${ms}ms`)
    this.name = 'RenderTimeoutError'
  }
}

/** The gate is full: the caller should retry shortly (HTTP 503). */
export class RendererBusyError extends Error {
  constructor(reason: string) {
    super(`The renderer is busy (${reason}); try again in a few seconds`)
    this.name = 'RendererBusyError'
  }
}

/** A remote browser that would not connect. The WebSocket library rejects
 *  with an event, not an Error, so its message would be lost on the way to
 *  the caller; a provider turning new sessions away (HTTP 429) is the
 *  renderer being busy, which callers already answer with a 503. */
export function remoteConnectFailure(error: unknown): Error {
  if (error instanceof Error) return error
  const message =
    typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error)
  if (/\b429\b/.test(message)) return new RendererBusyError('the remote browser is refusing new sessions')
  return new Error(`could not connect to the remote browser: ${message}`)
}

/** Did the failure come from the browser rather than the frame? A stall, a
 *  closed target or a broken DevTools session all point at the browser. */
export function isBrowserFailure(error: unknown): boolean {
  if (error instanceof RenderTimeoutError) return true
  if (!(error instanceof Error)) return false
  if (['TimeoutError', 'TargetCloseError', 'ProtocolError'].includes(error.name)) return true
  return /Target closed|Session closed|Protocol error|Connection closed|waiting for target|Timed out after waiting|protocolTimeout|Browser was disconnected|Navigating frame was detached/i.test(
    error.message,
  )
}

export function withDeadline<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
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

/* ------------------------------------------------------------------ gate */

interface Waiter {
  priority: RenderPriority
  admit: () => void
  refuse: (error: Error) => void
}

/** Counting semaphore with two priorities and a bounded, timed queue. */
export class RenderGate {
  private active = 0
  private background = 0
  private readonly waiting: Waiter[] = []

  constructor(
    private readonly tuning: Pick<RendererTuning, 'maxConcurrent' | 'maxBackground' | 'maxQueued' | 'queueTimeoutMs'>,
  ) {}

  get stats() {
    return { active: this.active, background: this.background, queued: this.waiting.length }
  }

  /** Resolves with the slot's release function, which is safe to call twice. */
  acquire(priority: RenderPriority): Promise<() => void> {
    if (this.canAdmit(priority) && !this.waiting.some((w) => this.outranks(w, priority)))
      return Promise.resolve(this.take(priority))
    if (this.waiting.length >= this.tuning.maxQueued)
      return Promise.reject(new RendererBusyError(`${this.waiting.length} renders already queued`))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        admit: () => {
          clearTimeout(timer)
          resolve(this.take(priority))
        },
        refuse: reject,
      }
      const timer = setTimeout(() => {
        this.remove(waiter)
        reject(new RendererBusyError(`no render slot within ${this.tuning.queueTimeoutMs}ms`))
      }, this.tuning.queueTimeoutMs)
      timer.unref?.()
      this.waiting.push(waiter)
    })
  }

  private canAdmit(priority: RenderPriority): boolean {
    if (this.active >= this.tuning.maxConcurrent) return false
    return priority === 'interactive' || this.background < this.tuning.maxBackground
  }

  /** an interactive waiter goes before background work, whatever the order */
  private outranks(waiter: Waiter, priority: RenderPriority): boolean {
    return priority === 'background' || waiter.priority === 'interactive'
  }

  private take(priority: RenderPriority): () => void {
    this.active++
    if (priority === 'background') this.background++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      if (priority === 'background') this.background--
      this.pump()
    }
  }

  private pump(): void {
    while (this.waiting.length) {
      const next =
        this.waiting.find((w) => w.priority === 'interactive' && this.canAdmit('interactive')) ??
        this.waiting.find((w) => this.canAdmit(w.priority))
      if (!next) return
      this.remove(next)
      next.admit()
    }
  }

  private remove(waiter: Waiter): void {
    const at = this.waiting.indexOf(waiter)
    if (at >= 0) this.waiting.splice(at, 1)
  }
}

/* --------------------------------------------------------------- browser */

type GenerationState = 'live' | 'draining' | 'dead'

interface Generation {
  id: number
  browser: Promise<Browser>
  resolved: Browser | null
  launchedAt: number
  pagesOpen: number
  pagesServed: number
  state: GenerationState
  probing: Promise<boolean> | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

export interface RenderPage {
  page: Page
  /** which browser launch served the page (tests and logs) */
  generation: number
  /** closes the page's context and returns its slot; bounded, idempotent */
  close: () => Promise<void>
}

export interface PageOptions {
  priority?: RenderPriority
}

export interface Renderer {
  openPage(options?: PageOptions): Promise<RenderPage>
  /** open a page, run `work` under `timeoutMs`, always close; a browser
   *  failure that kills the browser is retried once on a fresh launch */
  withPage<T>(step: string, timeoutMs: number, work: (page: Page) => Promise<T>, options?: PageOptions): Promise<T>
  /** the live browser, launched if need be (tests and one-off callers) */
  browser(): Promise<Browser>
  status(): RendererStatus
  shutdown(): Promise<void>
}

export interface RendererStatus {
  generation: number | null
  state: GenerationState | null
  pagesOpen: number
  pagesServed: number
  ageMs: number
  active: number
  background: number
  queued: number
  kills: number
  recycles: number
  /** when a page last opened; an uptime check alerts when this goes stale
   *  while the queue is not empty */
  lastOpenedAt: number | null
  /** page opens that failed in a row (reset by the next success) */
  failedOpensInARow: number
}

export interface RendererDeps {
  launch: () => Promise<Browser>
  tuning?: Partial<RendererTuning>
  now?: () => number
  log?: Pick<Console, 'warn' | 'error'>
}

export function createRenderer(deps: RendererDeps): Renderer {
  const tuning: RendererTuning = { ...DEFAULT_RENDERER_TUNING, ...deps.tuning }
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  const gate = new RenderGate(tuning)
  let current: Generation | null = null
  let sequence = 0
  let kills = 0
  let recycles = 0
  let lastOpenedAt: number | null = null
  let failedOpensInARow = 0

  function launchGeneration(): Generation {
    const generation: Generation = {
      id: ++sequence,
      browser: deps.launch(),
      resolved: null,
      launchedAt: now(),
      pagesOpen: 0,
      pagesServed: 0,
      state: 'live',
      probing: null,
      idleTimer: null,
    }
    current = generation
    generation.browser.then(
      (browser) => {
        generation.resolved = browser
        if (generation.state === 'dead') void terminate(browser)
      },
      () => {
        /* a failed launch (a cold start past its timeout) must not be handed
           to every later caller: the next one launches again */
        generation.state = 'dead'
        if (current === generation) current = null
      },
    )
    return generation
  }

  function outlived(generation: Generation): boolean {
    return (
      generation.pagesServed >= tuning.maxPagesPerBrowser || now() - generation.launchedAt >= tuning.maxBrowserAgeMs
    )
  }

  function liveGeneration(): Generation {
    const generation = current
    if (generation && generation.state === 'live') {
      if (generation.resolved && !generation.resolved.connected) {
        kill(generation, 'the browser disconnected')
      } else if (outlived(generation)) {
        recycles++
        drain(generation)
      } else {
        return generation
      }
    }
    return launchGeneration()
  }

  /** stop handing the browser out; close it once its last page is done */
  function drain(generation: Generation): void {
    generation.state = 'draining'
    if (current === generation) current = null
    if (generation.pagesOpen === 0) retire(generation)
  }

  /** a wedged or disconnected browser: kill it now, pages and all */
  function kill(generation: Generation, reason: string): void {
    if (generation.state === 'dead') return
    kills++
    log.error(`[renderer] browser #${generation.id} killed: ${reason}`)
    retire(generation)
  }

  function retire(generation: Generation): void {
    if (generation.idleTimer) clearTimeout(generation.idleTimer)
    generation.state = 'dead'
    if (current === generation) current = null
    if (generation.resolved) void terminate(generation.resolved)
  }

  async function terminate(browser: Browser): Promise<void> {
    const child = browser.process()
    const closed = await withDeadline(browser.close(), tuning.closeTimeoutMs, 'closing the browser').then(
      () => true,
      () => false,
    )
    if (child && child.exitCode === null && child.signalCode === null) killProcessTree(child)
    /* a remote browser has no process to kill: drop the socket, and its
       session ends on the provider's idle timeout */
    if (!child && !closed) await browser.disconnect().catch(() => {})
  }

  function releasePage(generation: Generation): void {
    generation.pagesOpen--
    if (generation.pagesOpen > 0) return
    if (generation.state === 'draining') retire(generation)
    else if (generation.state === 'live') scheduleIdleClose(generation)
  }

  function scheduleIdleClose(generation: Generation): void {
    const idleMs = tuning.idleCloseMs
    if (idleMs === undefined) return
    if (generation.idleTimer) clearTimeout(generation.idleTimer)
    generation.idleTimer = setTimeout(() => {
      generation.idleTimer = null
      if (generation.state === 'live' && generation.pagesOpen === 0) drain(generation)
    }, idleMs)
    generation.idleTimer.unref?.()
  }

  /** Is the browser still able to make a page? Runs outside the gate, since
   *  the slots may all be held by the renders that stalled. Single-flight per
   *  browser; kills it when the answer is no. */
  function checkHealth(generation: Generation, cause: unknown): Promise<boolean> {
    if (generation.state === 'dead') return Promise.resolve(false)
    generation.probing ??= probe(generation)
      .then((healthy) => {
        if (!healthy) kill(generation, `failed its health probe after: ${describe(cause)}`)
        return healthy
      })
      .finally(() => {
        generation.probing = null
      })
    return generation.probing
  }

  async function probe(generation: Generation): Promise<boolean> {
    const attempt = (async () => {
      const browser = await generation.browser
      const context = await browser.createBrowserContext()
      try {
        const page = await context.newPage()
        await page.evaluate('1')
      } finally {
        void closeContext(context)
      }
    })()
    return withDeadline(attempt, tuning.probeTimeoutMs, 'the browser health probe').then(
      () => true,
      () => false,
    )
  }

  /** Resolves true once the context is gone; false when closing threw or
   *  outlived its deadline, i.e. the page may still be alive. */
  function closeContext(context: BrowserContext): Promise<boolean> {
    return withDeadline(context.close(), tuning.closeTimeoutMs, 'closing the page').then(
      () => true,
      () => false,
    )
  }

  async function openOn(generation: Generation): Promise<{ context: BrowserContext; page: Page }> {
    const browser = await generation.browser
    const opening = browser.createBrowserContext()
    const context = await withDeadline(opening, tuning.openTimeoutMs, 'opening a browser context').catch(
      (error: unknown) => {
        /* a context that arrives after its deadline must not leak */
        opening.then(
          (late) => void closeContext(late),
          () => {},
        )
        throw error
      },
    )
    try {
      const page = await withDeadline(context.newPage(), tuning.openTimeoutMs, 'opening a page')
      return { context, page }
    } catch (error) {
      void closeContext(context)
      throw error
    }
  }

  async function openOnLiveBrowser(): Promise<{ generation: Generation; context: BrowserContext; page: Page }> {
    const generation = liveGeneration()
    generation.pagesOpen++
    generation.pagesServed++
    try {
      const opened = await openOn(generation)
      lastOpenedAt = now()
      failedOpensInARow = 0
      return { generation, ...opened }
    } catch (error) {
      failedOpensInARow++
      releasePage(generation)
      /* a healthy browser opens a page in milliseconds, and the gate keeps it
         from being swamped: failing to open one is the wedge itself */
      if (isBrowserFailure(error)) kill(generation, `could not open a page: ${describe(error)}`)
      throw error
    }
  }

  async function openPage(options: PageOptions = {}): Promise<RenderPage> {
    const release = await gate.acquire(options.priority ?? 'interactive')
    let opened: Awaited<ReturnType<typeof openOnLiveBrowser>>
    try {
      opened = await openOnLiveBrowser().catch((error: unknown) => {
        if (!isBrowserFailure(error)) throw error
        log.warn(`[renderer] retrying on a fresh browser after: ${describe(error)}`)
        return openOnLiveBrowser()
      })
    } catch (error) {
      release()
      throw error
    }
    const { generation, context, page } = opened
    let closing: Promise<void> | null = null
    const close = () => {
      closing ??= (async () => {
        clearTimeout(lease)
        const closed = await closeContext(context)
        releasePage(generation)
        /* a page that would not close is still holding the browser; killing
           the browser is the only way to be sure it is gone before its slot
           goes to the next render */
        if (!closed) kill(generation, 'a page would not close')
        release()
      })()
      return closing
    }
    const lease = setTimeout(() => {
      log.warn(`[renderer] a page on browser #${generation.id} outlived its ${tuning.leaseMs}ms lease; closing it`)
      void close()
      void checkHealth(generation, new RenderTimeoutError('a page lease', tuning.leaseMs))
    }, tuning.leaseMs)
    lease.unref?.()
    return { page, generation: generation.id, close }
  }

  async function withPage<T>(
    step: string,
    timeoutMs: number,
    work: (page: Page) => Promise<T>,
    options: PageOptions = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const handle = await openPage(options)
      let failure: unknown
      try {
        return await withDeadline(work(handle.page), timeoutMs, step)
      } catch (error) {
        failure = error
      } finally {
        await handle.close()
      }
      if (!isBrowserFailure(failure) || attempt > 0) throw failure
      const generation = findGeneration(handle.generation)
      const healthy = generation ? await checkHealth(generation, failure) : false
      /* a healthy browser means the frame itself is too slow: no retry */
      if (healthy) throw failure
      log.warn(`[renderer] ${step}: retrying on a fresh browser after: ${describe(failure)}`)
    }
  }

  /* only the current generation can be probed; an older one is already
     draining or dead, and its failure says nothing about the live one */
  function findGeneration(id: number): Generation | null {
    return current && current.id === id ? current : null
  }

  return {
    openPage,
    withPage,
    browser: () => liveGeneration().browser,
    status: () => ({
      generation: current?.id ?? null,
      state: current?.state ?? null,
      pagesOpen: current?.pagesOpen ?? 0,
      pagesServed: current?.pagesServed ?? 0,
      ageMs: current ? now() - current.launchedAt : 0,
      ...gate.stats,
      kills,
      recycles,
      lastOpenedAt,
      failedOpensInARow,
    }),
    shutdown: async () => {
      const generation = current
      if (!generation) return
      retire(generation)
      await generation.browser.then(terminate, () => {})
    },
  }
}

interface ChildLike {
  pid?: number
  kill: (signal?: NodeJS.Signals) => boolean
}

/** Chromium's renderers and GPU process are children of the browser
 *  process; puppeteer launches it as a process-group leader off Windows, so
 *  the group goes down together and no orphaned renderer keeps its memory. */
function killProcessTree(child: ChildLike): void {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGKILL')
      return
    }
  } catch {
    /* not a group leader: fall through to the process itself */
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
