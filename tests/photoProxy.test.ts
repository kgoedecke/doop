import type { Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

/* the bucket, in memory: what one test stores the next must not find on disk */
const bucket = new Map<string, Buffer>()
vi.mock('../server/storage.ts', () => ({
  getObject: async (key: string) => bucket.get(key) ?? null,
  putObject: async (key: string, body: Buffer) => void bucket.set(key, body),
}))

const { env } = await import('../server/env')
const { hostedPhoto, photoUrl, servePhoto, upstreamFor, withHostedPhotos } = await import('../server/photoProxy')

/**
 * search_images' photos come from Doop's origin and are copied into the bucket the first time
 * something loads them, so photography renders in screenshots and exports like an /a/ asset.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const LARGE = 'https://images.pexels.com/photos/3184465/pexels-photo-3184465.jpeg?auto=compress&cs=tinysrgb&h=650&w=940'

function jpegResponse(status = 200, type = 'image/jpeg') {
  return new globalThis.Response(status === 200 ? JPEG : null, { status, headers: { 'content-type': type } })
}

function call(file: string, query: Record<string, string> = {}) {
  const headers: Record<string, string> = {}
  const result: { status: number; body?: Buffer; headers: Record<string, string> } = { status: 200, headers }
  const res = {
    set: (name: string, value: string) => (headers[name] = value),
    status: (code: number) => ((result.status = code), res),
    end: () => res,
    send: (body: Buffer) => ((result.body = body), res),
  }
  const req = { params: { file }, query }
  return servePhoto(req as unknown as Request, res as unknown as Response).then(() => result)
}

afterEach(() => {
  vi.unstubAllGlobals()
  bucket.clear()
})

describe('photos from Doop', () => {
  it('turns a Pexels search result into a Doop URL that keeps its size', () => {
    expect(photoUrl(LARGE)).toBe(`${env.BETTER_AUTH_URL}/photos/pexels/3184465.jpeg?h=650&w=940`)
    /* anything else is left as it was */
    expect(photoUrl('https://example.com/photos/1/pexels-photo-1.jpeg')).toBe(
      'https://example.com/photos/1/pexels-photo-1.jpeg',
    )
  })

  it('asks Pexels only for photo ids and the sizes it knows, never the multi-MB original', () => {
    expect(upstreamFor('3184465.jpeg', { w: '1600', dpr: '2', onload: 'x' })).toBe(
      'https://images.pexels.com/photos/3184465/pexels-photo-3184465.jpeg?auto=compress&cs=tinysrgb&dpr=2&w=1600',
    )
    expect(upstreamFor('3184465.jpg', {})).toBe(
      'https://images.pexels.com/photos/3184465/pexels-photo-3184465.jpeg?auto=compress&cs=tinysrgb&h=650&w=940',
    )
    expect(upstreamFor('../x.jpeg', {})).toBeNull()
    expect(upstreamFor('123.gif', {})).toBeNull()
    expect(upstreamFor('123.jpeg', { w: '99999' })).toContain('h=650&w=940')
  })

  it('copies a photo into the bucket once, and serves it as an immutable image', async () => {
    const fetch = vi.fn(async () => jpegResponse())
    vi.stubGlobal('fetch', fetch)
    const first = await call('3184465.jpeg', { w: '940', h: '650' })
    expect(first.status).toBe(200)
    expect(first.body).toEqual(JPEG)
    expect(first.headers['Content-Type']).toBe('image/jpeg')
    expect(first.headers['Cache-Control']).toBe('public, max-age=31536000, immutable')
    expect(first.headers['Content-Security-Policy']).toBeUndefined()
    expect([...bucket.keys()]).toEqual([expect.stringMatching(/^pexels\/[0-9a-f]{64}\.jpeg$/)])
    await call('3184465.jpeg', { w: '940', h: '650' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('says 404 for a photo Pexels does not have, and 502 for one that is not an image', async () => {
    vi.stubGlobal('fetch', async () => jpegResponse(404))
    expect((await call('1.jpeg')).status).toBe(404)
    vi.stubGlobal('fetch', async () => jpegResponse(200, 'text/html'))
    expect((await call('2.jpeg')).status).toBe(502)
  })

  it('points a frame’s existing Pexels hotlinks at Doop for the renderer, in attributes and CSS', () => {
    const attr = LARGE.replace(/&/g, '&amp;')
    const html = `<img src="${attr}"><div style="background:url(${LARGE}) center/cover"></div>`
    expect(withHostedPhotos(html)).toBe(
      `<img src="${env.BETTER_AUTH_URL}/photos/pexels/3184465.jpeg?h=650&amp;w=940">` +
        `<div style="background:url(${env.BETTER_AUTH_URL}/photos/pexels/3184465.jpeg?h=650&w=940) center/cover"></div>`,
    )
    expect(withHostedPhotos('<p>no photos</p>')).toBe('<p>no photos</p>')
  })

  it('reads a Doop photo URL in-process for exports, and ignores other addresses', async () => {
    vi.stubGlobal('fetch', async () => jpegResponse())
    expect(await hostedPhoto(new URL(`${env.BETTER_AUTH_URL}/photos/pexels/42.jpeg?w=400`))).toEqual(JPEG)
    expect(hostedPhoto(new URL('https://example.com/photos/42.jpeg'))).toBeUndefined()
    /* the provider is part of the path */
    expect(hostedPhoto(new URL(`${env.BETTER_AUTH_URL}/photos/42.jpeg`))).toBeUndefined()
    expect(hostedPhoto(new URL(`${env.BETTER_AUTH_URL}/icons/lucide/home.svg`))).toBeUndefined()
  })
})
