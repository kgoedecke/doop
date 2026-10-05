import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * generate_image rides the Responses API's hosted image tool on whichever
 * account pays for the run. These tests pin the request the two transports
 * send (the Codex backend is picky about its shape) and the way the finished
 * image is pulled out of the stream — without ever calling OpenAI.
 */

vi.mock('../server/modelAccounts.ts', () => ({
  getAccount: vi.fn(),
  withFreshToken: vi.fn((account: unknown) => Promise.resolve(account)),
}))

/* the image-model preference lives in the DB; tests pick per-case */
vi.mock('../server/imagePrefs.ts', () => ({
  getImagePref: vi.fn(() => Promise.resolve(undefined)),
}))

import { getAccount } from '../server/modelAccounts.ts'
import { getImagePref } from '../server/imagePrefs.ts'
import { _internal, generateImage, generatorFor } from '../server/imageGen.ts'
import sharp from 'sharp'

const mockedGetAccount = vi.mocked(getAccount)
const mockedGetImagePref = vi.mocked(getImagePref)

async function tinyPng(): Promise<string> {
  const buf = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#e5533c' } })
    .png()
    .toBuffer()
  return buf.toString('base64')
}

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n`).join('\n')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function imageStream(): Promise<Response> {
  return sse([
    { type: 'response.created' },
    {
      type: 'response.output_item.done',
      item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: await tinyPng() },
    },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
  ])
}

afterEach(() => {
  vi.restoreAllMocks()
  mockedGetAccount.mockReset()
  mockedGetImagePref.mockReset()
  mockedGetImagePref.mockResolvedValue(undefined)
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.ARK_API_KEY
})

describe('the hosted image_generation request', () => {
  it('forces the hosted tool with the size for the aspect', () => {
    const body = _internal.requestBody('gpt-5.6-terra', 'gpt-image-2', { prompt: 'a red circle', aspect: 'landscape' })
    expect(body.tool_choice).toEqual({ type: 'image_generation' })
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]).toMatchObject({ type: 'image_generation', size: '1536x1024', output_format: 'png' })
    /* the Codex path rejects a transparent background for gpt-image-2 */
    expect(body.tools[0]).not.toHaveProperty('background')
    /* the fronting model picks the tool arguments itself, so the size is
       restated where it cannot miss it */
    expect(body.input[0]!.content[0]!.text).toContain('1536x1024')
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
  })

  it('defaults to a square, medium-quality image', () => {
    const body = _internal.requestBody('gpt-5.6-terra', 'gpt-image-2', { prompt: 'x' })
    expect(body.tools[0]).toMatchObject({ size: '1024x1024', quality: 'medium' })
  })
})

describe('who pays', () => {
  it('runs on a connected ChatGPT subscription through the Codex backend', async () => {
    mockedGetAccount.mockResolvedValue({
      userId: 'u1',
      kind: 'chatgpt',
      accessToken: 'tok',
      accountId: 'acct',
      connectedAt: 1,
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(await imageStream())

    const image = await generateImage('u1', { prompt: 'a red circle' })

    expect(image.billedTo).toBe('ChatGPT')
    expect(image.mime).toBe('image/webp')
    expect(image.width).toBe(8)
    expect(image.preview.mime).toBe('image/jpeg')
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toContain('chatgpt.com/backend-api/codex/responses')
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
    expect(headers['chatgpt-account-id']).toBe('acct')
    expect(headers.originator).toBe('codex_cli_rs')
  })

  it('runs on a connected OpenAI key against api.openai.com', async () => {
    mockedGetAccount.mockResolvedValue({ userId: 'u1', kind: 'openai-key', apiKey: 'sk-user', connectedAt: 1 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(await imageStream())

    const image = await generateImage('u1', { prompt: 'a red circle' })

    expect(image.billedTo).toBe('OpenAI')
    expect(image.mime).toBe('image/webp')
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toContain('api.openai.com')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-user')
  })

  it('falls back to the server key only when the user connected nothing', async () => {
    mockedGetAccount.mockResolvedValue(null)
    expect((await generatorFor('u1')).ok).toBe(false)
    process.env.OPENAI_API_KEY = 'sk-server'
    const generator = await generatorFor('u1')
    expect(generator.ok && generator.label).toBe('server')
  })

  it('never bills the server when the account lookup itself fails', async () => {
    process.env.OPENAI_API_KEY = 'sk-server'
    mockedGetAccount.mockRejectedValue(new Error('db down'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(/could not read your connected model account/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('explains what to connect when nothing can pay', async () => {
    mockedGetAccount.mockResolvedValue(null)
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(
      /connect a ChatGPT subscription or OpenAI API key/,
    )
  })
})

describe('the image-model registry', () => {
  async function geminiResponse(): Promise<Response> {
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: await tinyPng() } }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  it('draws Nano Banana on a connected Gemini key with the aspect ratio', async () => {
    mockedGetAccount.mockResolvedValue({ userId: 'u1', kind: 'gemini-key', apiKey: 'AIzaTestKey123', connectedAt: 1 })
    mockedGetImagePref.mockResolvedValue('gemini-3.1-flash-image')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(await geminiResponse())

    const image = await generateImage('u1', { prompt: 'a red circle', aspect: 'landscape' })

    expect(image.billedTo).toBe('Gemini')
    expect(image.mime).toBe('image/webp')
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image')
    const headers = init!.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('AIzaTestKey123')
    const body = JSON.parse(String(init!.body)) as {
      generationConfig: { imageConfig: { aspectRatio: string }; responseModalities: string[] }
    }
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('3:2')
    expect(body.generationConfig.responseModalities).toContain('IMAGE')
  })

  it('draws Seedream on the server ARK key with an explicit size', async () => {
    mockedGetAccount.mockResolvedValue(null)
    mockedGetImagePref.mockResolvedValue('seedream-5-0-pro')
    process.env.ARK_API_KEY = 'ark-server'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: await tinyPng() }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const image = await generateImage('u1', { prompt: 'a hero backdrop', aspect: 'portrait' })

    expect(image.billedTo).toBe('server')
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toContain('bytepluses.com/api/v3/images/generations')
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>
    expect(body.model).toBe('seedream-5-0-pro')
    expect(body.size).toBe('1536x2304')
    expect(body.response_format).toBe('b64_json')
    expect(body.watermark).toBe(false)
  })

  it('refuses an explicit pick whose provider has no credentials, naming the fix', async () => {
    mockedGetAccount.mockResolvedValue({ userId: 'u1', kind: 'openai-key', apiKey: 'sk-user', connectedAt: 1 })
    mockedGetImagePref.mockResolvedValue('gemini-3.1-flash-image')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(/connect a Gemini API key/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to the first server-enabled model when nothing is connected and no pick was made', async () => {
    mockedGetAccount.mockResolvedValue(null)
    process.env.GEMINI_API_KEY = 'gm-server'
    const generator = await generatorFor('u1')
    expect(generator.ok && generator.label).toBe('server')
  })

  it('never runs a connected user on the server keys for another provider', async () => {
    mockedGetAccount.mockResolvedValue({ userId: 'u1', kind: 'openrouter-key', apiKey: 'sk-or-x', connectedAt: 1 })
    process.env.OPENAI_API_KEY = 'sk-server'
    process.env.GEMINI_API_KEY = 'gm-server'
    const generator = await generatorFor('u1')
    expect(generator.ok).toBe(false)
  })
})

describe('failure modes', () => {
  it('surfaces a prose refusal instead of a missing image', async () => {
    mockedGetAccount.mockResolvedValue({ userId: 'u1', kind: 'openai-key', apiKey: 'sk', connectedAt: 1 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse([
        {
          type: 'response.output_item.done',
          item: { type: 'message', content: [{ type: 'output_text', text: 'I cannot draw that.' }] },
        },
        { type: 'response.completed', response: { id: 'r', status: 'completed' } },
      ]),
    )
    await expect(generateImage('u1', { prompt: 'x' })).rejects.toThrow(/did not generate an image: I cannot draw that/)
  })

  it('rejects an empty prompt before spending anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(generateImage('u1', { prompt: '   ' })).rejects.toThrow(/non-empty/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

it('does not bill the server for image generation when a Claude API key is selected', async () => {
  mockedGetAccount.mockResolvedValue({ userId: 'alice', kind: 'anthropic-key', apiKey: 'sk-ant-test', connectedAt: 1 })
  vi.stubEnv('OPENAI_API_KEY', 'sk-server-test')
  try {
    expect(await generatorFor('alice')).toMatchObject({ ok: false })
  } finally {
    vi.unstubAllEnvs()
  }
})
