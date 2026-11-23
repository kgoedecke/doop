import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import type { ModelAccount } from '../server/modelAccounts.ts'

/**
 * A custom provider's image models (personal or an admin's shared one): which
 * one generate_image picks, that it draws through the provider's own Images
 * API on the provider's key and headers, and that nothing else (a server key,
 * another connection) ever stands in for one. The HTTP side is in
 * customProviderImagesHttp.test.ts.
 */

vi.mock('../server/modelAccounts.ts', () => ({
  getAccounts: vi.fn(),
  withFreshToken: vi.fn((account: unknown) => Promise.resolve(account)),
}))
vi.mock('../server/imagePrefs.ts', () => ({
  getImagePref: vi.fn(() => Promise.resolve(undefined)),
}))

import { getAccounts } from '../server/modelAccounts.ts'
import { getImagePref } from '../server/imagePrefs.ts'
import { generateImage, generatorFor, imageModelAvailability } from '../server/imageGen.ts'
import { customImageModelRef } from '../shared/customProvider.ts'

const mockedGetAccounts = vi.mocked(getAccounts)
const mockedGetImagePref = vi.mocked(getImagePref)

const STUDIO = 'custom:aaaaaaaa11111111'
const GATEWAY = 'custom:bbbbbbbb22222222'
const PERSONAL_KEY = 'sk-personal-never-shown'
const SHARED_KEY = 'sk-shared-never-shown'

const personal = (patch: Partial<ModelAccount> = {}): ModelAccount => ({
  userId: 'u1',
  kind: STUDIO,
  enabled: true,
  connectedAt: 1,
  apiKey: PERSONAL_KEY,
  headers: { 'X-Tenant': 'design' },
  custom: {
    name: 'Studio FLUX',
    apiType: 'openai-chat',
    baseUrl: 'https://img.studio.example/v1',
    models: [{ id: 'qwen3-coder', vision: true }],
    imageModels: [{ id: 'flux-dev', name: 'FLUX dev', transparent: true }, { id: 'sdxl' }],
  },
  ...patch,
})

const shared = (patch: Partial<ModelAccount> = {}): ModelAccount => ({
  userId: 'u1',
  kind: GATEWAY,
  enabled: true,
  connectedAt: 2,
  apiKey: SHARED_KEY,
  custom: {
    name: 'Acme Gateway',
    apiType: 'openai-chat',
    baseUrl: 'https://llm.acme.example/team/v1',
    models: [{ id: 'glm-5', vision: false }],
    imageModels: [{ id: 'flux-schnell' }],
  },
  shared: true,
  ...patch,
})

async function png(alpha = false): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 6, channels: 4, background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : '#e5533c' },
  })
    .png()
    .toBuffer()
}

async function imagesResponse(given?: unknown) {
  const data = given ?? [{ b64_json: (await png()).toString('base64') }]
  return new Response(JSON.stringify({ created: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const headersOf = (init: RequestInit | undefined) => new Headers(init?.headers as HeadersInit)

beforeEach(() => {
  /* the fake endpoints are not resolved: fetch is stubbed, and the private
     hosts switch keeps customProviderFetch on the global fetch */
  stubEnv('DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS', 'true')
})
afterEach(() => {
  vi.restoreAllMocks()
  mockedGetAccounts.mockReset()
  mockedGetImagePref.mockReset()
  mockedGetImagePref.mockResolvedValue(undefined)
  unstubAllEnvs()
})

describe('drawing on a personal custom provider', () => {
  it('posts the Images API request to the provider with its key and headers, billed to it', async () => {
    mockedGetAccounts.mockResolvedValue([personal()])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(STUDIO, 'flux-dev'))
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(await imagesResponse([{ b64_json: (await png(true)).toString('base64') }]))

    const image = await generateImage('u1', { prompt: 'a red circle', aspect: 'landscape', transparent: true })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('https://img.studio.example/v1/images/generations')
    expect(init!.method).toBe('POST')
    /* no redirects: the guarded fetch path, as for the provider's chat turns */
    expect(init!.redirect).toBe('error')
    const headers = headersOf(init)
    expect(headers.get('authorization')).toBe(`Bearer ${PERSONAL_KEY}`)
    expect(headers.get('x-tenant')).toBe('design')
    expect(JSON.parse(String(init!.body))).toEqual({
      model: 'flux-dev',
      prompt: 'a red circle',
      n: 1,
      size: '1536x1024',
      quality: 'medium',
      output_format: 'png',
      background: 'transparent',
    })
    expect(image).toMatchObject({ billedTo: 'Studio FLUX', custom: 'personal', transparent: true, mime: 'image/webp' })
  })

  it('keeps a cut-out’s alpha in the stored image', async () => {
    mockedGetAccounts.mockResolvedValue([personal()])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(STUDIO, 'flux-dev'))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      await imagesResponse([{ b64_json: (await png(true)).toString('base64') }]),
    )
    const image = await generateImage('u1', { prompt: 'a mascot', transparent: true })
    expect((await sharp(image.buf).metadata()).hasAlpha).toBe(true)
    expect(image.preview.mime).toBe('image/jpeg')
  })

  it('reports what was drawn: an opaque answer to a cut-out request is not transparent', async () => {
    mockedGetAccounts.mockResolvedValue([personal()])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(STUDIO, 'flux-dev'))
    const opaque = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#e5533c' } })
      .png()
      .toBuffer()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(await imagesResponse([{ b64_json: opaque.toString('base64') }]))
    expect((await generateImage('u1', { prompt: 'x', transparent: true })).transparent).toBe(false)
    /* an alpha channel that is opaque everywhere is no cut-out either */
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(await imagesResponse())
    expect((await generateImage('u1', { prompt: 'x', transparent: true })).transparent).toBe(false)
  })

  it('asks for no transparent background from a model that cannot draw one', async () => {
    mockedGetAccounts.mockResolvedValue([personal()])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(STUDIO, 'sdxl'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(await imagesResponse())

    const image = await generateImage('u1', { prompt: 'a mascot', transparent: true, quality: 'low' })

    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('background')
    expect(body).toMatchObject({ model: 'sdxl', size: '1024x1024', quality: 'low' })
    expect(image.transparent).toBe(false)
  })

  it('sends no Authorization at all to an endpoint that takes no key', async () => {
    mockedGetAccounts.mockResolvedValue([personal({ apiKey: undefined, headers: undefined })])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(STUDIO, 'sdxl'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(await imagesResponse())
    await generateImage('u1', { prompt: 'x' })
    expect(headersOf(fetchSpy.mock.calls[0]![1]).has('authorization')).toBe(false)
  })

  it('keeps a registry pick on the registry when the person also has image models of their own', async () => {
    mockedGetAccounts.mockResolvedValue([
      personal(),
      { enabled: true, userId: 'u1', kind: 'openai-key', apiKey: 'sk-openai', connectedAt: 3 },
    ])
    mockedGetImagePref.mockResolvedValue('gpt-image-2.5-flare')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(await imagesResponse())
    const image = await generateImage('u1', { prompt: 'x' })
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://api.openai.com/v1/images/generations')
    expect(image.billedTo).toBe('OpenAI')
    expect(image.custom).toBeUndefined()
  })
})

describe('drawing on a shared provider', () => {
  it('is where someone with nothing of their own draws by default, on the company’s endpoint, never the server key', async () => {
    stubEnv('OPENAI_API_KEY', 'sk-server-paid')
    stubEnv('GEMINI_API_KEY', 'gm-server-paid')
    mockedGetAccounts.mockResolvedValue([shared()])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(await imagesResponse())

    const image = await generateImage('u1', { prompt: 'a hero backdrop', aspect: 'portrait' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('https://llm.acme.example/team/v1/images/generations')
    expect(headersOf(init).get('authorization')).toBe(`Bearer ${SHARED_KEY}`)
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'flux-schnell', size: '1024x1536' })
    expect(image).toMatchObject({ billedTo: 'Acme Gateway', custom: 'shared', transparent: false })
  })

  it('comes before Seedream on the server’s ARK_API_KEY when nothing is picked', async () => {
    stubEnv('ARK_API_KEY', 'ark-server-paid')
    mockedGetAccounts.mockResolvedValue([shared()])
    expect(await generatorFor('u1')).toMatchObject({ ok: true, label: 'Acme Gateway', custom: 'shared' })
    expect((await imageModelAvailability('u1')).find((model) => model.selected)?.id).toBe(`${GATEWAY}/flux-schnell`)
    /* a pick on Seedream still draws Seedream, the operator having opted into paying for it */
    mockedGetImagePref.mockResolvedValue('seedream-5-0-pro')
    expect(await generatorFor('u1')).toMatchObject({ ok: true, label: 'server' })
  })

  it('keeps the person’s own registry account ahead of their custom image models, and both ahead of Seedream', async () => {
    stubEnv('ARK_API_KEY', 'ark-server-paid')
    stubEnv('DOOP_IMAGE_MODEL', 'seedream-5-0-pro')
    mockedGetAccounts.mockResolvedValue([
      shared(),
      { enabled: true, userId: 'u1', kind: 'gemini-key', apiKey: 'gm-user', connectedAt: 3 },
    ])
    expect(await generatorFor('u1')).toMatchObject({ ok: true, label: 'Gemini' })
    /* and someone who connected nothing still starts on the server's default */
    mockedGetAccounts.mockResolvedValue([])
    expect(await generatorFor('u1')).toMatchObject({ ok: true, label: 'server' })
  })

  it('lists its image models, and the person’s own providers’ first, in the picker’s availability', async () => {
    mockedGetAccounts.mockResolvedValue([personal(), shared()])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(GATEWAY, 'flux-schnell'))

    const models = await imageModelAvailability('u1')

    expect(models.filter((m) => m.custom)).toEqual([
      {
        id: `${STUDIO}/flux-dev`,
        available: true,
        selected: false,
        custom: { provider: 'Studio FLUX', name: 'FLUX dev', transparent: true },
      },
      { id: `${STUDIO}/sdxl`, available: true, selected: false, custom: { provider: 'Studio FLUX', name: 'sdxl' } },
      {
        id: `${GATEWAY}/flux-schnell`,
        available: true,
        selected: true,
        custom: { provider: 'Acme Gateway', name: 'flux-schnell', shared: true },
      },
    ])
    /* the registry is all there still, nothing of it selected */
    expect(models.filter((m) => !m.custom).every((m) => !m.selected)).toBe(true)
    /* and never the key */
    expect(JSON.stringify(models)).not.toContain(SHARED_KEY)
  })

  it('says to ask the admin when the endpoint turns the shared key down', async () => {
    mockedGetAccounts.mockResolvedValue([shared()])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"bad key"}', { status: 401 }))
    const failure = generateImage('u1', { prompt: 'x' })
    await expect(failure).rejects.toThrow(
      /Acme Gateway turned down the shared connection your admin set up \(401\)\. Ask your admin to check it in Admin → Shared models/,
    )
    await expect(failure).rejects.not.toThrow(/reconnect|server/)
  })

  it('masks the shared key and header values in whatever the endpoint says back', async () => {
    const SECRET_HEADER = 'tenant-secret-never-shown'
    mockedGetAccounts.mockResolvedValue([shared({ headers: { 'X-Tenant': SECRET_HEADER } })])
    const answers = [
      new Response(`{"error":{"message":"Invalid params for key ${SHARED_KEY} (${SECRET_HEADER})"}}`, { status: 400 }),
      new Response(`rate limit for ${SHARED_KEY}`, { status: 429 }),
      new Response(JSON.stringify({ error: { message: `quota of ${SHARED_KEY} exceeded` } }), { status: 200 }),
      new Response(`no such model for key ${SHARED_KEY}`, { status: 404 }),
    ]
    for (const answer of answers) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(answer)
      const failure = await generateImage('u1', { prompt: 'x' }).catch((error: Error) => error)
      expect(failure).toBeInstanceOf(Error)
      const said = JSON.stringify(failure, Object.getOwnPropertyNames(failure))
      expect(said).not.toContain(SHARED_KEY)
      expect(said).not.toContain(SECRET_HEADER)
      expect((failure as Error).cause).toBeUndefined()
    }
  })

  it('masks a key that straddles where the endpoint’s text is cut, at either end of the key', async () => {
    mockedGetAccounts.mockResolvedValue([shared()])
    /* a refusal body is cut at 400 characters (responseError), an error
       beside a 200 at 300; the key starts just before each cut, then ends
       just after it */
    const answers = (cut: number, before: number) =>
      cut === 400
        ? new Response(`${'x'.repeat(before)}${SHARED_KEY} trailing`, { status: 400 })
        : new Response(JSON.stringify({ error: { message: `${'x'.repeat(before)}${SHARED_KEY} trailing` } }), {
            status: 200,
          })
    for (const cut of [400, 300]) {
      for (const before of [cut - 1, cut - SHARED_KEY.length + 1]) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(answers(cut, before))
        const failure = await generateImage('u1', { prompt: 'x' }).catch((error: Error) => error)
        expect((failure as Error).message).toMatch(/x\*/)
        expect((failure as Error).message).not.toMatch(/sk-|xs(\W|$)/)
      }
    }
  })

  it('says to ask the admin when the endpoint has no such image model', async () => {
    mockedGetAccounts.mockResolvedValue([shared()])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"model flux-schnell not found"}}', { status: 404 }),
    )
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(
      /Acme Gateway cannot draw with flux-schnell \(404\).*Ask your admin/,
    )
  })
})

describe('a custom image model that cannot run', () => {
  it('refuses when its provider is switched off, rather than drawing on another connection or the server', async () => {
    stubEnv('OPENAI_API_KEY', 'sk-server-paid')
    mockedGetAccounts.mockResolvedValue([
      personal({ enabled: false }),
      { enabled: true, userId: 'u1', kind: 'gemini-key', apiKey: 'gm-user', connectedAt: 3 },
    ])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(STUDIO, 'flux-dev'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const generator = await generatorFor('u1')

    expect(generator.ok).toBe(false)
    expect(!generator.ok && generator.reason).toMatch(
      /flux-dev on Studio FLUX is not available: the person’s Studio FLUX connection is switched off/,
    )
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(/switched off/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('names the switched-off provider when it was the only thing that could draw, and the server key stays out', async () => {
    stubEnv('OPENAI_API_KEY', 'sk-server-paid')
    mockedGetAccounts.mockResolvedValue([personal({ enabled: false })])
    const generator = await generatorFor('u1')
    expect(generator.ok).toBe(false)
    expect(!generator.ok && generator.reason).toMatch(/Studio FLUX connection is switched off/)
  })

  it('refuses when the person switched the shared provider off for themselves', async () => {
    stubEnv('OPENAI_API_KEY', 'sk-server-paid')
    mockedGetAccounts.mockResolvedValue([shared({ enabled: false })])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(GATEWAY, 'flux-schnell'))
    expect(await generatorFor('u1')).toMatchObject({ ok: false })
  })

  it('refuses when the provider is gone (an admin deleted or switched off the shared one)', async () => {
    stubEnv('OPENAI_API_KEY', 'sk-server-paid')
    mockedGetAccounts.mockResolvedValue([
      { enabled: true, userId: 'u1', kind: 'openai-key', apiKey: 'sk-openai', connectedAt: 3 },
    ])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(GATEWAY, 'flux-schnell'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const generator = await generatorFor('u1')
    expect(!generator.ok && generator.reason).toMatch(
      /flux-schnell\) was on a custom provider that is no longer connected/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses when the provider no longer lists the model', async () => {
    mockedGetAccounts.mockResolvedValue([shared()])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(GATEWAY, 'flux-pro'))
    const generator = await generatorFor('u1')
    expect(!generator.ok && generator.reason).toMatch(/Acme Gateway no longer lists flux-pro as an image model/)
  })

  it('does not count a provider without image models as one that draws', async () => {
    stubEnv('OPENAI_API_KEY', 'sk-server-paid')
    mockedGetAccounts.mockResolvedValue([shared({ custom: { ...shared().custom!, imageModels: undefined } })])
    const generator = await generatorFor('u1')
    expect(!generator.ok && generator.reason).toMatch(/list image models on a custom provider/)
  })
})

describe('what the endpoint answers', () => {
  beforeEach(() => {
    mockedGetAccounts.mockResolvedValue([personal()])
    mockedGetImagePref.mockResolvedValue(customImageModelRef(STUDIO, 'sdxl'))
  })

  it('fetches an image it links to on its own origin with its credentials', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(await imagesResponse([{ url: '/files/out.png' }]))
      .mockResolvedValueOnce(new Response(new Uint8Array(await png())))
    const image = await generateImage('u1', { prompt: 'x' })
    expect(image.width).toBe(8)
    const [url, init] = fetchSpy.mock.calls[1]!
    expect(String(url)).toBe('https://img.studio.example/files/out.png')
    expect(init!.redirect).toBe('error')
    expect(headersOf(init).get('authorization')).toBe(`Bearer ${PERSONAL_KEY}`)
  })

  it('fetches an image it links to elsewhere without them', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(await imagesResponse([{ url: 'https://cdn.elsewhere.example/out.png?sig=1' }]))
      .mockResolvedValueOnce(new Response(new Uint8Array(await png())))
    await generateImage('u1', { prompt: 'x' })
    const headers = headersOf(fetchSpy.mock.calls[1]![1])
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-tenant')).toBe(false)
  })

  it('refuses a link that does not point at an image, or no image at all', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(await imagesResponse([{ url: 'https://cdn.elsewhere.example/out.png' }]))
      .mockResolvedValueOnce(new Response('<html>sign in</html>'))
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(
      /Studio FLUX returned something that is not a PNG, JPEG or WebP image/,
    )
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(await imagesResponse([]))
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(/Studio FLUX returned no image/)
  })

  it('passes the endpoint’s own refusal on, and tells a person to fix their key in Settings', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'prompt blocked by the safety filter' } }), { status: 200 }),
    )
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(
      /Studio FLUX did not generate an image: prompt blocked by the safety filter/,
    )
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('denied', { status: 403 }))
    const failure = generateImage('u1', { prompt: 'x' })
    await expect(failure).rejects.toThrow(
      /Studio FLUX rejected the API key \(403\)\. Update it in Settings → Doop Agent/,
    )
    await expect(failure).rejects.not.toThrow(new RegExp(PERSONAL_KEY))
  })

  it('reaches private hosts only when the operator allows them', async () => {
    unstubAllEnvs()
    mockedGetAccounts.mockResolvedValue([
      personal({ custom: { ...personal().custom!, baseUrl: 'http://127.0.0.1:7860/v1' } }),
    ])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(
      /Studio FLUX could not be reached: The base URL must start with https:\/\//,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
