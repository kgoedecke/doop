import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import type { Browser, Page, HTTPRequest } from 'puppeteer-core'
import { findBrowserPath, getBrowser } from '../server/screenshot.ts'

type ReplayEvent = { type: number; data: { isAttachIframe?: boolean } }
declare global {
  interface Window {
    events: ReplayEvent[]
    messages: { type: string; html?: string }[]
    testReady: boolean
    startReplay: (privacy?: Record<string, unknown>) => void
    stopReplay: () => void
    snapshot: () => void
    renderReplay: (events: ReplayEvent[]) => void
    addFrame: () => void
  }
}

// DOM emulators do not enforce opaque origins or exercise rrweb's real bridge.
describe.skipIf(!findBrowserPath())('sandboxed frame replay', () => {
  let server: ViteDevServer
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    server = await createServer({
      server: { port: 0 },
      optimizeDeps: { include: ['posthog-js/dist/posthog-recorder', 'posthog-js/dist/rrweb'] },
      logLevel: 'error',
    })
    await server.listen()
    browser = await getBrowser()
    page = await browser.newPage()
    await page.goto(`${server.resolvedUrls!.local[0]}tests/fixtures/frameReplay.html`)
    await page.waitForFunction(() => window.testReady && window.messages.some((m) => m.type === 'doop:frame-ready'))
  }, 60_000)
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await server?.close()
  })

  async function render(html: string, index = 0) {
    await page.evaluate(
      (html, index) => {
        document.querySelectorAll('iframe')[index]!.contentWindow!.postMessage({ type: 'doop:html', html }, '*')
      },
      html,
      index,
    )
  }
  async function captured(text: string) {
    await page.waitForFunction((text) => JSON.stringify(window.events).includes(text), {}, text)
  }

  it('captures rendered content and mutations while preserving the sandbox and masking', async () => {
    await render('<h1>Initial design</h1>')
    // Hold the recorder download while a design streams in. The frame's
    // script activation pass must leave the loader and its onload intact.
    await page.setRequestInterception(true)
    let release!: (request: HTTPRequest) => void
    const download = new Promise<HTTPRequest>((resolve) => {
      release = resolve
    })
    let attempts = 0
    const onRequest = (request: HTTPRequest) => {
      if (new URL(request.url()).pathname.endsWith('/dist/recorder.js')) {
        attempts++
        if (attempts === 1) void request.abort('failed')
        else release(request)
      } else void request.continue()
    }
    page.on('request', onRequest)
    await page.evaluate(() => window.startReplay())
    const request = await download
    await render('<h1>Initial design while loading</h1>')
    const child = page.frames().find((f) => f !== page.mainFrame())!
    await child.waitForFunction(() => document.querySelector('h1')?.textContent === 'Initial design while loading')
    // Save while the loader is pending. Even a design-owned script carrying
    // the same attribute must survive and retain its normal execution behavior.
    await child.evaluate(() => {
      const content = document.createElement('div')
      content.setAttribute('data-doop-replay', '')
      content.textContent = 'Preserve design content'
      document.body.appendChild(content)
      const script = document.createElement('script')
      script.setAttribute('data-doop-replay', '')
      script.textContent = 'window.designScriptRan = true'
      document.body.appendChild(script)
    })
    await page.evaluate(() => {
      const target = document.querySelector('iframe')!.contentWindow!
      target.postMessage({ type: 'doop:edit', on: true }, '*')
      target.postMessage({ type: 'doop:edit', on: false }, '*')
    })
    await page.waitForFunction(() => window.messages.some((m) => m.type === 'doop:edited'))
    const saved = await page.evaluate(() => window.messages.find((m) => m.type === 'doop:edited')!.html)
    expect(saved).toContain('<div data-doop-replay="">Preserve design content</div>')
    expect(saved).toContain('<script data-doop-replay="">window.designScriptRan = true</script>')
    expect(saved).not.toContain('/dist/recorder.js')
    await page.evaluate(() => {
      window.messages = window.messages.filter((m) => m.type !== 'doop:edited')
    })
    await request.continue()
    await captured('Initial design while loading')
    expect(attempts).toBe(2)
    page.off('request', onRequest)
    await page.setRequestInterception(false)
    expect(await page.evaluate(() => document.querySelector('iframe')!.contentDocument)).toBeNull()
    await render(
      '<h1>Streamed design</h1><input type="password" value="password-secret"><input type="email" value="email-secret@example.com"><p class="ph-mask">masked-secret</p><p class="ph-no-capture">blocked-secret</p>',
    )
    await captured('Streamed design')
    const events = await page.evaluate(() => JSON.stringify(window.events))
    for (const secret of ['password-secret', 'email-secret', 'masked-secret', 'blocked-secret']) {
      expect(events).not.toContain(secret)
    }
    expect(await page.evaluate(() => window.events.some((e) => e.data?.isAttachIframe))).toBe(true)
  })

  it('renders the captured frame content in the actual replay player', async () => {
    const events = await page.evaluate(() => window.events)
    const replay = await browser.newPage()
    try {
      await replay.goto(`${server.resolvedUrls!.local[0]}tests/fixtures/frameReplay.html`)
      await replay.waitForFunction(() => window.testReady)
      await replay.evaluate((events) => window.renderReplay(events), events)
      await replay.waitForFunction(() => {
        const outer = document.querySelector('iframe')?.contentDocument
        return outer
          ?.querySelector<HTMLIFrameElement>('iframe[data-doop-frame]')
          ?.contentDocument?.body.textContent?.includes('Streamed design')
      })
    } finally {
      await replay.close()
      await page.bringToFront()
    }
  })

  it('keeps recording infrastructure out of saved frame HTML', async () => {
    await page.evaluate(() => {
      const target = document.querySelector('iframe')!.contentWindow!
      target.postMessage({ type: 'doop:edit', on: true }, '*')
      target.postMessage({ type: 'doop:edit', on: false }, '*')
    })
    await page.waitForFunction(() => window.messages.some((m) => m.type === 'doop:edited'))
    const html = await page.evaluate(() => window.messages.find((m) => m.type === 'doop:edited')!.html)
    expect(html).toContain('Streamed design')
    expect(html).not.toContain('data-doop-replay')
    expect(html).not.toContain('data-v-boot')
    expect(html).not.toContain('__PosthogExtensions__')
  })

  it('reattaches existing frames after parent checkouts and records frames mounted later', async () => {
    await page.evaluate(() => {
      window.events = []
      window.snapshot()
    })
    await captured('Streamed design')
    await page.evaluate(() => window.addFrame())
    await page.waitForFunction(() => window.messages.filter((m) => m.type === 'doop:frame-ready').length === 2)
    await render('<h1>Presentation frame</h1>', 1)
    await captured('Presentation frame')
  })

  it('stops child recording, resumes with current content, and applies updated privacy settings', async () => {
    await page.evaluate(() => window.stopReplay())
    await page.evaluate(() => {
      window.messages = []
      window.events = []
    })
    await render('<h1>While stopped</h1>')
    const child = page.frames().find((f) => f !== page.mainFrame())!
    await child.waitForFunction(() => document.body.textContent === 'While stopped')
    expect(await page.evaluate(() => window.messages.filter((m) => m.type === 'rrweb'))).toEqual([])
    await page.evaluate(() => window.startReplay({ maskTextSelector: 'h1' }))
    await page.waitForFunction(() => window.events.some((e) => e.data?.isAttachIframe))
    expect(await page.evaluate(() => JSON.stringify(window.events))).not.toContain('While stopped')
    await render('<p>Resumed design</p>')
    await captured('Resumed design')
  })

  it('bounds failed downloads and cancels pending retries when recording stops', async () => {
    await page.reload()
    await page.waitForFunction(() => window.testReady && window.messages.some((m) => m.type === 'doop:frame-ready'))
    await page.setRequestInterception(true)
    let attempts = 0
    const onRequest = (request: HTTPRequest) => {
      if (new URL(request.url()).pathname.endsWith('/dist/recorder.js')) {
        attempts++
        void request.abort('failed')
      } else void request.continue()
    }
    page.on('request', onRequest)
    try {
      await page.evaluate(() => window.startReplay())
      await vi.waitFor(() => expect(attempts).toBe(3), { timeout: 3000 })
      // Checkpoints must not bypass an exhausted retry budget.
      await page.evaluate(() => window.snapshot())
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1100)))
      expect(attempts).toBe(3)

      await page.evaluate(() => {
        window.stopReplay()
        window.startReplay()
      })
      await vi.waitFor(() => expect(attempts).toBe(4))
      const child = page.frames().find((f) => f !== page.mainFrame())!
      await child.waitForFunction(() => !document.querySelector('script[data-doop-replay]'))
      await page.evaluate(() => window.stopReplay())
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)))
      expect(attempts).toBe(4)
      expect(await page.evaluate(() => window.messages.filter((m) => m.type === 'rrweb'))).toEqual([])
    } finally {
      page.off('request', onRequest)
      await page.setRequestInterception(false)
    }
  })
})
