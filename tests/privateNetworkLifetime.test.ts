import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { HTTPRequest, Page } from 'puppeteer-core'
const browserMock = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('puppeteer-core', () => ({ default: browserMock }))
import { openIsolatedPage } from '../server/screenshot.ts'
import { guardPublicPageRequests } from '../server/publicUrl.ts'

function pageHarness() {
  return Object.assign(new EventEmitter(), {
    setBypassServiceWorker: vi.fn(async () => {}),
    createCDPSession: vi.fn(async () => ({ send: vi.fn(async () => {}) })),
    setRequestInterception: vi.fn(async () => {}),
  }) as unknown as Page
}

function request() {
  return {
    url: () => 'https://held.example/media',
    method: () => 'GET',
    headers: () => ({ Cookie: 'ambient-cookie', Authorization: 'ambient-auth', 'Proxy-Authorization': 'proxy-auth' }),
    hasPostData: () => false,
    resourceType: () => 'image',
    continue: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    respond: vi.fn(async (_response: unknown) => {}),
  }
}

const privateResources = () => ({
  beginRequest: vi.fn(),
  accountChunk: vi.fn(),
  validateResponse: vi.fn(async () => {}),
})

it('actual context admission waits for held signal-ignoring HTTP leaves after browser close', async () => {
  const contexts: { page: Page; close: ReturnType<typeof vi.fn> }[] = []
  const createBrowserContext = vi.fn(async () => {
    const context = { page: pageHarness(), close: vi.fn(async () => {}), newPage: async () => context.page }
    contexts.push(context)
    return context
  })
  browserMock.launch.mockResolvedValue({ connected: true, createBrowserContext })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetchUrl = vi.fn(async () => {
    await held
    return new Response('held body', { headers: { 'content-type': 'image/png' } })
  })
  const isolated = await Promise.all(Array.from({ length: 4 }, () => openIsolatedPage()))
  const requests = isolated.map(() => request())
  const closings: Promise<void>[] = []
  let next: ReturnType<typeof openIsolatedPage> | undefined
  try {
    for (const [index, loaded] of isolated.entries()) {
      loaded.ownRequests(await guardPublicPageRequests(loaded.page, { fetchUrl, privateResources: privateResources() }))
      loaded.page.emit('request', requests[index] as unknown as HTTPRequest)
    }
    await vi.waitFor(() => expect(fetchUrl).toHaveBeenCalledTimes(4))
    for (const loaded of isolated) {
      loaded.cancel()
      const closing = loaded.close()
      expect(loaded.close()).toBe(closing)
      closings.push(closing)
    }
    await vi.waitFor(() => expect(contexts.every((context) => context.close.mock.calls.length === 1)).toBe(true))
    next = openIsolatedPage()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(createBrowserContext).toHaveBeenCalledTimes(4)
    release()
    await Promise.all(closings)
    const fresh = await next
    expect(createBrowserContext).toHaveBeenCalledTimes(5)
    expect(requests.every((value) => value.respond.mock.calls.length === 0)).toBe(true)
    await fresh.close()
  } finally {
    release()
    await Promise.allSettled(isolated.map((loaded) => loaded.close()))
    if (next) await (await next).close()
  }
})

it('private requests strip ambient credentials and wait for validation before fulfillment', async () => {
  const page = pageHarness()
  const resources = privateResources()
  let release!: () => void
  resources.validateResponse.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const fetchUrl = vi.fn(
    async () => new Response('validated', { headers: { 'content-type': 'image/png', 'set-cookie': 'remote=1' } }),
  )
  const session = await guardPublicPageRequests(page, { fetchUrl, privateResources: resources })
  const received = request()
  page.emit('request', received as unknown as HTTPRequest)
  try {
    await vi.waitFor(() => expect(resources.validateResponse).toHaveBeenCalledOnce())
    expect(received.respond).not.toHaveBeenCalled()
    expect(fetchUrl).toHaveBeenCalledWith('https://held.example/media', expect.objectContaining({ headers: {} }))
    release()
    await session.settle()
    expect(received.respond).toHaveBeenCalledOnce()
    const response = received.respond.mock.calls[0]![0] as { headers: Record<string, string> }
    expect(response.headers).not.toHaveProperty('set-cookie')
  } finally {
    release?.()
    await session.cancelAndDrain()
  }
})

it('the 65th private request is a sticky failure rather than a successful partial page', async () => {
  const page = pageHarness()
  const fetchUrl = vi.fn(async () => new Response('unused'))
  const session = await guardPublicPageRequests(page, { fetchUrl, privateResources: privateResources() })
  for (let at = 0; at < 65; at++) page.emit('request', request() as unknown as HTTPRequest)
  await expect(session.settle()).rejects.toMatchObject({ kind: 'limit' })
  expect(fetchUrl).not.toHaveBeenCalled()
  await session.cancelAndDrain()
})
