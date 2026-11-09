import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { store } from './store.ts'

/** Load the canvases a tool call names (`canvas_id`, `frame_id`,
 *  `frame_ids`) before it runs, so tools keep reading the store
 *  synchronously (store.load). */
export async function loadArgsCanvases(args: unknown): Promise<void> {
  if (!args || typeof args !== 'object') return
  const { canvas_id, frame_id, frame_ids } = args as Record<string, unknown>
  const loads: Promise<unknown>[] = []
  if (typeof canvas_id === 'string') loads.push(store.load(canvas_id))
  for (const id of [frame_id, ...(Array.isArray(frame_ids) ? frame_ids : [])]) {
    if (typeof id === 'string') loads.push(store.loadFrame(id))
  }
  await Promise.all(loads)
}

/** Every tool registered on `server` from here on loads its canvases first.
 *  A tool with an input schema is called with (args, extra), one without
 *  with (extra) alone. */
export function loadToolTargets(server: McpServer): void {
  type Register = typeof server.registerTool
  type Callback = Parameters<Register>[2]
  const register: Register = server.registerTool.bind(server)
  server.registerTool = ((name: string, config: Parameters<Register>[1], callback: Callback) =>
    register(name, config, (async (...params: unknown[]) => {
      if (params.length > 1) await loadArgsCanvases(params[0])
      return (callback as (...forwarded: unknown[]) => unknown)(...params)
    }) as unknown as Callback)) as Register
}
