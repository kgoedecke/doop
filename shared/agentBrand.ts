/** Which product an agent is, as far as Doop can tell: read from the MCP
 *  client's name (what it sent in `initialize`, else its OAuth application's
 *  name), and failing that from the name the agent gave itself. The client
 *  says which tool connected, never which model runs inside it: Grok in
 *  Cursor is Cursor. Self-reported, so a label, not an identity. */

export const AGENT_BRANDS = [
  'claude',
  'openai',
  'cursor',
  'gemini',
  'github',
  'microsoft',
  'kimi',
  'grok',
  'opencode',
  'pi',
] as const
export type AgentBrand = (typeof AGENT_BRANDS)[number]

/* Order matters: the first rule whose pattern matches wins. Patterns come from
   the client names agents actually connect with (agent_connected in PostHog);
   an mcp-remote bridge keeps the real client's name in front of its suffix. */
const RULES: ReadonlyArray<readonly [RegExp, AgentBrand]> = [
  [/cursor/, 'cursor'],
  [/copilot/, 'github'],
  [/claude|anthropic/, 'claude'],
  [/codex|openai|chatgpt|\bgpt/, 'openai'],
  [/gemini|antigravity/, 'gemini'],
  [/kimi/, 'kimi'],
  [/visual studio code|vscode/, 'microsoft'],
  [/\bgrok|\bxai\b/, 'grok'],
  [/opencode/, 'opencode'],
  /* Pi's clients are `pi`, `pi-doop`, `pi-mcp-doop`: the word, never a part of one */
  [/(^|[^a-z])pi([^a-z]|$)/, 'pi'],
]

/** the brand a client or agent name reads as, or none (a Doop agent, or a client we cannot place) */
export function agentBrandOf(name: string | undefined): AgentBrand | undefined {
  if (!name) return undefined
  const n = name.toLowerCase()
  return RULES.find(([pattern]) => pattern.test(n))?.[1]
}

/** The client's brand wins over the name's: a Claude Code session calling
 *  itself "Codex reviewer" is still Claude Code. */
export function resolveAgentBrand(clientName: string | undefined, agentName: string | undefined) {
  return agentBrandOf(clientName) ?? agentBrandOf(agentName)
}

export function isAgentBrand(value: unknown): value is AgentBrand {
  return typeof value === 'string' && (AGENT_BRANDS as readonly string[]).includes(value)
}
