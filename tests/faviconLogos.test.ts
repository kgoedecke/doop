import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { dibIcon } from './icoFixture.ts'

const fetchRemote = vi.fn<(url: string, maxBytes?: number) => Promise<Buffer>>()
const createAsset =
  vi.fn<(buf: Buffer, meta: object) => Promise<{ id: string; ext: string; mime: string; size: number }>>()
vi.mock('../server/assets.ts', () => ({ fetchRemote, createAsset }))

const { brandName, faviconLogos, vectorFirst } = await import('../server/imageSearch.ts')

describe('faviconLogos', () => {
  beforeEach(() => {
    fetchRemote.mockReset()
    createAsset.mockReset()
    createAsset.mockImplementation(async (buf) => ({
      id: `asset${createAsset.mock.calls.length}`,
      ext: 'png',
      mime: 'image/png',
      size: buf.length,
    }))
  })

  it('stores the icon as a PNG asset and hands out that URL', async () => {
    fetchRemote.mockResolvedValue(dibIcon(2, 32, () => [255, 0, 0, 255]))
    const [logo] = await faviconLogos('visa.com')
    expect(fetchRemote.mock.calls[0]?.[0]).toBe('https://icons.duckduckgo.com/ip3/visa.com.ico')
    expect(logo?.logo_url).toMatch(/\/a\/asset1\.png$/)
    expect(logo?.source).toBe('favicon')
    const stored = createAsset.mock.calls[0]![0]
    const meta = await sharp(stored).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 2, 2])
    expect(logo?.thumb).toEqual({ data: stored.toString('base64'), mime: 'image/png' })
  })

  it('reuses one asset per domain', async () => {
    fetchRemote.mockResolvedValue(dibIcon(2, 32, () => [255, 0, 0, 255]))
    const [first] = await faviconLogos('stripe')
    const [second] = await faviconLogos('stripe.com')
    expect(second?.logo_url).toBe(first?.logo_url)
    expect(createAsset).toHaveBeenCalledTimes(1)
  })

  it('finds nothing for a domain DuckDuckGo does not know, and asks again next time', async () => {
    fetchRemote.mockRejectedValue(new Error('fetch failed: HTTP 404'))
    expect(await faviconLogos('nosuchco.io')).toEqual([])
    expect(await faviconLogos('nosuchco.io')).toEqual([])
    expect(fetchRemote).toHaveBeenCalledTimes(2)
    expect(createAsset).not.toHaveBeenCalled()
  })

  it('finds nothing when the bytes are not an image', async () => {
    fetchRemote.mockResolvedValue(Buffer.from('<html>not an icon</html>'))
    expect(await faviconLogos('broken.dev')).toEqual([])
    expect(createAsset).not.toHaveBeenCalled()
  })
})

describe('vectorFirst', () => {
  const favicon = { name: 'Visa', domain: 'visa.com', logo_url: '', thumb_url: '', source: 'favicon' as const }
  const vector = [{ id: 'logos:visa', svg_url: 'https://api.iconify.design/logos/visa.svg' }]

  it('puts vector marks ahead of favicons only', () => {
    expect(vectorFirst([favicon], vector)).toBe(true)
    expect(vectorFirst([{ ...favicon, source: 'brandfetch' }], vector)).toBe(false)
    expect(vectorFirst([favicon], [])).toBe(false)
  })
})

describe('brandName', () => {
  it('searches vector marks by the name in a domain', () => {
    expect(brandName('visa.com')).toBe('visa')
    expect(brandName('https://www.linear.app/pricing')).toBe('linear')
    expect(brandName('bbc.co.uk')).toBe('bbc')
    expect(brandName('Stripe Climate')).toBe('Stripe Climate')
  })
})
