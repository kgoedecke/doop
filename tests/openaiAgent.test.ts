import { afterEach, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { _internal, azureResponsesUrl, runAzureTurn } from '../server/openaiAgent.ts'
import { parseAuthCode } from '../server/modelAccounts.ts'

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
    expect(result.content).toEqual([
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
    expect(result.content).toEqual([{ type: 'tool_use', id: 'call_5', name: 'set_status', input: {} }])
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
    expect(result.content).toEqual([{ type: 'text', text: 'done' }])
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
    expect(result.content).toEqual([
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
    expect(fromResponse(body).content).toEqual([{ type: 'text', text: 'authoritative' }])
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
    expect(fromResponse(body).content).toEqual([{ type: 'text', text: 'split' }])
  })
})
