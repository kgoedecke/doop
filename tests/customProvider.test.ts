import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type Anthropic from '@anthropic-ai/sdk'
import {
  headersFromText,
  isCustomProviderKind,
  normalizeBaseUrl,
  parseCustomHeaders,
  parseCustomKey,
  parseCustomProviderConfig,
} from '../shared/customProvider.ts'
import { CustomProviderUrlError, customProviderFetch, reachableUrl } from '../server/customProviderFetch.ts'
import { customTurn } from '../server/agentModel.ts'
import { discoverCustomModels, testCustomProvider } from '../server/customProviders.ts'
import { IMAGE_OMITTED_NOTE } from '../server/chatCompletionsAgent.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * Custom providers: the shared validator, the guarded fetch that is the only
 * way a request reaches a URL a person typed, and the two transports against
 * a fake endpoint on loopback (reachable only with private hosts allowed).
 */

describe('the provider description', () => {
  const valid = {
    name: ' Acme ',
    apiType: 'openai-chat',
    baseUrl: 'https://llm.acme.example/v1/',
    models: [{ id: 'qwen3-coder', vision: true, maxOutputTokens: '32000' }, { id: 'glm-5' }],
    tokenParam: 'max_completion_tokens',
    echoReasoning: true,
  }

  it('normalises a valid description', () => {
    expect(parseCustomProviderConfig(valid)).toEqual({
      ok: true,
      value: {
        name: 'Acme',
        apiType: 'openai-chat',
        baseUrl: 'https://llm.acme.example/v1',
        models: [
          { id: 'qwen3-coder', vision: true, maxOutputTokens: 32000 },
          { id: 'glm-5', vision: false },
        ],
        tokenParam: 'max_completion_tokens',
        echoReasoning: true,
      },
    })
  })

  it('drops the Chat Completions options from an Anthropic provider', () => {
    const parsed = parseCustomProviderConfig({ ...valid, apiType: 'anthropic' })
    expect(parsed.ok && parsed.value).toEqual(expect.not.objectContaining({ tokenParam: expect.anything() }))
    expect(parsed.ok && parsed.value.echoReasoning).toBeUndefined()
  })

  it.each([
    [{ ...valid, name: '' }, 'name'],
    [{ ...valid, apiType: 'responses' }, 'API type'],
    [{ ...valid, models: [] }, 'at least one model'],
    [{ ...valid, models: [{ id: 'has space' }] }, 'without spaces'],
    [{ ...valid, models: [{ id: 'a' }, { id: 'a' }] }, 'listed twice'],
    [{ ...valid, models: [{ id: 'a', maxOutputTokens: 12 }] }, 'Max output tokens'],
    [{ ...valid, baseUrl: 'ftp://acme.example' }, 'https://'],
    [{ ...valid, baseUrl: 'https://user:pw@acme.example' }, 'API key field'],
    [{ ...valid, baseUrl: 'https://acme.example/v1?x=1' }, 'query string'],
  ])('refuses %j', (input, message) => {
    const parsed = parseCustomProviderConfig(input)
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.error).toContain(message)
  })

  it('checks the base URL on its own', () => {
    expect(normalizeBaseUrl('  https://a.example/v1//  ')).toEqual({ ok: true, value: 'https://a.example/v1' })
    expect(normalizeBaseUrl('').ok).toBe(false)
  })

  it('names custom kinds by a minted id only', () => {
    expect(isCustomProviderKind('custom:0123456789abcdef01')).toBe(true)
    expect(isCustomProviderKind('custom:../etc')).toBe(false)
    expect(isCustomProviderKind('openai-key')).toBe(false)
  })

  it('takes headers but never ones that re-route or re-frame the request', () => {
    expect(parseCustomHeaders({ 'X-Tenant': ' design ' })).toEqual({ ok: true, value: { 'X-Tenant': 'design' } })
    for (const name of ['Host', 'content-length', 'Cookie', 'Transfer-Encoding']) {
      expect(parseCustomHeaders({ [name]: 'x' }).ok).toBe(false)
    }
    expect(parseCustomHeaders({ 'X-A': 'a\r\nX-B: b' }).ok).toBe(false)
    expect(parseCustomHeaders({ 'bad name': 'x' }).ok).toBe(false)
    expect(parseCustomHeaders({ 'X-A': '1', 'x-a': '2' }).ok).toBe(false)
    expect(headersFromText('X-A: 1\n\nX-B: two: parts')).toEqual({
      ok: true,
      value: { 'X-A': '1', 'X-B': 'two: parts' },
    })
    expect(headersFromText('X-A: 1\nX-A: 2').ok).toBe(false)
    expect(headersFromText('no colon').ok).toBe(false)
  })

  it('takes an optional key without whitespace', () => {
    expect(parseCustomKey(undefined)).toEqual({ ok: true, value: '' })
    expect(parseCustomKey(' sk-1 ')).toEqual({ ok: true, value: 'sk-1' })
    expect(parseCustomKey('sk 1').ok).toBe(false)
  })
})

describe('which URLs the server may reach', () => {
  afterEach(unstubAllEnvs)

  it('only reaches public https hosts by default', () => {
    expect(reachableUrl('https://api.example.com/v1').href).toBe('https://api.example.com/v1')
    for (const url of [
      'http://api.example.com/v1',
      'https://localhost:8000/v1',
      'https://127.0.0.1/v1',
      'https://10.0.0.5/v1',
      'https://169.254.169.254/latest',
      'https://[::1]/v1',
      'https://models.internal/v1',
      'https://vllm/v1',
    ]) {
      expect(() => reachableUrl(url), url).toThrow(CustomProviderUrlError)
    }
  })

  it('reaches private hosts and plain http once the operator allows them', () => {
    stubEnv('DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS', 'true')
    expect(reachableUrl('http://127.0.0.1:11434/v1').host).toBe('127.0.0.1:11434')
    expect(() => reachableUrl('file:///etc/passwd')).toThrow(CustomProviderUrlError)
  })

  it('refuses a private address before connecting', async () => {
    await expect(customProviderFetch('https://127.0.0.1:1/v1/models')).rejects.toThrow(CustomProviderUrlError)
  })
})

/* ---------------------------------------------------------------- */
/* a fake endpoint on loopback                                       */
/* ---------------------------------------------------------------- */

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

let server: http.Server
let base = ''
const seen: Seen[] = []
let reply: (req: Seen, res: http.ServerResponse) => void = () => {}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    req.on('end', () => {
      const entry: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      }
      seen.push(entry)
      reply(entry, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const toolCall = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [{ id: 'call_1', function: { name: 'report_ready', arguments: '{"ready":true}' } }],
      },
    },
  ],
}

const TOOL: Anthropic.Tool = { name: 'report_ready', input_schema: { type: 'object', properties: {} } }

const screenshot: Anthropic.MessageParam = {
  role: 'user',
  content: [
    { type: 'text', text: 'Look at this' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
  ],
}

describe('a custom provider’s turns', () => {
  beforeAll(() => stubEnv('DOOP_CUSTOM_PROVIDER_PRIVATE_HOSTS', 'true'))
  afterAll(unstubAllEnvs)
  afterEach(() => {
    seen.length = 0
  })

  it('sends Chat Completions with its headers, its output field and the model’s cap', async () => {
    reply = (_req, res) => json(res, 200, toolCall)
    const run = customTurn(
      {
        config: {
          name: 'Acme',
          apiType: 'openai-chat',
          baseUrl: `${base}/v1`,
          models: [],
          tokenParam: 'max_completion_tokens',
        },
        apiKey: 'sk-acme',
        headers: { 'X-Tenant': 'design' },
      },
      { id: 'qwen3-coder', vision: false, maxOutputTokens: 4096 },
    )
    const result = await run({ system: [{ text: 'sys' }], tools: [TOOL], messages: [screenshot], maxTokens: 16000 })
    expect(result.stop_reason).toBe('tool_use')
    const [request] = seen
    expect(request).toMatchObject({ method: 'POST', url: '/v1/chat/completions' })
    expect(request!.headers).toMatchObject({ authorization: 'Bearer sk-acme', 'x-tenant': 'design' })
    expect(request!.body).toMatchObject({ model: 'qwen3-coder', max_completion_tokens: 4096 })
    expect(request!.body).not.toHaveProperty('max_tokens')
    /* the model was said not to see images: the screenshot becomes a note */
    expect(JSON.stringify(request!.body.messages)).toContain(IMAGE_OMITTED_NOTE)
    expect(JSON.stringify(request!.body.messages)).not.toContain('iVBORw0KGgo')
  })

  it('sends no Authorization at all when the endpoint takes no key', async () => {
    reply = (_req, res) => json(res, 200, toolCall)
    const run = customTurn(
      { config: { name: 'Local', apiType: 'openai-chat', baseUrl: base, models: [] } },
      { id: 'llama', vision: true },
    )
    await run({ system: [{ text: 'sys' }], tools: [TOOL], messages: [screenshot], maxTokens: 1000 })
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(seen[0]!.body).toMatchObject({ max_tokens: 1000 })
    expect(JSON.stringify(seen[0]!.body.messages)).toContain('iVBORw0KGgo')
  })

  it('speaks the Messages API to an Anthropic-compatible endpoint, keyless', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const events: [string, unknown][] = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'glm-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
        ],
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'report_ready', input: {} },
          },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: 3 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ]
      for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
    }
    const run = customTurn(
      {
        config: { name: 'Gateway', apiType: 'anthropic', baseUrl: `${base}/anthropic`, models: [] },
        headers: { 'X-Tenant': 'design' },
      },
      { id: 'glm-5', vision: true, maxOutputTokens: 2048 },
    )
    const result = await run({ system: [{ text: 'sys' }], tools: [TOOL], messages: [screenshot], maxTokens: 16000 })
    expect(result.stop_reason).toBe('tool_use')
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/anthropic/v1/messages' })
    expect(seen[0]!.headers['x-api-key']).toBeUndefined()
    expect(seen[0]!.headers['x-tenant']).toBe('design')
    expect(seen[0]!.body).toMatchObject({ model: 'glm-5', max_tokens: 2048 })
  })

  it('lists the endpoint’s models, deduplicated and without junk ids', async () => {
    reply = (_req, res) => json(res, 200, { data: [{ id: 'a' }, { id: 'a' }, { id: 'has space' }, { id: 'b' }] })
    const models = await discoverCustomModels({
      config: { apiType: 'openai-chat', baseUrl: `${base}/v1` },
      apiKey: 'k',
    })
    expect(models).toEqual(['a', 'b'])
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/models' })
    expect(seen[0]!.headers.authorization).toBe('Bearer k')
  })

  it('says when the endpoint refuses the key or lists nothing', async () => {
    reply = (_req, res) => json(res, 401, { error: 'nope' })
    await expect(discoverCustomModels({ config: { apiType: 'openai-chat', baseUrl: base } })).rejects.toThrow(
      /refused the key/,
    )
    reply = (_req, res) => json(res, 404, {})
    await expect(discoverCustomModels({ config: { apiType: 'anthropic', baseUrl: base } })).rejects.toThrow(
      /does not list/,
    )
    expect(seen.at(-1)?.url).toBe('/v1/models?limit=1000')
  })

  it('passes the test only when the model calls the tool', async () => {
    const target = { config: { name: 'Acme', apiType: 'openai-chat' as const, baseUrl: base, models: [] } }
    reply = (_req, res) => json(res, 200, toolCall)
    await expect(testCustomProvider(target, { id: 'm', vision: false })).resolves.toBeUndefined()
    reply = (_req, res) =>
      json(res, 200, { choices: [{ finish_reason: 'stop', message: { content: 'Sure, I am ready!' } }] })
    await expect(testCustomProvider(target, { id: 'm', vision: false })).rejects.toThrow(/without calling a tool/)
  })

  it('refuses to follow a redirect', async () => {
    reply = (_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' })
      res.end()
    }
    await expect(customProviderFetch(`${base}/v1/models`)).rejects.toThrow()
    expect(seen).toHaveLength(1)
  })
})
