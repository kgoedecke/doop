import dns from 'node:dns/promises'
import net from 'node:net'
import type { LookupFunction } from 'node:net'
import type { Page } from 'puppeteer-core'
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'

export interface PublicAddress {
  address: string
  family: 4 | 6
}

interface ResolvedPublicUrl {
  url: URL
  addresses: PublicAddress[]
}

const blockedIpv4 = new net.BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4')
}
const blockedIpv6 = new net.BlockList()
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6')
}

function isPrivateIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, '')
  const family = net.isIP(ip)
  if (family === 0) return true
  return family === 4 ? blockedIpv4.check(ip, 'ipv4') : blockedIpv6.check(ip, 'ipv6')
}

/** Parse a fully-qualified public HTTP(S) URL without performing network I/O. */
export function parsePublicHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs are allowed')
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const ipHost = host.replace(/^\[|\]$/g, '')
  const isIp = net.isIP(ipHost) !== 0
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (!isIp && !host.includes('.')) ||
    (isIp && isPrivateIp(ipHost))
  ) {
    throw new Error('that host is not reachable from here')
  }
  return url
}

/** Agent tools accept a convenient bare domain and default it to HTTPS. */
export function normalizePublicHttpUrl(raw: string): URL {
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  return parsePublicHttpUrl(value)
}

/** Resolve the host before a server-side request so public-looking names cannot
 *  reach loopback, link-local, or private infrastructure. */
export async function assertPublicNetworkUrl(raw: string | URL): Promise<URL> {
  return (await resolvePublicNetworkUrl(raw)).url
}

/** Resolve and retain the approved addresses so the subsequent connection can
 * use exactly those IPs instead of performing a second, rebindable lookup. */
async function resolvePublicNetworkUrl(raw: string | URL): Promise<ResolvedPublicUrl> {
  const url = parsePublicHttpUrl(String(raw))
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = net.isIP(host)
  const addresses: PublicAddress[] = literalFamily
    ? [{ address: host, family: literalFamily as 4 | 6 }]
    : ((await dns.lookup(host, { all: true, verbatim: true })) as PublicAddress[])
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('that host is not reachable from here')
  }
  return { url, addresses }
}

export function createPinnedLookup(expectedHost: string, addresses: PublicAddress[]): LookupFunction {
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('cannot pin a non-public address')
  }
  return (hostname, options, callback) => {
    if (hostname.toLowerCase().replace(/\.$/, '') !== expectedHost.toLowerCase().replace(/\.$/, '')) {
      const error = Object.assign(new Error('unexpected hostname during pinned request'), { code: 'ENOTFOUND' })
      callback(error, '', 0)
      return
    }
    const family = typeof options === 'number' ? options : options.family
    const candidates =
      family === 4 || family === 6 ? addresses.filter((address) => address.family === family) : addresses
    const first = candidates[0]
    if (!first) {
      const error = Object.assign(new Error('no approved address for requested family'), { code: 'ENOTFOUND' })
      callback(error, '', 0)
      return
    }
    if (typeof options === 'object' && options.all) callback(null, candidates)
    else callback(null, first.address, first.family)
  }
}

async function fetchResolvedPublicUrl(
  resolved: ResolvedPublicUrl,
  init: Omit<UndiciRequestInit, 'dispatcher'> = {},
): Promise<Response> {
  const dispatcher = new Agent({
    connect: { lookup: createPinnedLookup(resolved.url.hostname.replace(/^\[|\]$/g, ''), resolved.addresses) },
    connections: 1,
    pipelining: 0,
  })
  try {
    const response = await undiciFetch(resolved.url, { ...init, dispatcher })
    /* Graceful close waits for the returned body to be consumed, then drops
       the one-request pool instead of caching attacker-selected origins. */
    void dispatcher.close()
    return response as unknown as Response
  } catch (error) {
    await dispatcher.close().catch(() => {})
    throw error
  }
}

/** Fetch a public URL through a connection whose DNS result is pinned for the
 * request. Redirects stay manual so callers can repeat validation per hop. */
export async function fetchPinnedPublicUrl(
  raw: string | URL,
  init: Omit<UndiciRequestInit, 'dispatcher'> = {},
): Promise<Response> {
  return fetchResolvedPublicUrl(await resolvePublicNetworkUrl(raw), { ...init, redirect: init.redirect ?? 'manual' })
}

const MAX_BROWSER_RESOURCE_BYTES = 10_000_000
const MAX_BROWSER_PAGE_BYTES = 50_000_000

async function readBodyBounded(
  response: Response,
  maxBytes: number,
  accountChunk?: (bytes: number) => void,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new Error('remote resource is too large')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error('remote resource is too large')
    }
    try {
      accountChunk?.(value.byteLength)
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function forwardedRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const blocked = new Set(['accept-encoding', 'connection', 'content-length', 'host', 'proxy-authorization', 'upgrade'])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())))
}

function browserResponseHeaders(response: Response, document: boolean): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, name) => {
    if (
      !['connection', 'content-encoding', 'content-length', 'set-cookie', 'transfer-encoding'].includes(
        name.toLowerCase(),
      )
    ) {
      headers[name] = value
    }
  })
  const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  if (cookies.length) headers['set-cookie'] = cookies
  if (document && /html|xhtml/i.test(response.headers.get('content-type') ?? '')) {
    /* HTTP fetch/XHR stays usable and is pinned by interception. Transports
       that cannot be fulfilled through request.respond remain disabled. */
    const networkPolicy = "frame-src 'none'; object-src 'none'; worker-src 'none'"
    const originalPolicy = headers['content-security-policy']
    headers['content-security-policy'] = originalPolicy ? [String(originalPolicy), networkPolicy] : networkPolicy
  }
  return headers
}

/** Chromium requests are fulfilled through pinned Node connections. Merely
 * validating and then calling request.continue() would let Chromium resolve an
 * attacker-controlled hostname again after a DNS rebind. */
export async function guardPublicPageRequests(
  page: Page,
  options: {
    allowUrl?: (url: URL) => boolean
    fetchUrl?: typeof fetchPinnedPublicUrl
  } = {},
): Promise<void> {
  const fetchUrl = options.fetchUrl ?? fetchPinnedPublicUrl
  let pageBytes = 0
  await page.setBypassServiceWorker(true)
  const client = await page.createCDPSession()
  await client.send('Network.enable')
  await client.send('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] })
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    void (async () => {
      const raw = request.url()
      if (!/^https?:/i.test(raw)) {
        if (/^(?:about|blob|data):/i.test(raw)) await request.continue().catch(() => {})
        else await request.abort('blockedbyclient').catch(() => {})
        return
      }
      try {
        const requested = new URL(raw)
        if (options.allowUrl?.(requested)) {
          await request.continue()
          return
        }
        parsePublicHttpUrl(raw)
        const method = request.method().toUpperCase()
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
          throw new Error('unsupported browser request method')
        }
        const postData = request.hasPostData() ? await request.fetchPostData() : undefined
        if (postData && Buffer.byteLength(postData) > 1_000_000) throw new Error('browser request body is too large')
        const response = await fetchUrl(raw, {
          method,
          headers: forwardedRequestHeaders(request.headers()),
          ...(postData !== undefined ? { body: postData } : {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(20_000),
        })
        const body =
          method === 'HEAD' || response.status === 204 || response.status === 304
            ? Buffer.alloc(0)
            : await readBodyBounded(response, MAX_BROWSER_RESOURCE_BYTES, (bytes) => {
                /* Async handlers resume one at a time, so charging each chunk
                   before buffering it keeps the aggregate limit race-free. */
                if (pageBytes + bytes > MAX_BROWSER_PAGE_BYTES) {
                  throw new Error('website resource budget exceeded')
                }
                pageBytes += bytes
              })
        await request.respond({
          status: response.status,
          headers: browserResponseHeaders(response, request.resourceType() === 'document'),
          contentType: response.headers.get('content-type') ?? undefined,
          body,
        })
      } catch {
        await request.abort('blockedbyclient').catch(() => {})
      }
    })()
  })
}
