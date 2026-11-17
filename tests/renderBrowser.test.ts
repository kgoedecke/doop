import { describe, expect, it, vi } from 'vitest'
import type { Browser } from 'puppeteer-core'
import {
  RenderGate,
  RenderTimeoutError,
  RendererBusyError,
  createRenderer,
  isBrowserFailure,
  remoteConnectFailure,
  type RendererTuning,
} from '../server/renderBrowser.ts'
import { MAX_RENDER_PIXELS, renderedHeight } from '../server/renderLimits.ts'

/* On 2026-11-05 prod's one shared Chromium stopped creating pages while its
   DevTools socket stayed open, and every render timed out for two hours.
   These tests drive the renderer's lifecycle against fake browsers that
   stall the way that one did. */

const never = () => new Promise<never>(() => {})
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

const FAST: Partial<RendererTuning> = {
  maxConcurrent: 4,
  maxBackground: 2,
  maxQueued: 8,
  queueTimeoutMs: 200,
  openTimeoutMs: 40,
  leaseMs: 5_000,
  probeTimeoutMs: 40,
  closeTimeoutMs: 20,
}

interface FakeBrowser {
  label: string
  connected: boolean
  stallContexts: boolean
  stallClose: boolean
  stallContextClose: boolean
  contextsOpen: number
  close: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  child: { pid: undefined; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> }
  createBrowserContext: () => Promise<unknown>
  process: () => FakeBrowser['child'] | null
}

function fakeBrowser(
  label: string,
  options: { stallContexts?: boolean; stallClose?: boolean; stallContextClose?: boolean; remote?: boolean } = {},
): FakeBrowser {
  const browser: FakeBrowser = {
    label,
    connected: true,
    stallContexts: options.stallContexts ?? false,
    stallClose: options.stallClose ?? false,
    stallContextClose: options.stallContextClose ?? false,
    contextsOpen: 0,
    /* pid undefined: the kill falls back to child.kill, never a real group */
    child: { pid: undefined, exitCode: null, signalCode: null, kill: vi.fn(() => true) },
    close: vi.fn(() => (browser.stallClose ? never() : Promise.resolve())),
    disconnect: vi.fn(() => Promise.resolve()),
    createBrowserContext: () => {
      if (browser.stallContexts) return never()
      browser.contextsOpen++
      let closed = false
      return Promise.resolve({
        newPage: async () => ({ label, evaluate: async () => 1 }),
        close: async () => {
          if (browser.stallContextClose) return never()
          if (closed) return
          closed = true
          browser.contextsOpen--
        },
      })
    },
    /* a remote browser (REMOTE_BROWSER_URL) has no local process */
    process: () => (options.remote ? null : browser.child),
  }
  return browser
}

function rig(browsers: FakeBrowser[], tuning: Partial<RendererTuning> = {}) {
  const queue = [...browsers]
  const launch = vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('no more fake browsers')
    return next as unknown as Browser
  })
  const log = { warn: vi.fn(), error: vi.fn() }
  const renderer = createRenderer({ launch, tuning: { ...FAST, ...tuning }, log })
  return { renderer, launch, log }
}

const label = (page: unknown) => (page as { label: string }).label

describe('a wedged browser', () => {
  it('is killed when it cannot open a page, and the page opens on a fresh launch', async () => {
    const stuck = fakeBrowser('stuck', { stallContexts: true })
    const fresh = fakeBrowser('fresh')
    const { renderer, launch, log } = rig([stuck, fresh])

    const handle = await renderer.openPage()

    expect(label(handle.page)).toBe('fresh')
    expect(launch).toHaveBeenCalledTimes(2)
    expect(stuck.close).toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/killed: could not open a page/))
    await handle.close()
    expect(renderer.status()).toMatchObject({ kills: 1, active: 0, pagesOpen: 0 })
  })

  it('reports a timeout when the relaunch stalls too, instead of hanging', async () => {
    const { renderer, launch } = rig([
      fakeBrowser('a', { stallContexts: true }),
      fakeBrowser('b', { stallContexts: true }),
    ])

    await expect(renderer.openPage()).rejects.toBeInstanceOf(RenderTimeoutError)
    expect(launch).toHaveBeenCalledTimes(2)
    expect(renderer.status()).toMatchObject({ active: 0, failedOpensInARow: 2 })
  })

  it('is SIGKILLed even when its graceful close stalls too', async () => {
    const stuck = fakeBrowser('stuck', { stallContexts: true, stallClose: true })
    const { renderer } = rig([stuck, fakeBrowser('fresh')])

    const handle = await renderer.openPage()
    await tick(FAST.closeTimeoutMs! * 3)

    expect(stuck.child.kill).toHaveBeenCalledWith('SIGKILL')
    await handle.close()
  })

  it('is replaced by one launch however many callers saw it fail at once', async () => {
    const stuck = fakeBrowser('stuck', { stallContexts: true })
    const fresh = fakeBrowser('fresh')
    const { renderer, launch } = rig([stuck, fresh])

    const handles = await Promise.all([renderer.openPage(), renderer.openPage(), renderer.openPage()])

    expect(handles.map((h) => label(h.page))).toEqual(['fresh', 'fresh', 'fresh'])
    expect(launch).toHaveBeenCalledTimes(2)
    await Promise.all(handles.map((h) => h.close()))
  })

  it('that stalls mid-render fails the health probe, is killed, and the render reruns once', async () => {
    const turning = fakeBrowser('turning')
    const fresh = fakeBrowser('fresh')
    const { renderer, launch } = rig([turning, fresh])

    let attempts = 0
    const result = await renderer.withPage('rendering', 40, async (page) => {
      attempts++
      if (label(page) === 'turning') {
        turning.stallContexts = true /* the probe will not get a page either */
        return never()
      }
      return 'png'
    })

    expect(result).toBe('png')
    expect(attempts).toBe(2)
    expect(launch).toHaveBeenCalledTimes(2)
    expect(turning.close).toHaveBeenCalled()
  })

  it('is replaced once it disconnects', async () => {
    const first = fakeBrowser('first')
    const { renderer, launch } = rig([first, fakeBrowser('second')])
    await (await renderer.openPage()).close()

    first.connected = false
    const handle = await renderer.openPage()

    expect(label(handle.page)).toBe('second')
    expect(launch).toHaveBeenCalledTimes(2)
    await handle.close()
  })
})

describe('a healthy browser', () => {
  it('keeps serving when one frame is too slow: the render times out, nothing is relaunched', async () => {
    const browser = fakeBrowser('ok')
    const { renderer, launch } = rig([browser])

    await expect(renderer.withPage('rendering', 30, () => never())).rejects.toBeInstanceOf(RenderTimeoutError)

    expect(launch).toHaveBeenCalledTimes(1)
    expect(browser.close).not.toHaveBeenCalled()
    expect(browser.contextsOpen).toBe(0)
    expect(renderer.status().active).toBe(0)
  })

  it('does not relaunch for a failure that is the frame’s own', async () => {
    const browser = fakeBrowser('ok')
    const { renderer, launch } = rig([browser])

    await expect(
      renderer.withPage('rendering', 1_000, async () => {
        throw new Error('Unable to capture screenshot: image too large')
      }),
    ).rejects.toThrow(/too large/)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(browser.close).not.toHaveBeenCalled()
  })

  it('is recycled after its page budget, once its last page closes', async () => {
    const old = fakeBrowser('old')
    const { renderer, launch } = rig([old, fakeBrowser('new')], { maxPagesPerBrowser: 2 })
    const first = await renderer.openPage()
    const second = await renderer.openPage()

    const third = await renderer.openPage()
    expect(label(third.page)).toBe('new')
    expect(old.close).not.toHaveBeenCalled() /* still serving two pages */

    await first.close()
    await second.close()
    expect(old.close).toHaveBeenCalled()
    expect(launch).toHaveBeenCalledTimes(2)
    expect(renderer.status().recycles).toBe(1)
    await third.close()
  })

  it('closes a page held past its lease and gives the slot back', async () => {
    const browser = fakeBrowser('ok')
    const { renderer, log } = rig([browser], { leaseMs: 30, maxConcurrent: 1 })

    await renderer.openPage() /* never closed by its caller */
    const next = await renderer.openPage()

    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/outlived its 30ms lease/))
    expect(browser.contextsOpen).toBe(1)
    await next.close()
  })
})

describe('a page that will not close', () => {
  it('takes its browser down with it, and the slot goes to a fresh browser', async () => {
    const stuck = fakeBrowser('stuck', { stallContextClose: true })
    const fresh = fakeBrowser('fresh')
    const { renderer, log } = rig([stuck, fresh], { maxConcurrent: 1 })

    const first = await renderer.openPage()
    await first.close()

    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/killed: a page would not close/))
    expect(stuck.close).toHaveBeenCalled()
    expect(renderer.status()).toMatchObject({ kills: 1, active: 0, pagesOpen: 0 })
    const second = await renderer.openPage()
    expect(label(second.page)).toBe('fresh')
    await second.close()
  })
})

describe('a remote browser', () => {
  it('is closed once it has had no page for its idle time, and the next page connects afresh', async () => {
    const first = fakeBrowser('first', { remote: true })
    const second = fakeBrowser('second', { remote: true })
    const { renderer, launch } = rig([first, second], { idleCloseMs: 30 })

    const a = await renderer.openPage()
    await a.close()
    const b = await renderer.openPage()
    await tick(50)
    /* a page is open: the idle clock does not run */
    expect(first.close).not.toHaveBeenCalled()
    await b.close()
    await tick(50)
    expect(first.close).toHaveBeenCalled()

    const c = await renderer.openPage()
    expect(label(c.page)).toBe('second')
    expect(launch).toHaveBeenCalledTimes(2)
    await c.close()
  })

  it('is disconnected when closing its session stalls, having no process to kill', async () => {
    const stuck = fakeBrowser('stuck', { remote: true, stallContexts: true, stallClose: true })
    const { renderer } = rig([stuck, fakeBrowser('fresh', { remote: true })])

    const handle = await renderer.openPage()
    await tick(40)

    expect(stuck.disconnect).toHaveBeenCalled()
    await handle.close()
  })
})

describe('remoteConnectFailure', () => {
  /* what the ws library rejects with when the provider answers the upgrade
     with an HTTP error: an ErrorEvent, not an Error */
  const refused = (status: number) => ({ type: 'error', message: `Unexpected server response: ${status}` })

  it('turns a provider rate limit into a busy renderer', () => {
    expect(remoteConnectFailure(refused(429))).toBeInstanceOf(RendererBusyError)
  })

  it('keeps the message of any other refusal, and passes real errors through', () => {
    const error = remoteConnectFailure(refused(401))
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('could not connect to the remote browser: Unexpected server response: 401')
    const timeout = new RenderTimeoutError('connecting to the remote browser', 30_000)
    expect(remoteConnectFailure(timeout)).toBe(timeout)
  })
})

describe('RenderGate', () => {
  const tuning = { maxConcurrent: 2, maxBackground: 1, maxQueued: 2, queueTimeoutMs: 100 }

  it('admits up to the limit and queues the rest', async () => {
    const gate = new RenderGate(tuning)
    const a = await gate.acquire('interactive')
    await gate.acquire('interactive')
    let admitted = false
    const waiting = gate.acquire('interactive').then((release) => {
      admitted = true
      return release
    })
    await tick()
    expect(admitted).toBe(false)

    a()
    a() /* releasing twice frees one slot, not two */
    ;(await waiting)()
    expect(gate.stats).toMatchObject({ active: 1, queued: 0 })
  })

  it('keeps background work to its share', async () => {
    const gate = new RenderGate(tuning)
    await gate.acquire('background')
    let second = false
    void gate
      .acquire('background')
      .then(() => (second = true))
      .catch(() => {}) /* refused by the queue timeout after the test */
    await tick()

    expect(second).toBe(false)
    await gate.acquire('interactive') /* the other slot is still open to people */
    expect(gate.stats.active).toBe(2)
  })

  it('serves a waiting agent before a waiting thumbnail', async () => {
    const gate = new RenderGate({ ...tuning, maxBackground: 2 })
    const first = await gate.acquire('interactive')
    await gate.acquire('interactive')
    const order: string[] = []
    void gate
      .acquire('background')
      .then(() => order.push('background'))
      .catch(() => {})
    void gate
      .acquire('interactive')
      .then(() => order.push('interactive'))
      .catch(() => {})
    await tick()

    first()
    await tick()
    expect(order).toEqual(['interactive'])
  })

  it('refuses when the queue is full, and when a slot does not free up in time', async () => {
    const gate = new RenderGate(tuning)
    await gate.acquire('interactive')
    await gate.acquire('interactive')
    const timedOut = gate.acquire('interactive')
    void gate.acquire('interactive').catch(() => {})

    await expect(gate.acquire('interactive')).rejects.toBeInstanceOf(RendererBusyError)
    await expect(timedOut).rejects.toThrow(/no render slot within 100ms/)
  })
})

describe('isBrowserFailure', () => {
  it('knows the errors a wedged browser throws', () => {
    const timeout = Object.assign(new Error('Timed out after waiting 30000ms'), { name: 'TimeoutError' })
    const protocol = Object.assign(
      new Error("Network.enable timed out. Increase the 'protocolTimeout' setting in launch/connect calls"),
      { name: 'ProtocolError' },
    )
    expect(isBrowserFailure(timeout)).toBe(true)
    expect(isBrowserFailure(protocol)).toBe(true)
    expect(isBrowserFailure(new RenderTimeoutError('rendering', 1))).toBe(true)
    expect(isBrowserFailure(new Error('Unable to capture screenshot'))).toBe(false)
    expect(isBrowserFailure(new RendererBusyError('full'))).toBe(false)
  })
})

describe('renderedHeight', () => {
  it('keeps ordinary frames whole and cuts runaway ones at the pixel budget', () => {
    expect(renderedHeight({ width: 1440, height: 900 }, 2)).toBe(900)
    expect(renderedHeight({ width: 1440, height: 900 }, 1, 400)).toBe(400)
    const tall = renderedHeight({ width: 1440, height: 40_000 }, 2)
    expect(tall).toBeLessThan(40_000)
    expect(1440 * 2 * tall * 2).toBeLessThanOrEqual(MAX_RENDER_PIXELS)
  })
})
