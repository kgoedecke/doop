import type { SessionConfig } from './contracts.js'
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
export function fail(message: string): never {
  throw new ApiError(400, message)
}
export function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k)))
    fail('Invalid object fields')
}
const record = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= 100 &&
  v.every(
    (x) =>
      typeof x === 'string' &&
      x.length > 0 &&
      x.length <= 200 &&
      !x.includes(',') &&
      !x.startsWith('-') &&
      // eslint-disable-next-line no-control-regex -- Strip or reject terminal control characters intentionally.
      !/[\x00-\x1f]/.test(x),
  )
export function config(value: unknown): SessionConfig {
  fields(value, ['tools', 'allowedTools', 'mcps', 'model', 'systemPrompt', 'maxTurns'])
  const { model, systemPrompt, maxTurns } = value
  if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)))
    fail('Invalid model')
  if (
    systemPrompt !== undefined &&
    (typeof systemPrompt !== 'string' ||
      !systemPrompt.trim() ||
      new TextEncoder().encode(systemPrompt).length > 32 * 1024)
  )
    fail('systemPrompt must contain 1–32768 UTF-8 bytes')
  if (
    maxTurns !== undefined &&
    (typeof maxTurns !== 'number' || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)
  )
    fail('maxTurns must be an integer from 1 to 100')
  const tools = value.tools ?? [],
    allowedTools = value.allowedTools ?? [],
    mcps = value.mcps ?? {}
  if (!strings(tools) || !strings(allowedTools)) fail('Invalid tool arrays')
  if (!mcps || typeof mcps !== 'object' || Array.isArray(mcps) || Object.keys(mcps).length > 20)
    fail('Invalid MCP configuration')
  for (const [name, m] of Object.entries(mcps)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) fail('Invalid MCP name')
    if (m?.type === 'stdio') {
      fields(m, ['type', 'command', 'args', 'env'])
      if (typeof m.command !== 'string' || !m.command || m.command.length > 500) fail('Invalid MCP command')
      if (
        m.args !== undefined &&
        (!Array.isArray(m.args) || m.args.length > 100 || m.args.some((a) => typeof a !== 'string'))
      )
        fail('Invalid MCP args')
      if (
        m.env !== undefined &&
        (!record(m.env) || Object.keys(m.env).some((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)))
      )
        fail('Invalid MCP env')
    } else {
      fields(m, ['type', 'url', 'headers'])
      if (!['http', 'sse'].includes(String(m.type)) || typeof m.url !== 'string') fail('Invalid MCP transport')
      let url: URL
      try {
        url = new URL(m.url)
      } catch {
        fail('Invalid MCP URL')
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Invalid MCP URL')
      if (m.headers !== undefined && !record(m.headers)) fail('Invalid MCP headers')
    }
  }
  return {
    tools,
    allowedTools,
    mcps: mcps as SessionConfig['mcps'],
    ...(model !== undefined ? { model: model as string } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt: systemPrompt as string } : {}),
    ...(maxTurns !== undefined ? { maxTurns: maxTurns as number } : {}),
  }
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    fail('Invalid UUID')
  return value
}
export async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) return {}
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 48 * 1024) {
        await reader.cancel()
        throw new ApiError(413, 'Request too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes) || '{}')
  } catch {
    fail('Invalid JSON')
  }
}
