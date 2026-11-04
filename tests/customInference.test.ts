import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const dnsMocks = vi.hoisted(() => ({ lookup: vi.fn() }))

vi.mock('node:dns/promises', () => ({ default: { lookup: dnsMocks.lookup } }))

import {
  CustomInferenceError,
  customEndpointUrl,
  fetchCustomJson,
  normalizeCustomBaseUrl,
  validateCustomBaseUrl,
} from '../server/customInference.ts'

/**
 * The custom inference boundary is the only place a user-supplied URL becomes
 * a server-side request. These tests pin the URL policy (scheme, credentials,
 * query strings, private targets) and the request safety rails (pinned DNS,
 * redirects refused, bounded response, stable error codes).
 */

const PUBLIC = [{ address: '93.184.216.34', family: 4 }]

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof CustomInferenceError ? error.code : undefined
  }
  return undefined
}

async function asyncCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
  } catch (error) {
    return error instanceof CustomInferenceError ? error.code : undefined
  }
  return undefined
}

beforeEach(() => {
  dnsMocks.lookup.mockReset()
  dnsMocks.lookup.mockImplementation(async (host: string) =>
    host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : PUBLIC,
  )
})

afterEach(unstubAllEnvs)

describe('normalizeCustomBaseUrl', () => {
  it('normalizes a bare HTTPS base URL to one path form without a trailing slash', () => {
    expect(normalizeCustomBaseUrl('https://provider.example/v1/').href).toBe('https://provider.example/v1')
    expect(normalizeCustomBaseUrl('  https://provider.example/v1/// ').href).toBe('https://provider.example/v1')
    expect(normalizeCustomBaseUrl('https://provider.example/').href).toBe('https://provider.example/')
  })

  it.each([
    '',
    'provider.example/v1',
    'ftp://provider.example/v1',
    'file:///etc/passwd',
    'https://user:secret@provider.example/v1',
    'https://provider.example/v1?key=secret',
    'https://provider.example/v1#fragment',
    'https:///v1',
    `https://provider.example/\u0000v1`,
  ])('rejects unusable base URL %j with invalid_url', (raw) => {
    expect(code(() => normalizeCustomBaseUrl(raw))).toBe('invalid_url')
  })
})

describe('validateCustomBaseUrl', () => {
  it('requires HTTPS for a public host', async () => {
    expect(await asyncCode(() => validateCustomBaseUrl('http://provider.example/v1', false))).toBe('url_insecure')
    await expect(validateCustomBaseUrl('https://provider.example/v1', false)).resolves.toEqual(
      new URL('https://provider.example/v1'),
    )
  })

  it.each([
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://10.1.2.3/v1',
    'https://192.168.1.2/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://[fd00::1]/v1',
  ])('blocks private target %s when private URLs are off', async (raw) => {
    expect(await asyncCode(() => validateCustomBaseUrl(raw, false))).toBe('private_url_blocked')
  })

  it('accepts loopback and private HTTP only with the operator opt-in', async () => {
    await expect(validateCustomBaseUrl('http://127.0.0.1:11434/v1', true)).resolves.toEqual(
      new URL('http://127.0.0.1:11434/v1'),
    )
    await expect(validateCustomBaseUrl('http://localhost:11434/v1', true)).resolves.toEqual(
      new URL('http://localhost:11434/v1'),
    )
  })

  it('still rejects public HTTP when private URLs are enabled', async () => {
    expect(await asyncCode(() => validateCustomBaseUrl('http://provider.example/v1', true))).toBe('url_insecure')
  })

  it('rejects a hostname when any DNS answer is blocked', async () => {
    dnsMocks.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    expect(await asyncCode(() => validateCustomBaseUrl('https://mixed.example/v1', false))).toBe('private_url_blocked')
    /* the operator opt-in is explicit: mixed answers are then allowed and pinned */
    await expect(validateCustomBaseUrl('https://mixed.example/v1', true)).resolves.toEqual(
      new URL('https://mixed.example/v1'),
    )
  })

  it('maps DNS failures to unreachable', async () => {
    dnsMocks.lookup.mockRejectedValue(new Error('ENOTFOUND'))
    expect(await asyncCode(() => validateCustomBaseUrl('https://missing.example/v1', false))).toBe('unreachable')
  })

  it('resolves again on the next request and blocks a host that moved to a private address', async () => {
    dnsMocks.lookup.mockResolvedValueOnce(PUBLIC)
    await expect(validateCustomBaseUrl('https://rebind.example/v1', false)).resolves.toEqual(
      new URL('https://rebind.example/v1'),
    )
    /* the same name now points at loopback: the save-time answer is never reused */
    dnsMocks.lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    expect(await asyncCode(() => validateCustomBaseUrl('https://rebind.example/v1', false))).toBe('private_url_blocked')
  })
})

describe('customEndpointUrl', () => {
  it.each([
    ['https://provider.example/v1', 'models', 'https://provider.example/v1/models'],
    ['https://provider.example/', 'models', 'https://provider.example/models'],
    ['https://provider.example/v1', 'chat/completions', 'https://provider.example/v1/chat/completions'],
    ['http://127.0.0.1:11434/v1', 'chat/completions', 'http://127.0.0.1:11434/v1/chat/completions'],
  ])('appends %s + %s without double slashes', (base, path, expected) => {
    expect(customEndpointUrl(new URL(base), path as 'models' | 'chat/completions').href).toBe(expected)
  })
})

describe('fetchCustomJson', () => {
  let provider: http.Server
  let base: string
  let mode: 'ok' | 'auth' | 'missing' | 'malformed' | 'oversized' | 'redirect' = 'ok'

  beforeAll(async () => {
    provider = http.createServer((req, res) => {
      const json = (status: number, body: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (new URL(req.url ?? '/', 'http://x').pathname.startsWith('/slow')) {
        setTimeout(() => json(200, { ok: true }), 200)
        return
      }
      if (mode === 'auth') return json(401, { error: 'no' })
      if (mode === 'missing') return json(404, { error: 'no' })
      if (mode === 'malformed') return res.writeHead(200, { 'content-type': 'application/json' }).end('{oops')
      if (mode === 'oversized')
        return res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ data: 'x'.repeat(5000) }))
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end()
        return
      }
      json(200, { ok: true, path: req.url })
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => provider.close(() => resolve())))

  beforeEach(() => {
    mode = 'ok'
    stubEnv('CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS', '1')
  })

  it('fetches through the pinned private address when the operator opted in', async () => {
    const url = customEndpointUrl(new URL(`${base}/v1`), 'models')
    await expect(fetchCustomJson(url, { method: 'GET' })).resolves.toEqual({ ok: true, path: '/v1/models' })
  })

  it('refuses private endpoints when the feature flag is off', async () => {
    stubEnv('CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS', 'false')
    const url = customEndpointUrl(new URL(`${base}/v1`), 'models')
    expect(await asyncCode(() => fetchCustomJson(url, { method: 'GET' }))).toBe('private_url_blocked')
  })

  it('maps authentication and missing routes to stable codes', async () => {
    const url = customEndpointUrl(new URL(`${base}/v1`), 'chat/completions')
    mode = 'auth'
    expect(await asyncCode(() => fetchCustomJson(url, { method: 'POST' }))).toBe('auth_failed')
    mode = 'missing'
    expect(await asyncCode(() => fetchCustomJson(url, { method: 'POST' }))).toBe('not_compatible')
  })

  it('rejects malformed and oversized successful bodies without echoing them', async () => {
    const url = customEndpointUrl(new URL(`${base}/v1`), 'models')
    mode = 'malformed'
    expect(await asyncCode(() => fetchCustomJson(url, { method: 'GET' }))).toBe('not_compatible')
    mode = 'oversized'
    expect(await asyncCode(() => fetchCustomJson(url, { method: 'GET' }, { maxBytes: 1024 }))).toBe('not_compatible')
  })

  it('refuses to follow a redirect to a private metadata target', async () => {
    mode = 'redirect'
    const url = customEndpointUrl(new URL(`${base}/v1`), 'models')
    expect(await asyncCode(() => fetchCustomJson(url, { method: 'GET' }))).toBe('not_compatible')
  })

  it('maps a timeout to unreachable', async () => {
    const url = customEndpointUrl(new URL(`${base}/slow`), 'models')
    expect(await asyncCode(() => fetchCustomJson(url, { method: 'GET' }, { timeoutMs: 20 }))).toBe('unreachable')
  })
})
