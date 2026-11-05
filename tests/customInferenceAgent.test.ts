import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import { customConfig, geminiConfig, openrouterConfig, runChatCompletionsTurn } from '../server/chatCompletionsAgent.ts'
import { customModels } from '../server/modelCatalog.ts'
import { ModelAuthError, ModelUnavailableError } from '../server/openaiAgent.ts'
import { MAX_DISCOVERED_MODELS, type CustomModelProfile } from '../server/customModelProfiles.ts'

/**
 * A custom endpoint is the one Chat Completions transport whose URL a user
 * controls. These tests keep its request contract identical to the fixed
 * providers while proving the request goes through the safe custom boundary,
 * and that its model list is passed through without vendor-family filters.
 */

type Mode = 'ok' | 'auth' | 'missing' | 'malformed' | 'completion-error' | 'models-large' | 'models-invalid'

let mode: Mode = 'ok'
let provider: http.Server
let base: string
const seen: { path: string; auth: string; body?: string }[] = []

const PROFILE: CustomModelProfile = {
  id: 'profile-1',
  userId: 'alice',
  name: 'Local endpoint',
  baseUrl: 'http://127.0.0.1/v1',
  apiKey: 'sk-custom-secret',
  model: 'vendor/designer-9',
  supportsVision: false,
  connectedAt: 1,
  updatedAt: 1,
}

beforeAll(async () => {
  provider = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push({
        path: url.pathname,
        auth: String(req.headers.authorization ?? ''),
        ...(body ? { body } : {}),
      })
      const json = (status: number, value: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (mode === 'auth') return json(401, { error: 'no' })
      if (mode === 'missing') return json(404, { error: 'no' })
      if (mode === 'malformed') return res.writeHead(200, { 'content-type': 'application/json' }).end('{oops')
      if (mode === 'completion-error') return json(200, { error: { message: 'invalid key sk-do-not-leak' } })
      if (url.pathname.endsWith('/models')) {
        if (mode === 'models-large')
          return json(200, { data: Array.from({ length: 600 }, (_, i) => ({ id: `m-${i}` })) })
        if (mode === 'models-invalid')
          return json(200, { data: [{ id: 'valid-id' }, { id: 'bad id' }, { id: 'another:valid' }] })
        return json(200, {
          data: [
            { id: 'vendor/designer-9', created: 3 },
            { id: 'llama-4.2-70b', display_name: 'Llama 4.2', created: 2 },
            { id: 'vendor/designer-9' },
          ],
        })
      }
      return json(200, {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'working',
              tool_calls: [{ id: 'call_1', function: { name: 'create_frame', arguments: '{"name":"Hero"}' } }],
            },
          },
        ],
      })
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`
}, 30_000)

afterAll(() => new Promise<void>((resolve) => provider.close(() => resolve())))

beforeEach(() => {
  mode = 'ok'
  seen.length = 0
  stubEnv('CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS', '1')
})

afterEach(unstubAllEnvs)

const req = {
  system: 'be a designer',
  tools: [
    {
      name: 'create_frame',
      description: 'Make a frame',
      input_schema: { type: 'object' as const, properties: { name: { type: 'string' } } },
    },
  ],
  messages: [{ role: 'user' as const, content: 'make a hero' }],
  maxTokens: 16_000,
}

describe('custom chat completions', () => {
  it('posts to the base URL’s /chat/completions with the optional Bearer header and the existing body contract', async () => {
    const config = customConfig(new URL(`${base}/v1`), PROFILE.apiKey, PROFILE.model, true, PROFILE.name)
    const result = await runChatCompletionsTurn(config, req)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.path).toBe('/v1/chat/completions')
    expect(seen[0]!.auth).toBe('Bearer sk-custom-secret')
    const body = JSON.parse(seen[0]!.body!) as Record<string, unknown>
    expect(body).toMatchObject({ model: PROFILE.model, tool_choice: 'auto', max_tokens: 16_000 })
    expect(body.messages).toEqual([
      { role: 'system', content: 'be a designer' },
      { role: 'user', content: 'make a hero' },
    ])
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'create_frame',
          description: 'Make a frame',
          parameters: req.tools[0]!.input_schema,
        },
      },
    ])
    expect(result).toMatchObject({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 'call_1', name: 'create_frame', input: { name: 'Hero' } },
      ],
    })
  })

  it('omits Authorization for a keyless local endpoint', async () => {
    await runChatCompletionsTurn(customConfig(new URL(`${base}/v1`), undefined, 'local-model', true, 'Local'), req)
    expect(seen[0]!.auth).toBe('')
  })

  it('strips images when the profile says the model cannot see them', async () => {
    const config = customConfig(new URL(`${base}/v1`), undefined, 'text-model', false, 'Text only')
    await runChatCompletionsTurn(config, {
      ...req,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            },
          ],
        },
      ],
    })
    expect(seen[0]!.body).not.toContain('image_url')
    expect(seen[0]!.body).toContain('image omitted')
  })

  it('maps auth, missing routes and malformed bodies without echoing the key or body', async () => {
    const config = customConfig(new URL(`${base}/v1`), 'sk-do-not-leak', 'm', true, 'Custom')
    mode = 'auth'
    const auth = await runChatCompletionsTurn(config, req).catch((error: unknown) => error)
    expect(auth).toBeInstanceOf(ModelAuthError)
    expect(String(auth)).not.toContain('sk-do-not-leak')

    mode = 'missing'
    expect(await runChatCompletionsTurn(config, req).catch((error: unknown) => error)).toBeInstanceOf(
      ModelUnavailableError,
    )

    mode = 'malformed'
    expect(await runChatCompletionsTurn(config, req).catch((error: unknown) => error)).toBeInstanceOf(
      ModelUnavailableError,
    )
  })

  it('does not expose an endpoint error message that contains the saved API key', async () => {
    mode = 'completion-error'
    const error = await runChatCompletionsTurn(
      customConfig(new URL(`${base}/v1`), 'sk-do-not-leak', 'm', true, 'Custom'),
      req,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ModelUnavailableError)
    expect(String(error)).not.toContain('sk-do-not-leak')
    expect(String(error)).not.toContain('invalid key')
  })

  it('keeps the fixed provider configs on their trusted URLs', () => {
    expect(openrouterConfig('sk-or-x', 'm', true).url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(geminiConfig('AIza', 'm', true).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    )
    expect(openrouterConfig('sk-or-x', 'm', true).customBaseUrl).toBeUndefined()
    expect(geminiConfig('AIza', 'm', true).customBaseUrl).toBeUndefined()
  })
})

describe('custom model catalog', () => {
  const profile = (overrides: Partial<CustomModelProfile> = {}): CustomModelProfile => ({
    ...PROFILE,
    baseUrl: `${base}/v1`,
    ...overrides,
  })

  it('returns every advertised id, deduped, without vendor-family filtering', async () => {
    const models = await customModels(profile(), AbortSignal.timeout(5_000))
    expect(models).toEqual([
      { id: 'vendor/designer-9', name: 'vendor/designer-9', blurb: '', vision: false },
      { id: 'llama-4.2-70b', name: 'Llama 4.2', blurb: '', vision: false },
    ])
    expect(seen[0]).toMatchObject({ path: '/v1/models', auth: 'Bearer sk-custom-secret' })
  })

  it('sends no key for a keyless profile and uses its vision flag', async () => {
    const models = await customModels(profile({ apiKey: undefined, supportsVision: true }), AbortSignal.timeout(5_000))
    expect(models.every((model) => model.vision)).toBe(true)
    expect(seen[0]!.auth).toBe('')
  })

  it('filters invalid ids from the live catalog using the custom model id policy', async () => {
    mode = 'models-invalid'
    const models = await customModels(profile(), AbortSignal.timeout(5_000))
    expect(models.map((model) => model.id)).toEqual(['valid-id', 'another:valid'])
  })

  it('caps the live catalog at the same bounded model count as endpoint testing', async () => {
    mode = 'models-large'
    const models = await customModels(profile(), AbortSignal.timeout(5_000))
    expect(models).toHaveLength(MAX_DISCOVERED_MODELS)
  })

  it('fails visibly for auth, missing and malformed catalogs so the caller can fall back', async () => {
    mode = 'auth'
    await expect(customModels(profile(), AbortSignal.timeout(5_000))).rejects.toThrow()
    mode = 'missing'
    await expect(customModels(profile(), AbortSignal.timeout(5_000))).rejects.toThrow()
    mode = 'malformed'
    await expect(customModels(profile(), AbortSignal.timeout(5_000))).rejects.toThrow()
  })
})

describe('custom abort cancellation', () => {
  let abortProvider: http.Server
  let abortBase: string
  let sawRequestClose = false
  let requestReceived = false
  let releaseResponse: (() => void) | undefined
  const releaseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })

  beforeAll(async () => {
    abortProvider = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        requestReceived = true
        req.socket.on('close', () => {
          sawRequestClose = true
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        void releaseGate.then(() => {
          res.end(JSON.stringify({ choices: [{ message: { content: 'done' } }] }))
        })
      } else {
        res.writeHead(404).end()
      }
    })
    await new Promise<void>((resolve) => abortProvider.listen(0, '127.0.0.1', resolve))
    abortBase = `http://127.0.0.1:${(abortProvider.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => abortProvider.close(() => resolve())))

  beforeEach(() => {
    sawRequestClose = false
    requestReceived = false
    stubEnv('CUSTOM_INFERENCE_ALLOW_PRIVATE_URLS', '1')
  })

  afterEach(unstubAllEnvs)

  function waitFor(predicate: () => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (predicate()) resolve()
        else setTimeout(check, 5)
      }
      check()
    })
  }

  it('forwards abort cancellation into the custom undici request', async () => {
    const controller = new AbortController()
    const promise = runChatCompletionsTurn(
      customConfig(new URL(`${abortBase}/v1`), 'test-key', 'model-a', false, 'Example'),
      {
        system: 'sys',
        tools: [],
        messages: [],
        maxTokens: 10,
        signal: controller.signal,
      },
    )

    const requestStarted = waitFor(() => requestReceived)
    await Promise.race([
      requestStarted,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('fixture request wait timed out')), 2000)),
    ])
    controller.abort()
    releaseResponse?.()

    await expect(promise).rejects.toThrow(/aborted|cancel/i)
    await Promise.race([
      waitFor(() => sawRequestClose),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('request close wait timed out')), 2000)),
    ])
  }, 15000)
})
