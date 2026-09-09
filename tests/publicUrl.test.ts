import type { Page } from 'puppeteer-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dnsMocks = vi.hoisted(() => ({ lookup: vi.fn() }))

vi.mock('node:dns/promises', () => ({ default: { lookup: dnsMocks.lookup } }))

import {
  assertPublicNetworkUrl,
  createPinnedLookup,
  guardPublicPageRequests,
  normalizePublicHttpUrl,
  parsePublicHttpUrl,
} from '../server/publicUrl.ts'

beforeEach(() => {
  dnsMocks.lookup.mockReset()
})

describe('public webpage URL validation', () => {
  it('normalizes bare domains while accepting ordinary public IPv4 and IPv6 URLs', () => {
    expect(normalizePublicHttpUrl('example.com/pricing').href).toBe('https://example.com/pricing')
    expect(parsePublicHttpUrl('https://8.8.8.8/').hostname).toBe('8.8.8.8')
    expect(parsePublicHttpUrl('https://[2606:4700:4700::1111]/').hostname).toBe('[2606:4700:4700::1111]')
  })

  it.each([
    'file:///etc/passwd',
    'https://user:password@example.com/',
    'http://localhost/',
    'http://localhost./',
    'http://service.internal./',
    'http://service/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.2/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
    'http://[fd00::1]/',
    'http://[fec0::1]/',
  ])('rejects non-public target %s', (raw) => {
    expect(() => parsePublicHttpUrl(raw)).toThrow()
  })

  it('rejects a hostname when a later resolution rebinds to a private address', async () => {
    dnsMocks.lookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])

    await expect(assertPublicNetworkUrl('https://rebind.example/')).resolves.toEqual(new URL('https://rebind.example/'))
    await expect(assertPublicNetworkUrl('https://rebind.example/')).rejects.toThrow('not reachable')
  })

  it('gives the network connector only the exact approved address', async () => {
    const lookup = createPinnedLookup('rebind.example', [{ address: '93.184.216.34', family: 4 }])
    const result = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      lookup('rebind.example', { all: false }, (error, address, family) => {
        if (error) reject(error)
        else resolve({ address: String(address), family })
      })
    })

    expect(result).toEqual({ address: '93.184.216.34', family: 4 })
    expect(() => createPinnedLookup('rebind.example', [{ address: '127.0.0.1', family: 4 }])).toThrow(
      'non-public address',
    )
  })
})

function pageHarness() {
  let onRequest: ((request: ReturnType<typeof requestStub>) => void) | undefined
  const client = { send: vi.fn().mockResolvedValue(undefined) }
  const page = {
    setBypassServiceWorker: vi.fn().mockResolvedValue(undefined),
    createCDPSession: vi.fn().mockResolvedValue(client),
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((_event: string, listener: (request: ReturnType<typeof requestStub>) => void) => {
      onRequest = listener
      return page
    }),
  }
  return {
    page: page as unknown as Page,
    client,
    dispatch: (request: ReturnType<typeof requestStub>) => onRequest?.(request),
  }
}

function requestStub(rawUrl: string, resourceType = 'document') {
  return {
    url: () => rawUrl,
    method: () => 'GET',
    headers: () => ({ accept: 'text/html', host: new URL(rawUrl).host, 'accept-encoding': 'gzip' }),
    hasPostData: () => false,
    fetchPostData: vi.fn().mockResolvedValue(undefined),
    resourceType: () => resourceType,
    continue: vi.fn().mockResolvedValue(undefined),
    respond: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  }
}

describe('public Chromium request guard', () => {
  it('fulfills external requests through the pinned fetcher instead of continuing them in Chromium', async () => {
    const headers = new Headers({
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': '17',
    })
    headers.append('set-cookie', 'first=1; Path=/')
    headers.append('set-cookie', 'second=2; Path=/')
    const fetchUrl = vi.fn(async () => new Response('<html>safe</html>', { status: 200, headers }))
    const harness = pageHarness()
    await guardPublicPageRequests(harness.page, { fetchUrl })
    const request = requestStub('https://rebind.example/')

    harness.dispatch(request)
    await vi.waitFor(() => expect(request.respond).toHaveBeenCalledOnce())

    expect(request.continue).not.toHaveBeenCalled()
    expect(harness.client.send).toHaveBeenCalledWith('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] })
    expect(fetchUrl).toHaveBeenCalledWith(
      'https://rebind.example/',
      expect.objectContaining({ redirect: 'manual', headers: { accept: 'text/html' } }),
    )
    const response = request.respond.mock.calls[0]![0]
    expect(response.headers).not.toHaveProperty('content-encoding')
    expect(response.headers).not.toHaveProperty('content-length')
    expect(response.headers['set-cookie']).toEqual(['first=1; Path=/', 'second=2; Path=/'])
    expect(response.headers['content-security-policy']).toContain("worker-src 'none'")
    expect(Buffer.from(response.body).toString()).toBe('<html>safe</html>')
  })

  it('aborts invalid external URLs before fetching them', async () => {
    const fetchUrl = vi.fn()
    const harness = pageHarness()
    await guardPublicPageRequests(harness.page, { fetchUrl })
    const request = requestStub('https://user:secret@example.com/')

    harness.dispatch(request)
    await vi.waitFor(() => expect(request.abort).toHaveBeenCalledOnce())

    expect(fetchUrl).not.toHaveBeenCalled()
    expect(request.continue).not.toHaveBeenCalled()
  })

  it('continues only an explicitly trusted local asset URL directly in Chromium', async () => {
    const fetchUrl = vi.fn()
    const harness = pageHarness()
    await guardPublicPageRequests(harness.page, {
      fetchUrl,
      allowUrl: (url) => url.origin === 'http://localhost:4400' && url.pathname.startsWith('/a/'),
    })
    const request = requestStub('http://localhost:4400/a/saved-image.png', 'image')

    harness.dispatch(request)
    await vi.waitFor(() => expect(request.continue).toHaveBeenCalledOnce())

    expect(fetchUrl).not.toHaveBeenCalled()
    expect(request.respond).not.toHaveBeenCalled()
  })
})
