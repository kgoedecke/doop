import dns from 'node:dns/promises'
import net from 'node:net'
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { env } from './env.ts'
import { createPinnedLookup, isBlockedIp, type PublicAddress } from './publicUrl.ts'

/**
 * The custom-inference boundary: everything a user-supplied OpenAI-compatible
 * endpoint touches goes through here. A base URL is normalized once, then
 * every outbound request resolves it again and pins that resolution for the
 * life of the connection. Validation is deliberately policy-driven rather
 * than provider-driven: public endpoints must be HTTPS, while private targets
 * are only reachable on a self-host that explicitly opts in.
 */

export type CustomInferenceErrorCode =
  'invalid_url' | 'url_insecure' | 'private_url_blocked' | 'unreachable' | 'auth_failed' | 'not_compatible'

export class CustomInferenceError extends Error {
  constructor(
    readonly code: CustomInferenceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CustomInferenceError'
  }
}

const INVALID_MESSAGE = 'Enter a valid HTTP(S) base URL without credentials, a query string, or a fragment.'
const INSECURE_MESSAGE = 'Public custom endpoints must use HTTPS.'
const BLOCKED_MESSAGE = 'This endpoint is on a private network. The operator must enable private custom endpoints.'
const UNREACHABLE_MESSAGE = 'The custom endpoint could not be reached.'
const AUTH_MESSAGE = 'The custom endpoint rejected the API key.'
const COMPAT_MESSAGE = 'The custom endpoint did not return an OpenAI-compatible response.'

const DEFAULT_MAX_BYTES = 2_000_000
const DEFAULT_TIMEOUT_MS = 8_000

function invalid(): never {
  throw new CustomInferenceError('invalid_url', INVALID_MESSAGE)
}

/** Syntactic normalization only: absolute HTTP(S), no credentials/query/hash,
 *  and a path without a trailing slash so endpoint paths append cleanly. */
export function normalizeCustomBaseUrl(raw: string): URL {
  const value = raw.trim()
  if (!value || [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) invalid()
  /* `https:///v1` parses as the single-label host "v1"; an empty authority
     after the scheme is a typo, not an intranet name. */
  if (/^[a-z][a-z0-9+.-]*:\/\/\//i.test(value)) invalid()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalid()
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid()
  if (!url.hostname || url.username || url.password || url.search || url.hash) invalid()
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path || '/'
  return url
}

interface ResolvedCustomUrl {
  url: URL
  addresses: PublicAddress[]
  allowPrivate: boolean
}

/** Resolve and apply the network policy again on every call. A save-time
 *  check is not enough: a hostname can point somewhere else a minute later. */
async function resolveWithPolicy(url: URL, allowPrivate: boolean): Promise<ResolvedCustomUrl> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literal = net.isIP(host)
  let addresses: PublicAddress[]
  try {
    addresses = literal
      ? [{ address: host, family: literal as 4 | 6 }]
      : ((await dns.lookup(host, { all: true, verbatim: true })) as PublicAddress[])
  } catch {
    throw new CustomInferenceError('unreachable', UNREACHABLE_MESSAGE)
  }
  if (!addresses.length) throw new CustomInferenceError('unreachable', UNREACHABLE_MESSAGE)
  const privateTarget = addresses.some(({ address }) => isBlockedIp(address))
  if (privateTarget && !allowPrivate) throw new CustomInferenceError('private_url_blocked', BLOCKED_MESSAGE)
  if (url.protocol !== 'https:' && !privateTarget) throw new CustomInferenceError('url_insecure', INSECURE_MESSAGE)
  return { url, addresses, allowPrivate }
}

async function resolveCustomUrl(raw: URL): Promise<ResolvedCustomUrl> {
  return resolveWithPolicy(normalizeCustomBaseUrl(raw.href), env.CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS)
}

/** Normalize a base URL and verify it may be contacted from this server. */
export async function validateCustomBaseUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  const url = normalizeCustomBaseUrl(raw)
  await resolveWithPolicy(url, allowPrivate)
  return url
}

export function customEndpointUrl(baseUrl: URL, path: 'models' | 'chat/completions'): URL {
  const url = new URL(baseUrl.href)
  const base = url.pathname.replace(/\/+$/, '')
  url.pathname = `${base}/${path}`.replace(/\/{2,}/g, '/')
  return url
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new CustomInferenceError('not_compatible', COMPAT_MESSAGE)
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new CustomInferenceError('not_compatible', COMPAT_MESSAGE)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * The safe request helper: validates and resolves the URL, pins that DNS
 * answer for this one connection, refuses redirects, applies a bounded
 * timeout, bounds the response body, and maps everything to the stable codes
 * the settings UI understands. Response bodies and headers never enter an
 * error message.
 */
export async function fetchCustomJson(
  url: URL,
  init: RequestInit,
  options: { maxBytes?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  const resolved = await resolveCustomUrl(url)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const dispatcher = new Agent({
    connect: {
      lookup: createPinnedLookup(resolved.url.hostname.replace(/^\[|\]$/g, ''), resolved.addresses, {
        allowPrivate: resolved.allowPrivate,
      }),
    },
    connections: 1,
    pipelining: 0,
  })
  let response: Response
  try {
    response = (await undiciFetch(resolved.url, {
      ...(init as UndiciRequestInit),
      redirect: 'error',
      signal,
      dispatcher,
    })) as unknown as Response
  } catch (error) {
    await dispatcher.close().catch(() => {})
    if (error instanceof CustomInferenceError) throw error
    /* a stopped task is not an endpoint failure: hand the caller its abort */
    if (options.signal?.aborted) throw options.signal.reason ?? error
    /* `redirect: 'error'` surfaces as a fetch failure; it is a compatibility
       problem, not a network one, and the target is never followed. */
    const detail = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : ''
    if (/redirect/i.test(detail)) throw new CustomInferenceError('not_compatible', COMPAT_MESSAGE)
    throw new CustomInferenceError('unreachable', UNREACHABLE_MESSAGE)
  }
  try {
    if (response.status === 401 || response.status === 403) throw new CustomInferenceError('auth_failed', AUTH_MESSAGE)
    if (!response.ok) throw new CustomInferenceError('not_compatible', COMPAT_MESSAGE)
    const body = await readBounded(response, options.maxBytes ?? DEFAULT_MAX_BYTES)
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown
    } catch {
      throw new CustomInferenceError('not_compatible', COMPAT_MESSAGE)
    }
  } catch (error) {
    if (error instanceof CustomInferenceError) throw error
    if (options.signal?.aborted) throw options.signal.reason ?? error
    throw new CustomInferenceError('unreachable', UNREACHABLE_MESSAGE)
  } finally {
    /* Graceful close waits for the returned body to be consumed, then drops
       the one-request pool instead of caching a user-selected origin. */
    void dispatcher.close()
  }
}
