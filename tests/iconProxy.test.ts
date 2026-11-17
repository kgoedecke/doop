import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

/* the bucket, in memory: what one test stores the next must not find on disk */
const bucket = new Map<string, Buffer>()
vi.mock('../server/storage.ts', () => ({
  getObject: async (key: string) => bucket.get(key) ?? null,
  putObject: async (key: string, body: Buffer) => void bucket.set(key, body),
}))

const { env } = await import('../server/env')
const { searchIcons } = await import('../server/imageSearch')
const { hostedIconSvg, serveIcon, upstreamFor, withHostedIcons } = await import('../server/iconProxy')

/**
 * search_icons' icons come from Doop's origin: a frame hotlinking api.iconify.design rendered
 * blank in screenshots on and off, while Doop's own assets always loaded.
 */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>'

function svgResponse(body = SVG, status = 200, type = 'image/svg+xml; charset=utf-8') {
  return new Response(status === 200 ? body : null, { status, headers: { 'content-type': type } })
}

function call(prefix: string, file: string, query: Record<string, string> = {}) {
  const headers: Record<string, string> = {}
  const result: { status: number; body?: Buffer; headers: Record<string, string> } = { status: 200, headers }
  const res = {
    set: (name: string, value: string) => (headers[name] = value),
    status: (code: number) => ((result.status = code), res),
    end: () => res,
    send: (body: Buffer) => ((result.body = body), res),
  }
  const req = { params: { prefix, file }, query }
  return serveIcon(req as unknown as Request, res as unknown as Response).then(() => result)
}

afterEach(() => {
  vi.unstubAllGlobals()
  bucket.clear()
})

describe('icons from Doop', () => {
  it('hands agents a Doop URL from search_icons', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ icons: ['lucide:home', 'mdi:bell-ring'] }))
    const icons = await searchIcons('home')
    expect(icons.map((icon) => icon.svg_url)).toEqual([
      `${env.BETTER_AUTH_URL}/icons/iconify/lucide/home.svg`,
      `${env.BETTER_AUTH_URL}/icons/iconify/mdi/bell-ring.svg`,
    ])
  })

  it('passes Iconify the customisations it knows and nothing else', () => {
    expect(upstreamFor('lucide', 'home.svg', { color: '#e5533c', height: '20', onload: 'x' })).toBe(
      'https://api.iconify.design/lucide/home.svg?color=%23e5533c&height=20',
    )
    expect(upstreamFor('lucide', 'home.svg', { color: 'red;x' })).toBe('https://api.iconify.design/lucide/home.svg')
    /* a name Iconify could not have: no request leaves */
    expect(upstreamFor('lucide', '../search.svg', {})).toBeNull()
    expect(upstreamFor('lucide', 'home.png', {})).toBeNull()
    expect(upstreamFor('Lucide', 'home.svg', {})).toBeNull()
  })

  it('serves the SVG neutered, and fetches each icon once', async () => {
    const fetch = vi.fn(async () => svgResponse())
    vi.stubGlobal('fetch', fetch)
    const first = await call('tabler', 'cloud.svg', { color: '#111' })
    expect(first.status).toBe(200)
    expect(first.body?.toString()).toBe(SVG)
    expect(first.headers['Content-Type']).toBe('image/svg+xml')
    expect(first.headers['Content-Security-Policy']).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(first.headers['X-Content-Type-Options']).toBe('nosniff')
    await call('tabler', 'cloud.svg', { color: '#111' })
    expect(fetch).toHaveBeenCalledTimes(1)
    /* another colour is another icon */
    await call('tabler', 'cloud.svg', { color: '#222' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps each icon in the bucket, and answers from it without asking Iconify', async () => {
    vi.stubGlobal('fetch', async () => svgResponse())
    await call('ph', 'house.svg')
    const key = `iconify/${createHash('sha256').update('https://api.iconify.design/ph/house.svg').digest('hex')}.svg`
    expect([...bucket.keys()]).toEqual([key])
    /* an icon this process has not served yet, already in the bucket (an earlier deploy put it there) */
    bucket.set(
      `iconify/${createHash('sha256').update('https://api.iconify.design/ph/tree.svg').digest('hex')}.svg`,
      Buffer.from('<svg>stored</svg>'),
    )
    const fetch = vi.fn(async () => svgResponse())
    vi.stubGlobal('fetch', fetch)
    expect((await call('ph', 'tree.svg')).body?.toString()).toBe('<svg>stored</svg>')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('caps the Iconify fetches running at once, and refuses past the queue', async () => {
    const releases: (() => void)[] = []
    vi.stubGlobal(
      'fetch',
      () => new Promise<globalThis.Response>((resolve) => releases.push(() => resolve(svgResponse()))),
    )
    const calls = Array.from({ length: 81 }, (_, i) => call('lucide', `burst-${i}.svg`))
    await new Promise((resolve) => setTimeout(resolve, 20))
    /* 16 run, 64 wait, the 81st is told to come back */
    expect(releases).toHaveLength(16)
    const refused = await calls[80]!
    expect(refused.status).toBe(503)
    expect(refused.headers['Retry-After']).toBe('2')
    while (releases.length) {
      releases.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const results = await Promise.all(calls.slice(0, 80))
    expect(results.every((result) => result.status === 200)).toBe(true)
  })

  it('reads a Doop icon URL in-process for exports, and ignores other addresses', async () => {
    vi.stubGlobal('fetch', async () => svgResponse())
    const svg = await hostedIconSvg(new URL(`${env.BETTER_AUTH_URL}/icons/iconify/lucide/star.svg?color=%23111`))
    expect(svg?.toString()).toBe(SVG)
    expect(hostedIconSvg(new URL('https://example.com/icons/lucide/star.svg'))).toBeUndefined()
    expect(hostedIconSvg(new URL(`${env.BETTER_AUTH_URL}/a/abc.png`))).toBeUndefined()
  })

  it('says 404 for an icon Iconify does not have, and 502 when Iconify fails', async () => {
    vi.stubGlobal('fetch', async () => svgResponse('', 404))
    expect((await call('lucide', 'not-an-icon.svg')).status).toBe(404)
    vi.stubGlobal('fetch', async () => svgResponse('<html>', 200, 'text/html'))
    expect((await call('lucide', 'flaky.svg')).status).toBe(502)
  })

  it('points a frame’s existing Iconify hotlinks at Doop for the renderer, query kept', () => {
    const html = `<img src="https://api.iconify.design/lucide/home.svg?color=%23111&amp;height=20"><p>api.iconify.design</p>`
    expect(withHostedIcons(html)).toBe(
      `<img src="${env.BETTER_AUTH_URL}/icons/iconify/lucide/home.svg?color=%23111&amp;height=20"><p>api.iconify.design</p>`,
    )
    expect(withHostedIcons('<p>no icons</p>')).toBe('<p>no icons</p>')
  })
})
