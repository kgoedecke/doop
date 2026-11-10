import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { store } from './store.ts'

/** The tool owner supplies its existing denial result without loading the target. */
export class ToolTargetRefusal extends Error {
  constructor(readonly result: CallToolResult) {
    super('tool target is unavailable')
  }
}

/** The canvases a tool call names: `canvas_id`, and the canvases of
 *  `frame_id` / `frame_ids`. */
function argsCanvases(args: unknown): string[] {
  if (!args || typeof args !== 'object') return []
  const { canvas_id, frame_id, frame_ids } = args as Record<string, unknown>
  const ids = new Set<string>()
  if (typeof canvas_id === 'string') ids.add(canvas_id)
  for (const id of [frame_id, ...(Array.isArray(frame_ids) ? frame_ids : [])]) {
    const canvasId = typeof id === 'string' ? store.getFrame(id)?.canvasId : undefined
    if (canvasId) ids.add(canvasId)
  }
  return [...ids]
}

/** Load the canvases a tool call names and hold them while `run` works, so
 *  tools keep reading the store synchronously and a slow one (an import
 *  waiting on another service) keeps its canvas (store.load, store.hold). */
export async function withArgsCanvases<T>(
  args: unknown,
  run: () => T | Promise<T>,
  authorize?: (canvasId: string) => void | Promise<void>,
): Promise<T> {
  const canvasIds = argsCanvases(args)
  for (const id of canvasIds) await authorize?.(id)
  const releases = canvasIds.map((id) => store.hold(id))
  try {
    await Promise.all(canvasIds.map((id) => store.load(id)))
    for (const id of canvasIds) await authorize?.(id)
    return await run()
  } finally {
    for (const release of releases) release()
  }
}

/** Every tool registered on `server` from here on loads and holds its
 *  canvases. A tool with an input schema is called with (args, extra), one
 *  without with (extra) alone. */
export function loadToolTargets(
  server: McpServer,
  authorize: (canvasId: string, args: unknown) => void | Promise<void>,
): void {
  type Register = typeof server.registerTool
  type Callback = Parameters<Register>[2]
  const register: Register = server.registerTool.bind(server)
  server.registerTool = ((name: string, config: Parameters<Register>[1], callback: Callback) =>
    register(name, config, (async (...params: unknown[]) => {
      const forward = () => (callback as (...forwarded: unknown[]) => unknown)(...params)
      try {
        return params.length > 1
          ? await withArgsCanvases(params[0], forward, (id) => authorize(id, params[0]))
          : await forward()
      } catch (error) {
        if (error instanceof ToolTargetRefusal) return error.result
        throw error
      }
    }) as unknown as Callback)) as Register
}
