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
import { IconDataStore, iconData, IconUnavailableError } from '../server/iconData.ts'
import { prepareFrameIcons } from '../server/frameIcons.ts'
import { searchIcons } from '../server/imageSearch.ts'
import { findBrowserPath, getBrowser, loadFramePage, renderFrame } from '../server/screenshot.ts'
import { renderFramesPdf } from '../server/pdfExport.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

const BODY = '<path fill="currentColor" d="M0 0h24v24H0z"/>'
const BASE = { body: BODY, width: 24, height: 24 }
const source = (query = '') => new URL(`https://api.iconify.design/mdi/home.svg${query}`)
function apiResponse(input: string | URL): Response {
  const url = new URL(input)
  const prefix = url.pathname.slice(1, -5)
  const icons = Object.fromEntries((url.searchParams.get('icons') ?? '').split(',').map((name) => [name, { ...BASE }]))
  return Response.json({ prefix, icons })
}
let server: Server
let origin: string
let rendered = false
let dataStore: IconDataStore

beforeAll(async () => {
  const app = express()
  app.use('/a/iconify', iconAssetsRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => {
  mocks.objects.clear()
  mocks.fetch.mockReset().mockImplementation(apiResponse)
  dataStore = new IconDataStore()
  vi.spyOn(iconData, 'get').mockImplementation((id) => dataStore.get(id))
  stubEnv('BETTER_AUTH_URL', origin)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  unstubAllEnvs()
})

afterAll(async () => {
  if (rendered) await (await getBrowser()).close()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

it('downloads search result data in batches before returning Doop-hosted URLs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ icons: ['mdi:home', 'mdi:arrow', 'tabler:home'] })),
  )
  const result = await searchIcons('home')
  expect(result[0]).toEqual({ id: 'mdi:home', svg_url: `${origin}/a/iconify/mdi/home.svg` })
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(mocks.objects.size).toBe(3)
  expect(iconAssetUrl('mdi:home', origin)).toBe(result[0]!.svg_url)
  mocks.fetch.mockRejectedValue(new Error('offline'))
  expect((await getIconAsset(source('?color=red'))).toString()).toContain('<svg')
})

it('persists one base per id and reuses it across restarts and all color/size variants', async () => {
  const variants = await Promise.all(
    Array.from({ length: 72 }, (_, i) =>
      getIconAsset(source(`?height=${i + 1}&color=%23${i.toString(16).padStart(6, '0')}`)),
    ),
  )
  expect(variants).toHaveLength(72)
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect([...mocks.objects.keys()]).toEqual([expect.stringMatching(/^icons\/v1-[a-f0-9]{64}\.json$/)])
  expect([...mocks.objects.values()][0]!.toString()).toContain('currentColor')
  dataStore = new IconDataStore()
  mocks.fetch.mockRejectedValue(new Error('offline'))
  expect((await getIconAsset(source('?color=red&height=96'))).toString()).toContain('height="96"')
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

it('queues more than 64 cold icons, splits long queries and limits simultaneous downloads', async () => {
  let active = 0
  let peak = 0
  mocks.fetch.mockImplementation(async (input: string) => {
    active++
    peak = Math.max(peak, active)
    expect(input.length).toBeLessThanOrEqual(500)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return apiResponse(input)
  })
  const result = await Promise.all(Array.from({ length: 192 }, (_, i) => dataStore.get(`set-${i % 8}:icon-${i}`)))
  expect(result).toHaveLength(192)
  expect(peak).toBeLessThanOrEqual(2)
  expect(mocks.fetch.mock.calls.length).toBeLessThan(20)
  expect(mocks.objects.size).toBe(192)
})

it('extracts aliased icons with collection dimensions and keeps fixed palette colors', async () => {
  mocks.fetch.mockResolvedValueOnce(
    Response.json({
      prefix: 'mdi',
      width: 48,
      height: 24,
      icons: { original: { body: BODY + '<path fill="#00f" d="M0 0h4v4H0z"/>' } },
      aliases: { home: { parent: 'original', rotate: 1 } },
    }),
  )
  const svg = (await getIconAsset(source('?color=red&height=48'))).toString()
  expect(svg).toContain('width="24"')
  expect(svg).toContain('height="48"')
  expect(svg).toContain('fill="#00f"')
  expect(svg).not.toContain('currentColor')
})

it('edits a detached copy without modifying the shared original or other variants', async () => {
  const first = await dataStore.get('mdi:home')
  const other = await dataStore.get('mdi:home')
  first.body = '<circle cx="12" cy="12" r="8"/>'
  first.width = 100
  expect(other).toEqual(BASE)
  expect(await dataStore.get('mdi:home')).toEqual(BASE)
  const red = (await getIconAsset(source('?color=red'))).toString()
  const blue = (await getIconAsset(source('?color=blue'))).toString()
  expect(red).not.toBe(blue)
  expect(red).not.toContain('<circle')
  const saved = [...mocks.objects.values()][0]!.toString()
  expect(saved).toContain('currentColor')
  expect(saved).not.toContain('<circle')
})

it.each([
  'https://evil.test/mdi/home.svg',
  'https://api.iconify.design.evil.test/mdi/home.svg',
  'https://user:pass@api.iconify.design/mdi/home.svg',
  'https://api.iconify.design/search',
  'https://api.iconify.design/mdi/home.svg?url=http://localhost',
  'https://api.iconify.design/mdi/home.svg?color=red&color=blue',
  'https://api.iconify.design/mdi/home.svg?color=%22%3E%3Cscript%3E',
  'https://api.iconify.design/mdi/home.svg?height=%22%20onload=alert(1)',
  'https://api.iconify.design/mdi/home.svg?rotate=-999999999999999',
])('does not turn %s into an asset fetch', (raw) => expect(iconAssetSource(raw)).toBeNull())

it('supports colon URLs, dimensions, flips, rotation, transparent boxes and downloads', async () => {
  expect(iconAssetSource('https://api.iconify.design/mdi:home.svg')).not.toBeNull()
  const svg = (await getIconAsset(source('?height=none&flip=horizontal&rotate=90deg&box=1'))).toString()
  expect(svg).toContain('transform=')
  expect(svg).toContain('<rect')
  expect(svg).not.toMatch(/<svg[^>]*height=/)
  const response = await fetch(`${origin}/a/iconify/mdi/home.svg?download=1`)
  expect(response.headers.get('content-disposition')).toContain('home.svg')
})

it('does not cache invalid data, missing icons or failed responses and allows retry', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response('blocked', { status: 403 }))
  await expect(getIconAsset(source())).rejects.toThrow('HTTP 403')
  mocks.fetch.mockResolvedValueOnce(Response.json({ prefix: 'wrong', icons: { home: BASE } }))
  await expect(getIconAsset(source())).rejects.toThrow('invalid icon data')
  mocks.fetch.mockResolvedValueOnce(Response.json({ prefix: 'mdi', icons: {}, not_found: ['home'] }))
  expect((await fetch(`${origin}/a/iconify/mdi/home.svg`)).status).toBe(404)
  expect(mocks.objects.size).toBe(0)
  expect((await getIconAsset(source())).toString()).toContain('currentColor')
})

it('bounds streamed data before persisting it', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response('x'.repeat(2_000_001)))
  await expect(getIconAsset(source())).rejects.toThrow('too large')
  expect(mocks.objects.size).toBe(0)
})

it.each(['seconds', 'date'])(
  'honors Retry-After (%s) across queued and later misses while serving cached icons',
  async (kind) => {
    await dataStore.get('mdi:cached')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const retry = kind === 'seconds' ? '237' : new Date(now + 237_000).toUTCString()
    mocks.fetch.mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': retry } }))
    const response = await fetch(`${origin}/a/iconify/mdi/home.svg`)
    expect(response.status).toBe(503)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(236)
    const calls = mocks.fetch.mock.calls.length
    await expect(dataStore.get('mdi:another')).rejects.toBeInstanceOf(IconUnavailableError)
    expect(await dataStore.get('mdi:cached')).toEqual(BASE)
    expect(mocks.fetch).toHaveBeenCalledTimes(calls)
    clock.mockReturnValue(now + 238_000)
    expect(await dataStore.get('mdi:home')).toEqual(BASE)
    expect(mocks.fetch).toHaveBeenCalledTimes(calls + 1)
  },
)

it('serves public assets with SVG safety headers and retries ordinary upstream failures', async () => {
  const url = `${origin}/a/iconify/mdi/home.svg?color=%23ff0000&height=32`
  mocks.fetch.mockRejectedValueOnce(new Error('offline'))
  expect((await fetch(url)).status).toBe(503)
  const ok = await fetch(url)
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toContain('image/svg+xml')
  expect(ok.headers.get('access-control-allow-origin')).toBe('*')
  expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'")
  expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await ok.text()).toContain('<svg')
  expect((await fetch(`${url}&unexpected=value`)).status).toBe(400)
})

it('stops queued batches on rate limiting instead of draining them into more upstream failures', async () => {
  mocks.fetch.mockImplementation(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }))
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => dataStore.get(`set-${i}:home`)))
  expect(results.every((result) => result.status === 'rejected')).toBe(true)
  expect(mocks.fetch.mock.calls.length).toBeLessThanOrEqual(2)
  const calls = mocks.fetch.mock.calls.length
  await expect(dataStore.get('new-set:home')).rejects.toThrow('retry in')
  expect(mocks.fetch).toHaveBeenCalledTimes(calls)
})

it('prepares static images, srcsets, CSS and PDF srcdoc without downloading from unrelated hosts or changing inline SVG', async () => {
  const html = `<base href="${origin}/"><img src="/a/iconify/mdi/home.svg?color=red&amp;height=24">
    <img srcset="https://api.iconify.design/mdi/arrow.svg 1x, https://api.iconify.design/mdi/star.svg 2x">
    <style>.icon{background:url('https://api.iconify.design/tabler/home.svg?color=rgb(0,0,0)')}</style>
    <div style="mask-image:url(https://api.iconify.design/tabler/arrow.svg)"></div>
    <iframe srcdoc="&lt;img src='https://api.iconify.design/mdi/nested.svg'&gt;"></iframe>
    <img src="https://evil.test/a/iconify/mdi/ignored.svg"><svg>${BODY}</svg>`
  await prepareFrameIcons(html, origin)
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(mocks.objects.size).toBe(6)
})

const browserIt = it.skipIf(!findBrowserPath())
browserIt(
  'renders the 72-variant reproduction from an empty cache with one download, then exports offline',
  async () => {
    rendered = true
    const html = `<body style="margin:0;display:grid;grid-template-columns:repeat(12,24px)">${Array.from({ length: 72 }, (_, i) => `<img width="24" height="24" src="${i % 2 ? origin + '/a/iconify' : 'https://api.iconify.design'}/mdi/home.svg?color=%23ff0000&height=${i + 1}">`).join('')}</body>`
    const frame = { id: 'repro-72', width: 288, height: 144, html } as Frame
    const page = await loadFramePage(frame)
    try {
      expect(await page.page.$$eval('img', (imgs) => imgs.filter((img) => img.naturalWidth > 0).length)).toBe(72)
    } finally {
      await page.close()
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    mocks.fetch.mockRejectedValue(new Error('Iconify offline'))
    for (const type of ['png', 'jpeg'] as const) {
      const result = await renderFrame(frame, 1, { type })
      const { data, info } = await sharp(result).raw().toBuffer({ resolveWithObject: true })
      for (let i = 0; i < 72; i++) {
        const offset = ((Math.floor(i / 12) * 24 + 12) * info.width + (i % 12) * 24 + 12) * info.channels
        expect(data[offset]).toBeGreaterThan(245)
        expect(data[offset + 1]).toBeLessThan(5)
        expect(data[offset + 2]).toBeLessThan(5)
      }
    }
    expect((await renderFramesPdf([frame])).subarray(0, 5).toString()).toBe('%PDF-')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  },
  20_000,
)

browserIt(
  'renders all 192 resources (plain, CORS, lazy, CSS) from a cold cache',
  async () => {
    rendered = true
    const cells = Array.from({ length: 48 }, (_, i) => {
      const base = `${i % 2 ? origin + '/a/iconify' : 'https://api.iconify.design'}/set-${i % 4}/icon-${i}.svg`
      return `<section><img src="${base}?height=24"><img crossorigin="anonymous" src="${base}?height=25"><img loading="lazy" src="${base}?height=26"><div style="width:24px;height:24px;background-image:url('${base}?color=red&height=27')"></div></section>`
    }).join('')
    const frame = {
      id: 'repro-192',
      width: 480,
      height: 288,
      html: `<style>body{margin:0;display:grid;grid-template-columns:repeat(4,120px)}section{display:flex;height:24px}img{width:24px;height:24px}</style><body>${cells}</body>`,
    } as Frame
    const loaded = await loadFramePage(frame)
    try {
      await loaded.page.waitForFunction(
        () => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
        { timeout: 3000 },
      )
      expect(await loaded.page.$$eval('img', (imgs) => imgs.length)).toBe(144)
      const { data, info } = await sharp(Buffer.from(await loaded.page.screenshot()))
        .raw()
        .toBuffer({ resolveWithObject: true })
      for (let i = 0; i < 48; i++) {
        const offset = ((Math.floor(i / 4) * 24 + 12) * info.width + (i % 4) * 120 + 84) * info.channels
        expect(data[offset]).toBeGreaterThan(245)
        expect(data[offset + 1]).toBeLessThan(5)
      }
    } finally {
      await loaded.close()
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(4)
  },
  20_000,
)

browserIt('surfaces cold rate limiting before producing a screenshot with broken icons', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }))
  await expect(renderFrame({ width: 24, height: 24, html: `<img src="${source()}">` } as Frame)).rejects.toThrow(
    'retry in 120 seconds',
  )
})
