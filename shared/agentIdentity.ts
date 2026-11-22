/**
 * Who an agent is. A name is what people see and address (`@Claude`), but two
 * outside (MCP) agents may share one: two people's Claude Code on a shared
 * canvas. Such an agent carries an `agentKey` (minted by the server from its
 * account and name, `mcpAgentKey` in `server/mcp.ts`), and presence and its
 * tasks are told apart by it. Agents without one (the resident roles, whose
 * names are unique on a canvas) are their name.
 *
 * The key is an opaque hash, so it is safe to show in the room, store and use
 * as a presence id.
 */

/** The identity of an actor or presence. */
export function agentKeyOf(agent: { name: string; agentKey?: string }): string {
  return agent.agentKey ?? agent.name
}

/** The identity of the agent a task belongs to (empty for an unclaimed card). */
export function taskAgentKey(task: { agentName: string; agentKey?: string }): string {
  return task.agentKey ?? task.agentName
}

/** True when the task is the work of that agent. */
export function isAgentsTask(
  task: { agentName: string; agentKey?: string },
  agent: { name: string; agentKey?: string },
): boolean {
  return !!task.agentName && taskAgentKey(task) === agentKeyOf(agent)
}
