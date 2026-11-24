import * as vscode from 'vscode'

/** The Doop server the extension talks to, as an origin with no trailing slash. */
export function serverUrl(): string {
  const raw = vscode.workspace.getConfiguration('doop').get<string>('serverUrl') || 'https://doop.design'
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http')
    return url.origin
  } catch {
    return 'https://doop.design'
  }
}

export function canvasUrl(canvasId: string): string {
  return `${serverUrl()}/c/${encodeURIComponent(canvasId)}`
}

/** A canvas id out of a pasted Doop link (or a bare id). */
export function canvasIdFrom(input: string): string | null {
  const text = input.trim()
  if (/^[\w-]{6,64}$/.test(text)) return text
  try {
    const match = new URL(text).pathname.match(/^\/c\/([\w-]{6,64})/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export class DoopError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** POST JSON to the server and read JSON back; a non-2xx answer throws its `error`. */
export async function postJson<T>(path: string, body: unknown, key?: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${serverUrl()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new DoopError(`Could not reach ${serverUrl()}.`)
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string | { message?: string } }
  if (!res.ok) {
    const error = typeof data.error === 'string' ? data.error : data.error?.message
    throw new DoopError(error || `${serverUrl()} answered ${res.status}.`, res.status)
  }
  return data
}

let nextId = 1

/** One call of a Doop MCP tool, signed in by the agent key. /mcp is stateless and
 *  answers JSON, so a tool call needs no session of its own. */
export async function callTool<T>(key: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const answer = await postJson<{
    result?: { content?: { type: string; text?: string }[]; isError?: boolean; structuredContent?: unknown }
    error?: { message?: string }
  }>('/mcp', { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, key)
  if (answer.error) throw new DoopError(answer.error.message ?? `${name} failed`)
  const text = answer.result?.content?.find((part) => part.type === 'text')?.text ?? ''
  if (answer.result?.isError) throw new DoopError(text || `${name} failed`)
  if (answer.result?.structuredContent !== undefined) return answer.result.structuredContent as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}
