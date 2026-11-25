import { CliError, EXIT } from './errors.ts'

/**
 * Doop's MCP endpoint as plain HTTP. `/mcp` is stateless (one JSON-RPC request per call, no
 * session, no `initialize` needed), so the CLI is a thin client of the same tools every MCP
 * client uses and needs no API of its own.
 */

export interface Connection {
  /** origin, no trailing slash */
  server: string
  /** an agent key (`dpk_…`) */
  key: string
  agentName: string
  /** something its holder should know about how it was resolved */
  notice?: string
}

export interface ToolFile {
  mime: string
  data: Buffer
}

export interface ToolResult {
  /** the tool's answer: its first text block */
  text: string
  /** what the server added to steer the next step (review nudges, reuse hints) */
  notes: string[]
  /** requests from people on the canvas, delivered with this result */
  feedback: string[]
  /** images and embedded files (a screenshot, a PDF) */
  files: ToolFile[]
}

export interface ToolInfo {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
}

interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: { blob?: string; mimeType?: string }
}

interface RpcAnswer {
  result?: { content?: ContentBlock[]; isError?: boolean; tools?: ToolInfo[] }
  error?: { message: string }
}

const FEEDBACK_PREFIX = 'HUMAN FEEDBACK'

async function rpc(connection: Connection, method: string, params: Record<string, unknown>): Promise<RpcAnswer> {
  let response: Response
  try {
    response = await fetch(`${connection.server}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${connection.key}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  } catch (error) {
    throw new CliError(
      `could not reach ${connection.server}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.error,
      'check the network, or point at another server with --server or DOOP_SERVER',
    )
  }
  if (response.status === 401)
    throw new CliError(
      `${connection.server} refused the agent key`,
      EXIT.auth,
      'run `doop login` again, or set DOOP_API_KEY to an agent key from Settings → Agent keys',
    )
  if (!response.ok)
    throw new CliError(`${connection.server} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const answer = (await response.json()) as RpcAnswer
  if (answer.error) throw new CliError(answer.error.message)
  return answer
}

function toolError(tool: string, message: string): CliError {
  const text = message.replace(/^Error:\s*/, '')
  if (/^no (canvas|frame|page|component) /i.test(text))
    return new CliError(text, EXIT.notFound, '`doop canvases` and `doop frames` list what this key can open')
  if (/Unknown tool|not found/i.test(text) && text.includes(tool))
    return new CliError(text, EXIT.notFound, '`doop tools` lists the tools this server has')
  return new CliError(text)
}

/** Calls one tool. `agent_name` rides along on every call; a tool that takes none ignores it. */
export async function callTool(
  connection: Connection,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const answer = await rpc(connection, 'tools/call', {
    name: tool,
    arguments: { agent_name: connection.agentName, ...args },
  })
  const blocks = answer.result?.content ?? []
  const texts = blocks.flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
  if (answer.result?.isError) throw toolError(tool, texts.join('\n') || `${tool} failed`)
  const [text = '', ...rest] = texts
  return {
    text,
    notes: rest.filter((note) => !note.startsWith(FEEDBACK_PREFIX)),
    feedback: rest.filter((note) => note.startsWith(FEEDBACK_PREFIX)),
    files: blocks.flatMap((block): ToolFile[] => {
      if (block.type === 'image' && block.data)
        return [{ mime: block.mimeType ?? 'image/png', data: Buffer.from(block.data, 'base64') }]
      if (block.type === 'resource' && block.resource?.blob)
        return [
          {
            mime: block.resource.mimeType ?? 'application/octet-stream',
            data: Buffer.from(block.resource.blob, 'base64'),
          },
        ]
      return []
    }),
  }
}

/** A tool whose answer is JSON. */
export async function callJson<T>(
  connection: Connection,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ value: T; result: ToolResult }> {
  const result = await callTool(connection, tool, args)
  try {
    return { value: JSON.parse(result.text) as T, result }
  } catch {
    throw new CliError(`${tool} answered something that is not JSON: ${result.text.slice(0, 200)}`)
  }
}

export async function listTools(connection: Connection): Promise<ToolInfo[]> {
  const answer = await rpc(connection, 'tools/list', {})
  return answer.result?.tools ?? []
}
