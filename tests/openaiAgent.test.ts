import { afterEach, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  _internal,
  azureResponsesUrl,
  ModelUnavailableError,
  responseError,
  runAzureTurn,
  runOpenAiTurn,
} from '../server/openaiAgent.ts'
import { accountModelFor, parseAuthCode } from '../server/modelAccounts.ts'
import { getChatgptModelCatalog } from '../server/chatgptModels.ts'
import { getApiModelCatalog } from '../server/providerModels.ts'

/**
 * The Doop Agent loop is written against Anthropic's message shape. When a run
 * moves onto a user's ChatGPT subscription, every turn goes through this
 * translation — so these tests pin the parts that would silently corrupt a run:
 * tool-call round-tripping and the screenshots the agent verifies its work with.
 */

const { toInput, toTools, fromResponse, flattenToolResult } = _internal

type Item = { type: string; role?: string; call_id?: string; name?: string; output?: string; content?: unknown[] }

describe('Anthropic messages -> OpenAI Responses input', () => {
  it('round-trips a tool call and its result under one call id', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Fix the hero spacing.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 'call_42', name: 'edit_frame_html', input: { frame_id: 'f1' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_42', content: 'applied' }] },
    ]
    const items = toInput(messages) as Item[]

    const call = items.find((i) => i.type === 'function_call')
    const output = items.find((i) => i.type === 'function_call_output')
    expect(call?.call_id).toBe('call_42')
    expect(call?.name).toBe('edit_frame_html')
    /* the output must carry the SAME id — OpenAI rejects an unanswered call */
    expect(output?.call_id).toBe('call_42')
    expect(output?.output).toBe('applied')
    expect(items.indexOf(call!)).toBeLessThan(items.indexOf(output!))
  })

  it('re-attaches screenshot images as a following user message', () => {
    /* function_call_output is text-only, so an image returned by
       screenshot_frame has to ride along separately or the agent verifies
       its work blind */
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_7',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
              { type: 'text', text: 'frame rendered' },
            ],
          },
        ],
      },
    ]
    const items = toInput(messages) as Item[]

    const output = items.find((i) => i.type === 'function_call_output')
    expect(output?.output).toContain('frame rendered')
    const message = items.find((i) => i.type === 'message' && i.role === 'user')
    const parts = (message?.content ?? []) as { type: string; image_url?: string }[]
    expect(parts[0]?.type).toBe('input_image')
    expect(parts[0]?.image_url).toBe('data:image/png;base64,AAAA')
    /* images come after the output they belong to */
    expect(items.indexOf(output!)).toBeLessThan(items.indexOf(message!))
  })

  it('marks failed tool results as errors so the model can recover', () => {
    const flat = flattenToolResult({
      type: 'tool_result',
      tool_use_id: 'call_9',
      is_error: true,
      content: '"find" text not found',
    })
    expect(flat.text).toBe('Error: "find" text not found')
  })

  it('keeps each tool schema intact', () => {
    const tools = toTools([
      {
        name: 'screenshot_frame',
        description: 'Render a frame',
        input_schema: { type: 'object', properties: { frame_id: { type: 'string' } }, required: ['frame_id'] },
      },
    ]) as { type: string; name: string; parameters: unknown }[]
    expect(tools[0]?.type).toBe('function')
    expect(tools[0]?.name).toBe('screenshot_frame')
    expect(tools[0]?.parameters).toEqual({
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    })
  })
})

describe('OpenAI Responses output -> Anthropic blocks', () => {
  it('reads text and tool calls, and reports tool_use', () => {
    const result = fromResponse({
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1' },
        { type: 'message', content: [{ type: 'output_text', text: 'Tightening the hero.' }] },
        { type: 'function_call', call_id: 'call_3', name: 'set_status', arguments: '{"status":"Fixing hero"}' },
      ],
    })
    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toMatchObject([
      { type: 'text', text: 'Tightening the hero.' },
      { type: 'tool_use', id: 'call_3', name: 'set_status', input: { status: 'Fixing hero' } },
    ])
  })

  it('surfaces a truncated response as max_tokens so the loop can nudge', () => {
    const result = fromResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
    })
    expect(result.stop_reason).toBe('max_tokens')
  })

  it('surfaces a refusal', () => {
    const result = fromResponse({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
    })
    expect(result.stop_reason).toBe('refusal')
  })

  it('treats an empty response as a failure rather than a finished turn', () => {
    expect(() => fromResponse({ status: 'completed', output: [] })).toThrow()
  })

  it('does not lose a tool call whose arguments are malformed', () => {
    const result = fromResponse({
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_5', name: 'set_status', arguments: '{oops' }],
    })
    expect(result.content).toMatchObject([{ type: 'tool_use', id: 'call_5', name: 'set_status', input: {} }])
  })
})

describe('ChatGPT model discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends the selected discovered model to subscription inference without a static alias', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }] } })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
    vi.stubGlobal('fetch', fetch)
    const result = await runOpenAiTurn(
      {
        userId: 'selected-catalog-model',
        kind: 'chatgpt',
        accessToken: 'private-token',
        connectedAt: 1,
        model: 'future-model',
      },
      { system: 'Check the canvas.', messages: [{ role: 'user', content: 'Confirm.' }], tools: [], maxTokens: 128 },
    )
    expect(result.content).toMatchObject([{ type: 'text', text: 'Done' }])
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ model: 'future-model' })
  })

  it('discovers new visible screenshot-capable models and shares concurrent requests', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              slug: 'future-model',
              display_name: 'Future model',
              description: 'From the account catalog',
              visibility: 'list',
              input_modalities: ['text', 'image'],
            },
            { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide', input_modalities: ['text', 'image'] },
            { slug: 'text-only', display_name: 'Text only', visibility: 'list', input_modalities: ['text'] },
            { slug: 'invalid' },
          ],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const account = {
      userId: 'catalog-concurrent',
      kind: 'chatgpt' as const,
      accessToken: 'private-token',
      accountId: 'account-a',
      connectedAt: 1,
    }
    const [first, second] = await Promise.all([getChatgptModelCatalog(account), getChatgptModelCatalog(account)])
    expect(first).toEqual({
      models: [{ id: 'future-model', name: 'Future model', blurb: 'From the account catalog', vision: true }],
    })
    expect(second).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(first)).not.toContain('private-token')
    const [url, options] = fetch.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/backend-api/codex/models')
    expect(options.headers).toMatchObject({ Authorization: 'Bearer private-token', 'chatgpt-account-id': 'account-a' })
    expect(options.redirect).toBe('error')
  })

  it('keeps the last catalog during a transient failure but never carries it to another account', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              { slug: 'model-a', display_name: 'Model A', visibility: 'list', input_modalities: ['text', 'image'] },
            ],
          }),
        ),
      )
      .mockRejectedValue(new Error('provider unavailable'))
    vi.stubGlobal('fetch', fetch)
    const account = {
      userId: 'catalog-stale',
      kind: 'chatgpt' as const,
      accessToken: 'token-a',
      accountId: 'account-a',
      connectedAt: 1,
    }
    const live = await getChatgptModelCatalog(account)
    now += 5 * 60_000 + 1
    const stale = await getChatgptModelCatalog(account)
    expect(stale.models).toEqual(live.models)
    expect(stale.warning).toContain('last fetched list')
    await getChatgptModelCatalog(account)
    expect(fetch).toHaveBeenCalledTimes(2)
    const changed = await getChatgptModelCatalog({ ...account, accountId: 'account-b', accessToken: 'token-b' })
    expect(changed.models).toEqual([])
    expect(changed.warning).toContain('Could not load')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('removes cached choices when the account credentials are rejected', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              models: [
                { slug: 'model-a', display_name: 'Model A', visibility: 'list', input_modalities: ['text', 'image'] },
              ],
            }),
          ),
        )
        .mockResolvedValueOnce(new Response('', { status: 401 })),
    )
    const account = {
      userId: 'catalog-rejected',
      kind: 'chatgpt' as const,
      accessToken: 'rejected-token',
      connectedAt: 1,
    }
    expect((await getChatgptModelCatalog(account)).models).toHaveLength(1)
    now += 5 * 60_000 + 1
    const rejected = await getChatgptModelCatalog(account)
    expect(rejected.models).toEqual([])
    expect(rejected.warning).toContain('Reconnect')
  })
})

describe('model menu', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('defaults to Terra when no override is set, whatever this shell exports', async () => {
    vi.stubEnv('DOOP_AGENT_OPENAI_MODEL', '')
    vi.resetModules()
    const fresh = await import('../server/openaiAgent.ts')
    expect(fresh.DEFAULT_OPENAI_MODEL).toBe('gpt-5.6-terra')
  })

  it('tells a model the account cannot run apart from a dead credential', async () => {
    const noAccess = await responseError(
      new Response(
        JSON.stringify({
          error: {
            message: 'The model `gpt-6-astra` does not exist or you do not have access to it.',
            code: 'model_not_found',
          },
        }),
        { status: 404 },
      ),
      'ChatGPT',
    )
    expect(noAccess).toBeInstanceOf(ModelUnavailableError)
    expect(noAccess.message).toContain('gpt-6-astra')

    const badRequest = await responseError(
      new Response('Invalid value for reasoning.effort', { status: 400 }),
      'OpenAI',
    )
    expect(badRequest).not.toBeInstanceOf(ModelUnavailableError)

    const denied = await responseError(new Response('denied', { status: 401 }), 'OpenAI')
    expect(denied).not.toBeInstanceOf(ModelUnavailableError)
  })
})

describe('ChatGPT redirect parsing', () => {
  it('accepts the whole pasted redirect URL', () => {
    expect(parseAuthCode('http://localhost:1455/auth/callback?code=abc123&state=xyz')).toEqual({
      code: 'abc123',
      state: 'xyz',
    })
  })

  it('accepts a bare code', () => {
    expect(parseAuthCode('  abc123 ')).toEqual({ code: 'abc123' })
  })

  it('reports OpenAI refusing the connection', () => {
    expect(() =>
      parseAuthCode('http://localhost:1455/auth/callback?error=access_denied&error_description=User+said+no'),
    ).toThrow(/User said no/)
  })

  it('rejects a redirect URL with no code', () => {
    expect(() => parseAuthCode('http://localhost:1455/auth/callback')).toThrow(/no \?code=/)
  })
})

describe('Azure OpenAI transport', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('appends the v1 Responses path to a bare resource endpoint', () => {
    expect(azureResponsesUrl('https://my-res.openai.azure.com')).toBe(
      'https://my-res.openai.azure.com/openai/v1/responses',
    )
    expect(azureResponsesUrl('https://my-res.openai.azure.com/')).toBe(
      'https://my-res.openai.azure.com/openai/v1/responses',
    )
  })

  it('uses an endpoint that already names …/responses as given (APIM front doors)', () => {
    expect(azureResponsesUrl('https://gateway.example.com/openai/v1/responses')).toBe(
      'https://gateway.example.com/openai/v1/responses',
    )
  })

  it('authenticates with api-key, runs the deployment, and sends no reasoning block by default', async () => {
    let seen: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {}
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) }
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
        }),
        { status: 200 },
      )
    })
    const result = await runAzureTurn(
      { endpoint: 'https://my-res.openai.azure.com', deployment: 'my-gpt', apiKey: 'azkey' },
      { system: 'be a designer', tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096 },
    )
    expect(result.content).toMatchObject([{ type: 'text', text: 'done' }])
    expect(seen.url).toBe('https://my-res.openai.azure.com/openai/v1/responses')
    expect(seen.headers?.['api-key']).toBe('azkey')
    expect(seen.headers?.Authorization).toBeUndefined()
    expect(seen.body?.model).toBe('my-gpt')
    expect(seen.body?.max_output_tokens).toBe(4096)
    /* a non-reasoning deployment 400s on a reasoning block — absent unless
       AZURE_OPENAI_REASONING_EFFORT opts in */
    expect(seen.body).not.toHaveProperty('reasoning')
  })

  it('surfaces rejected credentials as an auth error', async () => {
    vi.stubGlobal('fetch', async () => new Response('denied', { status: 401 }))
    await expect(
      runAzureTurn(
        { endpoint: 'https://my-res.openai.azure.com', deployment: 'my-gpt', apiKey: 'stale' },
        { system: '', tools: [], messages: [], maxTokens: 100 },
      ),
    ).rejects.toThrow(/credentials/)
  })
})

describe('Codex-backend SSE stream', () => {
  const sse = (lines: string[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const l of lines) controller.enqueue(new TextEncoder().encode(l))
          controller.close()
        },
      }),
    )

  /* The Codex backend's response.completed carries only bookkeeping — reading
     output off it alone produced an empty turn on every real run. */
  it('accumulates output items when the completed event carries no output', async () => {
    const body = await _internal.readEventStream(
      sse([
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n',
        'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1"}}\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"set_status","arguments":"{\\"status\\":\\"Working\\"}"}}\n',
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n',
        'data: [DONE]\n',
      ]),
    )
    const result = fromResponse(body)
    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toMatchObject([
      { type: 'tool_use', id: 'call_1', name: 'set_status', input: { status: 'Working' } },
    ])
  })

  it('prefers the completed event own output when it has one (api.openai.com)', async () => {
    const body = await _internal.readEventStream(
      sse([
        'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"streamed"}]}}\n',
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"authoritative"}]}]}}\n',
      ]),
    )
    expect(fromResponse(body).content).toMatchObject([{ type: 'text', text: 'authoritative' }])
  })

  it('surfaces a failed stream instead of reporting an empty turn', async () => {
    await expect(
      _internal.readEventStream(
        sse(['data: {"type":"response.failed","response":{"error":{"message":"model overloaded"}}}\n']),
      ),
    ).rejects.toThrow(/model overloaded/)
  })

  it('handles events split across chunk boundaries', async () => {
    const body = await _internal.readEventStream(
      sse([
        'data: {"type":"response.output_item.done","item":{"type":"mess',
        'age","content":[{"type":"output_text","text":"split"}]}}\n',
        'data: {"type":"response.completed","response":{"status":"completed"}}\n',
      ]),
    )
    expect(fromResponse(body).content).toMatchObject([{ type: 'text', text: 'split' }])
  })
})

describe('API-key model discovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('replays encrypted reasoning, assistant phases and calls unchanged through consecutive OpenAI tool steps', async () => {
    const outputs = [1, 2].map((step) => [
      { type: 'reasoning', id: `rs_${step}`, encrypted_content: `synthetic-reasoning-${step}`, summary: [] },
      {
        type: 'message',
        id: `msg_${step}`,
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: `Step ${step}`, annotations: [] }],
      },
      { type: 'function_call', id: `fc_${step}`, call_id: `call_${step}`, name: 'set_status', arguments: '{}' },
    ])
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ output: outputs[0] }))
      .mockResolvedValueOnce(Response.json({ output: outputs[1] }))
      .mockResolvedValueOnce(
        Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }] }),
      )
    const account = {
      userId: 'replay',
      kind: 'openai-key' as const,
      apiKey: 'synthetic',
      connectedAt: 1,
      model: 'gpt-6.1-sol',
    }
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'Design.' }]
    for (const step of [1, 2]) {
      const result = await runOpenAiTurn(account, { system: 'Design.', tools: [], messages, maxTokens: 32000 })
      messages.push(
        { role: 'assistant', content: result.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${step}`, content: 'ok' }] },
      )
    }
    await runOpenAiTurn(account, { system: 'Design.', tools: [], messages, maxTokens: 32000 })
    const body = JSON.parse(String(fetch.mock.calls[2]![1]?.body))
    expect(body.model).toBe(account.model)
    expect(body.store).toBe(false)
    expect(body.include).toContain('reasoning.encrypted_content')
    expect(body.input.slice(1)).toEqual([
      ...outputs[0]!,
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ...outputs[1]!,
      { type: 'function_call_output', call_id: 'call_2', output: 'ok' },
    ])
  })

  it('filters OpenAI special-purpose models and sends the selected discovered ID unchanged', async () => {
    const ids = [
      'gpt-6.1-sol',
      'gpt-5.6-terra',
      'gpt-6-astra',
      'gpt-6-sol-chat-latest',
      'gpt-6-sol-codex',
      'gpt-image-2',
      'text-embedding-3-large',
      'gpt-audio',
      'o3-deep-research',
      'unknown-model',
    ]
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: ids.map((id, created) => ({ id, created })) }))
      .mockResolvedValueOnce(
        Response.json({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }],
        }),
      )
    const account = {
      userId: 'openai-catalog',
      kind: 'openai-key' as const,
      apiKey: 'sk-synthetic',
      connectedAt: 1,
      model: 'gpt-6.1-sol',
    }
    const catalog = await getApiModelCatalog(account)
    expect(catalog.models.map((m) => m.id).sort()).toEqual(['gpt-5.6-terra', 'gpt-6-astra', 'gpt-6.1-sol'])
    await runOpenAiTurn(account, { system: 'Design.', tools: [], messages: [], maxTokens: 128 })
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body)).model).toBe('gpt-6.1-sol')
    expect(JSON.stringify(catalog)).not.toContain(account.apiKey)
  })

  it('paginates Claude, checks capabilities and preserves new model IDs rather than CLI aliases', async () => {
    const model = (id: string, supported = true, max_tokens = 64000) => ({
      id,
      display_name: id,
      max_tokens,
      capabilities: { image_input: { supported } },
    })
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          data: [model('claude-opus-5-5'), model('claude-haiku-4-5', false), model('claude-sonnet-4', true, 8192)],
          has_more: true,
          last_id: 'cursor-one',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            model('claude-sonnet-5-5'),
            { ...model('claude-opus-4'), lifecycle: 'retired' },
            { id: 'claude-fable-5-1', display_name: 'Unknown capabilities' },
          ],
          has_more: false,
        }),
      )
    const account = {
      userId: 'claude-catalog',
      kind: 'anthropic-key' as const,
      apiKey: 'sk-ant-synthetic',
      connectedAt: 1,
      model: 'claude-opus-5-5',
    }
    const catalog = await getApiModelCatalog(account)
    expect(catalog.models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get('after_id')).toBe('cursor-one')
    expect(accountModelFor(account)).toBe('claude-opus-5-5')
    expect(JSON.stringify(catalog)).not.toContain(account.apiKey)
  })

  it('paginates Gemini and excludes image, audio, Live, embeddings and unsupported generation methods', async () => {
    const model = (id: string, methods = ['generateContent'], outputTokenLimit = 65536) => ({
      name: `models/${id}`,
      displayName: id,
      supportedGenerationMethods: methods,
      outputTokenLimit,
    })
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          models: [
            model('gemini-3.8-flash'),
            model('gemini-3.8-flash-tts'),
            model('gemini-3.1-flash-image'),
            model('gemini-3.8-live'),
          ],
          nextPageToken: 'next',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          models: [
            model('gemini-4-argon'),
            model('gemini-3.1-pro-preview'),
            { ...model('gemini-2.5-flash-preview-09-2025'), displayName: undefined },
            model('gemini-embedding-001', ['embedContent']),
            model('gemini-3.5-flash', ['interactions']),
            model('gemini-2.5-flash', ['generateContent'], 8192),
          ],
        }),
      )
    const account = {
      userId: 'gemini-catalog',
      kind: 'gemini-key' as const,
      apiKey: 'synthetic-google-key',
      connectedAt: 1,
    }
    const catalog = await getApiModelCatalog(account)
    expect(catalog.models.map((m) => m.id)).toEqual([
      'gemini-4-argon',
      'gemini-3.8-flash',
      'gemini-3.1-pro-preview',
      'gemini-2.5-flash-preview-09-2025',
    ])
    expect(catalog.models.at(-1)?.name).toBe('gemini-2.5-flash-preview-09-2025')
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get('pageToken')).toBe('next')
    expect(String(fetch.mock.calls[0]![0])).not.toContain(account.apiKey)
    expect(fetch.mock.calls[0]![1]?.headers).toEqual({ 'x-goog-api-key': account.apiKey })
  })

  it('coalesces reads, retains a same-key catalog on outages, and clears it on rejection or rotation', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'gpt-6.1-sol', created: 1 }] }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
    const account = { userId: 'api-cache', kind: 'openai-key' as const, apiKey: 'synthetic-first', connectedAt: 1 }
    const [first, shared] = await Promise.all([getApiModelCatalog(account), getApiModelCatalog(account)])
    expect(shared).toEqual(first)
    expect(fetch).toHaveBeenCalledTimes(1)
    now += 300001
    expect(await getApiModelCatalog(account)).toMatchObject({
      models: first.models,
      warning: expect.stringContaining('last fetched'),
    })
    now += 30001
    expect(await getApiModelCatalog(account)).toMatchObject({
      models: [],
      warning: expect.stringContaining('permission'),
    })
    expect(await getApiModelCatalog({ ...account, apiKey: 'synthetic-second' })).toMatchObject({
      models: [],
      warning: expect.any(String),
    })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('never serves a partially fetched catalog when pagination fails or repeats', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        data: [
          {
            id: 'claude-opus-5-5',
            display_name: 'Opus',
            max_tokens: 64000,
            capabilities: { image_input: { supported: true } },
          },
        ],
        has_more: true,
        last_id: 'same',
      }),
    )
    const result = await getApiModelCatalog({
      userId: 'bad-pages',
      kind: 'anthropic-key',
      apiKey: 'synthetic',
      connectedAt: 1,
    })
    expect(result.models).toEqual([])
    expect(result.warning).toContain('Could not load')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
