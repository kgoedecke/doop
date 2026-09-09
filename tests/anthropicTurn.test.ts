import http from 'node:http'
import type { AddressInfo } from 'node:net'
import Anthropic from '@anthropic-ai/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAnthropicTurn } from '../server/agentModel.ts'

/**
 * The server tier's Anthropic turn must stream. GitHub recon asks for 32k
 * output tokens per turn, and the SDK refuses a NON-streaming request that
 * large up front ("Streaming is required for operations that may take longer
 * than 10 minutes"). These tests stand in a fake Messages endpoint and pin
 * both halves: the request goes out as a stream, and the collected message
 * comes back in the shape the agent loop expects.
 */

type Event = { type: string; [key: string]: unknown }

const sse = (event: Event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

const CONTENT = [
  { type: 'text', text: 'Pulling the theme first.' },
  { type: 'tool_use', id: 'toolu_1', name: 'request_files', input: { paths: ['src/theme.ts'] } },
]

/** Streams CONTENT as a message that ends in a tool call. */
function serveStream(res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null }
  res.write(sse({ type: 'message_start', message: { ...message, usage: { input_tokens: 1, output_tokens: 0 } } }))
  res.write(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: CONTENT[0]!.text } }))
  res.write(sse({ type: 'content_block_stop', index: 0 }))
  res.write(
    sse({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'request_files', input: {} },
    }),
  )
  res.write(
    sse({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(CONTENT[1]!.input) },
    }),
  )
  res.write(sse({ type: 'content_block_stop', index: 1 }))
  res.write(
    sse({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
  )
  res.write(sse({ type: 'message_stop' }))
  res.end()
}

let server: http.Server
let client: Anthropic
const requests: { stream?: boolean; max_tokens?: number; system?: unknown }[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk))
    req.on('end', () => {
      const parsed = JSON.parse(body) as (typeof requests)[number]
      requests.push(parsed)
      if (!parsed.stream) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'expected a stream' } }),
        )
        return
      }
      serveStream(res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  client = new Anthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 })
})

afterAll(() => server.close())

describe('runAnthropicTurn', () => {
  it('streams a 32k-token turn (a non-streaming request that size is refused by the SDK)', async () => {
    const result = await runAnthropicTurn(client, 'fake', {
      system: [{ text: 'You are the recon model.', cache: true }],
      tools: [],
      messages: [{ role: 'user', content: 'Reconstruct the settings screen.' }],
      maxTokens: 32_000,
    })
    expect(requests.at(-1)).toMatchObject({ stream: true, max_tokens: 32_000 })
    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toEqual(CONTENT)
  })

  it('keeps the cache breakpoint on the system block', async () => {
    await runAnthropicTurn(client, 'fake', {
      system: [{ text: 'cached', cache: true }, { text: 'fresh' }],
      tools: [],
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
    })
    expect(requests.at(-1)?.system).toEqual([
      { type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'fresh' },
    ])
  })
})
