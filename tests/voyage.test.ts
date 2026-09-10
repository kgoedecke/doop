import { afterEach, describe, expect, it } from 'vitest'
import { embedImage, embedText, embeddingEnabled } from '../server/voyage.ts'

interface VoyageRequestBody {
  model?: string
  inputs?: Array<{
    content?: Array<{
      type?: string
      text?: string
      image_base64?: string
    }>
  }>
}

describe('server/voyage.ts', () => {
  const originalKey = process.env.VOYAGE_API_KEY
  const originalFetch = globalThis.fetch

  afterEach(() => {
    if (originalKey === undefined) delete process.env.VOYAGE_API_KEY
    else process.env.VOYAGE_API_KEY = originalKey
    globalThis.fetch = originalFetch
  })

  describe('embeddingEnabled', () => {
    it('returns false when VOYAGE_API_KEY is unset', () => {
      delete process.env.VOYAGE_API_KEY
      expect(embeddingEnabled()).toBe(false)
    })

    it('returns true when VOYAGE_API_KEY is set', () => {
      process.env.VOYAGE_API_KEY = 'pa-test-voyage-key'
      expect(embeddingEnabled()).toBe(true)
    })
  })

  describe('embedImage', () => {
    it('returns null when VOYAGE_API_KEY is unset', async () => {
      delete process.env.VOYAGE_API_KEY
      const result = await embedImage(Buffer.from('fake-image-bytes'))
      expect(result).toBeNull()
    })

    it('sends data URL base64 image and returns vector array on success', async () => {
      process.env.VOYAGE_API_KEY = 'pa-test-voyage-key'
      const dummyVector = [0.1, 0.2, 0.3, -0.4]
      let requestBody: VoyageRequestBody | null = null

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe('https://api.voyageai.com/v1/multimodalembeddings')
        const headers = (init?.headers as Record<string, string>) ?? {}
        expect(headers.Authorization).toBe('Bearer pa-test-voyage-key')
        expect(headers['Content-Type']).toBe('application/json')
        requestBody = JSON.parse(init?.body as string) as VoyageRequestBody
        return new Response(JSON.stringify({ data: [{ embedding: dummyVector, index: 0 }] }), { status: 200 })
      }) as typeof fetch

      const inputBuffer = Buffer.from('test-image')
      const vector = await embedImage(inputBuffer)

      expect(vector).toEqual(dummyVector)
      expect(requestBody?.model).toBe('voyage-multimodal-3')
      expect(requestBody?.inputs?.[0]?.content?.[0]?.type).toBe('image_base64')
      expect(requestBody?.inputs?.[0]?.content?.[0]?.image_base64).toContain('data:image/jpeg;base64,')
    })

    it('returns null when API call returns an HTTP error code', async () => {
      process.env.VOYAGE_API_KEY = 'pa-test-voyage-key'
      globalThis.fetch = (async () => new Response('Internal error', { status: 500 })) as typeof fetch

      const vector = await embedImage(Buffer.from('image'))
      expect(vector).toBeNull()
    })

    it('returns null when API call throws a network error', async () => {
      process.env.VOYAGE_API_KEY = 'pa-test-voyage-key'
      globalThis.fetch = (async () => {
        throw new Error('Network timeout')
      }) as typeof fetch

      const vector = await embedImage(Buffer.from('image'))
      expect(vector).toBeNull()
    })
  })

  describe('embedText', () => {
    it('returns null when text is empty or whitespace', async () => {
      process.env.VOYAGE_API_KEY = 'pa-test-voyage-key'
      expect(await embedText('')).toBeNull()
      expect(await embedText('   ')).toBeNull()
    })

    it('sends text input and returns vector array on success', async () => {
      process.env.VOYAGE_API_KEY = 'pa-test-voyage-key'
      const dummyVector = [0.5, -0.2, 0.8]
      let requestBody: VoyageRequestBody | null = null

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(init?.body as string) as VoyageRequestBody
        return new Response(JSON.stringify({ data: [{ embedding: dummyVector, index: 0 }] }), { status: 200 })
      }) as typeof fetch

      const vector = await embedText('silver grid architecture')
      expect(vector).toEqual(dummyVector)
      expect(requestBody?.model).toBe('voyage-multimodal-3')
      expect(requestBody?.inputs?.[0]?.content?.[0]).toEqual({ type: 'text', text: 'silver grid architecture' })
    })

    it('returns null on failure soft-fail', async () => {
      process.env.VOYAGE_API_KEY = 'pa-test-voyage-key'
      globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch

      expect(await embedText('query')).toBeNull()
    })
  })
})
