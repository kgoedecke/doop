import { env } from './env.ts'
import { fetchPinnedPublicUrl, parsePublicHttpUrl } from './publicUrl.ts'
import type { RequestInit as UndiciRequestInit } from 'undici'

/**
 * The only way a request reaches a custom provider. Every other model
 * transport talks to a fixed URL; this one's URL is whatever a person typed,
 * which makes it a server-side fetch target: an SSRF into whatever network
 * Doop runs on. So, unless the operator says the instance's own network is
 * fair game (DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS, for a self-hosted Doop whose
 * models run beside it):
 *
 *  - the URL must be https on a public host name or address;
 *  - the host is resolved once and the connection is pinned to the approved
 *    addresses, so a DNS answer that changes between check and connect (a
 *    rebind onto 127.0.0.1 or a cloud metadata address) cannot redirect it;
 *  - redirects are refused outright, since each hop would need the same
 *    checks and no API we speak to needs one.
 *
 * Responses are cut off past MAX_RESPONSE_BYTES whichever way they arrive,
 * so an endpoint that streams forever cannot fill the server's memory.
 */

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export class CustomProviderUrlError extends Error {}

export function customProvidersEnabled(): boolean {
  return env.DOOP_CUSTOM_PROVIDERS
}

function privateHostsAllowed(): boolean {
  return env.DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS
}

/** The URL if this server may send a request to it, before any network I/O;
 *  the public-address check on its resolved addresses happens per request. */
export function reachableUrl(raw: string | URL): URL {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    throw new CustomProviderUrlError('That base URL is not a valid URL')
  }
  if (privateHostsAllowed()) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new CustomProviderUrlError('The base URL must start with https:// or http://')
    }
    return url
  }
  if (url.protocol !== 'https:') {
    throw new CustomProviderUrlError('The base URL must start with https:// (this server only reaches public APIs)')
  }
  try {
    return parsePublicHttpUrl(url.href)
  } catch {
    throw new CustomProviderUrlError(
      'This server can only reach public APIs: that host is local or private. Self-hosted instances can allow private hosts (DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS).',
    )
  }
}

/** A fetch for custom-provider requests, shaped like the global one so it
 *  can be handed to the Anthropic SDK as its `fetch`. */
export async function customProviderFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = reachableUrl(input instanceof Request ? input.url : input)
  const options = { ...init, redirect: 'error' as const }
  let response: Response
  if (privateHostsAllowed()) {
    response = await fetch(url, options)
  } else {
    try {
      response = await fetchPinnedPublicUrl(url, options as Omit<UndiciRequestInit, 'dispatcher'>)
    } catch (error) {
      /* the resolved address was private: say so, rather than a bare
         "fetch failed" that sends the person debugging their endpoint */
      if (error instanceof Error && error.message === 'that host is not reachable from here') {
        throw new CustomProviderUrlError(
          'This server can only reach public APIs: that host resolves to a local or private address.',
        )
      }
      throw error
    }
  }
  return capped(response, MAX_RESPONSE_BYTES)
}

/** The response with its body cut off (as a stream error) past `max` bytes. */
function capped(response: Response, max: number): Response {
  /* a null-body status cannot be rebuilt with a stream */
  if (!response.body || [101, 204, 205, 304].includes(response.status)) return response
  let total = 0
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength
      if (total > max) controller.error(new Error('the provider’s response was too large'))
      else controller.enqueue(chunk)
    },
  })
  const headers = new Headers(response.headers)
  /* the body below is already decoded and may be cut short */
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(response.body.pipeThrough(limit), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
