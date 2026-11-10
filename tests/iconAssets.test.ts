import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

const mocks = vi.hoisted(() => ({ objects: new Map<string, Buffer>(), fetch: vi.fn() }))
vi.mock('../server/storage.ts', () => ({
  getObject: async (key: string) => mocks.objects.get(key) ?? null,
  putObject: async (key: string, body: Buffer) => {
    mocks.objects.set(key, body)
  },
}))
vi.mock('../server/publicUrl.ts', async (original) => ({
  ...(await original<typeof import('../server/publicUrl.ts')>()),
  fetchPinnedPublicUrl: mocks.fetch,
}))

import { iconAssetSource, iconAssetUrl, getIconAsset, iconAssetsRouter } from '../server/iconAssets.ts'
import { searchIcons } from '../server/imageSearch.ts'
import { findBrowserPath, getBrowser, renderFrame } from '../server/screenshot.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#ff0000" d="M0 0h24v24H0z"/></svg>'
const source = (query = '') => new URL(`https://api.iconify.design/mdi/home.svg${query}`)
const response = () => new Response(SVG, { headers: { 'content-type': 'image/svg+xml' } })
let server: Server
let origin: string
let rendered = false

beforeAll(async () => {
  const app = express()
  app.use('/a/iconify', iconAssetsRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => {
  mocks.objects.clear()
  mocks.fetch.mockReset().mockImplementation(response)
  stubEnv('BETTER_AUTH_URL', origin)
})

afterEach(() => {
  vi.unstubAllGlobals()
  unstubAllEnvs()
})

afterAll(async () => {
  if (rendered) await (await getBrowser()).close()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

it('returns Doop-hosted URLs from search and keeps the SVG query options usable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ icons: ['mdi:home'] }))),
  )
  expect(await searchIcons('home')).toEqual([{ id: 'mdi:home', svg_url: `${origin}/a/iconify/mdi/home.svg` }])
  expect(iconAssetUrl('mdi:home', origin)).toBe(`${origin}/a/iconify/mdi/home.svg`)
})

it('persists successful SVGs, deduplicates concurrent requests and serves them with upstream offline', async () => {
  const results = await Promise.all([getIconAsset(source()), getIconAsset(source())])
  expect(results.map((body) => body.toString())).toEqual([SVG, SVG])
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect([...mocks.objects.keys()][0]).toMatch(/^icons\/[a-f0-9]{64}\.svg$/)
  mocks.fetch.mockRejectedValue(new Error('Iconify offline'))
  expect((await getIconAsset(source())).toString()).toBe(SVG)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

it('keeps color/size variants distinct and shares equivalent query ordering', async () => {
  await getIconAsset(source('?height=32&color=%23ff0000'))
  await getIconAsset(source('?color=%23ff0000&height=32'))
  await getIconAsset(source('?color=%2300ff00&height=32'))
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(String(mocks.fetch.mock.calls[0]![0])).toContain('color=%23ff0000&height=32')
  expect(mocks.objects.size).toBe(2)
})

it.each([
  'https://evil.test/mdi/home.svg',
  'https://api.iconify.design.evil.test/mdi/home.svg',
  'https://user:pass@api.iconify.design/mdi/home.svg',
  'https://api.iconify.design/search',
  'https://api.iconify.design/mdi/home.svg?url=http://localhost',
  'https://api.iconify.design/mdi/home.svg?color=red&color=blue',
])('does not turn %s into an asset fetch', (raw) => {
  expect(iconAssetSource(raw)).toBeNull()
})

it('does not cache failures or non-SVG responses and allows a retry', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response('blocked', { status: 403 }))
  await expect(getIconAsset(source())).rejects.toThrow('HTTP 403')
  mocks.fetch.mockResolvedValueOnce(
    new Response('<html>challenge</html>', { headers: { 'content-type': 'image/svg+xml' } }),
  )
  await expect(getIconAsset(source())).rejects.toThrow('invalid icon SVG')
  expect(mocks.objects.size).toBe(0)
  expect((await getIconAsset(source())).toString()).toBe(SVG)
})

it('bounds streamed SVG responses before persisting them', async () => {
  mocks.fetch.mockResolvedValueOnce(
    new Response('<svg>' + 'x'.repeat(256_000), { headers: { 'content-type': 'image/svg+xml' } }),
  )
  await expect(getIconAsset(source())).rejects.toThrow('too large')
  expect(mocks.objects.size).toBe(0)
})

it('serves the public asset route with SVG safety headers and retries upstream failures', async () => {
  const url = `${origin}/a/iconify/mdi/home.svg?color=%23ff0000&height=32`
  mocks.fetch.mockRejectedValueOnce(new Error('offline'))
  const failed = await fetch(url)
  expect(failed.status).toBe(503)
  expect(failed.headers.get('retry-after')).toBe('5')
  const ok = await fetch(url)
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toContain('image/svg+xml')
  expect(ok.headers.get('access-control-allow-origin')).toBe('*')
  expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'")
  expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await ok.text()).toBe(SVG)
  expect((await fetch(`${url}&unexpected=value`)).status).toBe(400)
})

it.skipIf(!findBrowserPath())(
  'renders cached local and legacy hotlinked icons when Iconify is unavailable',
  async () => {
    const variant = '?color=%23ff0000&height=24'
    await getIconAsset(source(variant))
    mocks.fetch.mockRejectedValue(new Error('Iconify offline'))
    rendered = true
    for (const url of [`${origin}/a/iconify/mdi/home.svg${variant}`, source(variant).href]) {
      const frame = {
        id: 'icon-test',
        width: 24,
        height: 24,
        html: `<html><body style="margin:0"><img src="${url}" width="24" height="24"></body></html>`,
      } as Frame
      for (const type of ['png', 'jpeg'] as const) {
        const image = await renderFrame(frame, 1, { type })
        const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true })
        const pixel = (12 * info.width + 12) * info.channels
        expect(data[pixel]).toBeGreaterThan(245)
        expect(data[pixel + 1]).toBeLessThan(5)
        expect(data[pixel + 2]).toBeLessThan(5)
      }
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  },
  20_000,
)
