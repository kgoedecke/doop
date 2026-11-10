import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

/* The hosted server's one long-lived Chromium has stopped creating pages
   while still counting as connected. These tests drive the renderer against
   fake browsers that stall the way that one did. */

const launches = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('puppeteer-core', () => ({ default: { launch: launches.launch } }))
vi.mock('../server/env.ts', () => ({
  env: { CHROME_PATH: '/bin/sh', BETTER_AUTH_URL: 'http://localhost:4400', CHROME_NO_SANDBOX: false },
  windowsBrowserDirectories: () => [],
}))
vi.mock('../server/publicUrl.ts', () => ({ guardPublicPageRequests: async () => {} }))

const frame = { id: 'f1', canvasId: 'c1', name: 'Hero', width: 320, height: 200, html: '<p>hi</p>' } as Frame
const never = () => new Promise<never>(() => {})

interface FakePage {
  setViewport: () => Promise<void>
  setContent: () => Promise<void>
  screenshot: () => Promise<Buffer>
  evaluate: () => Promise<unknown>
}

interface FakeBrowser {
  connected: boolean
  page: FakePage
  version: () => Promise<string>
  createBrowserContext: () => Promise<unknown>
  close: ReturnType<typeof vi.fn>
  process: () => null
}

function healthyBrowser(png = 'png'): FakeBrowser {
  const page: FakePage = {
    setViewport: async () => {},
    setContent: async () => {},
    screenshot: async () => Buffer.from(png),
    evaluate: async () => ({}),
  }
  const context = { newPage: async () => page, close: async () => {} }
  return {
    connected: true,
    page,
    version: async () => 'HeadlessChrome/1',
    createBrowserContext: async () => context,
    close: vi.fn(async () => {}),
    process: () => null,
  }
}

/** connected, answers the ping, but never produces a page */
function wedgedBrowser(): FakeBrowser {
  const browser = healthyBrowser()
  browser.createBrowserContext = never
  return browser
}

async function loadRenderer() {
  const mod = await import('../server/screenshot.ts')
  mod.renderTuning.renderTimeoutMs = 400
  mod.renderTuning.pingTimeoutMs = 30
  mod.renderTuning.closeTimeoutMs = 30
  return mod
}

beforeEach(() => {
  vi.resetModules()
  launches.launch.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('renderFrame against a wedged Chromium', () => {
  it('kills the browser that stalls on page creation and renders on a fresh launch', async () => {
    const stuck = wedgedBrowser()
    const fresh = healthyBrowser('fresh')
    launches.launch.mockResolvedValueOnce(stuck).mockResolvedValueOnce(fresh)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { renderFrame } = await loadRenderer()

    const png = await renderFrame(frame)

    expect(png.toString()).toBe('fresh')
    expect(launches.launch).toHaveBeenCalledTimes(2)
    expect(stuck.close).toHaveBeenCalled()
    expect(fresh.close).not.toHaveBeenCalled()
  })

  it('reports a timeout when the relaunch stalls too, instead of hanging', async () => {
    launches.launch.mockResolvedValueOnce(wedgedBrowser()).mockResolvedValueOnce(wedgedBrowser())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { renderFrame } = await loadRenderer()

    await expect(renderFrame(frame)).rejects.toThrow(/did not finish within/)
    expect(launches.launch).toHaveBeenCalledTimes(2)
  })

  it('replaces a cached browser that no longer answers before handing it out', async () => {
    const first = healthyBrowser('first')
    const second = healthyBrowser('second')
    launches.launch.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const { renderFrame } = await loadRenderer()

    expect((await renderFrame(frame)).toString()).toBe('first')
    first.version = never

    expect((await renderFrame(frame)).toString()).toBe('second')
    expect(first.close).toHaveBeenCalled()
    expect(launches.launch).toHaveBeenCalledTimes(2)
  })

  it('does not relaunch for a failure that is the frame’s own', async () => {
    const browser = healthyBrowser()
    browser.page.screenshot = async () => {
      throw new Error('Unable to capture screenshot: image too large')
    }
    launches.launch.mockResolvedValue(browser)
    const { renderFrame } = await loadRenderer()

    await expect(renderFrame(frame)).rejects.toThrow(/too large/)
    expect(launches.launch).toHaveBeenCalledTimes(1)
    expect(browser.close).not.toHaveBeenCalled()
  })
})
