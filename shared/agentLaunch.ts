/** How to hand a prompt to the agent a person connected to Doop, read from its
 *  MCP client's name (its OAuth application's name): a link that opens the
 *  agent with the prompt filled in (never sent), a command to run in a
 *  terminal, or neither, when copying the prompt is all there is. */

export type AgentLaunchKind = 'claude-code' | 'claude-desktop' | 'claude' | 'chatgpt' | 'cursor' | 'codex' | 'other'

export interface AgentLaunch {
  kind: AgentLaunchKind
  /** what the person calls it: "Claude Code", "Cursor"… */
  label: string
  /** opens the agent with the prompt prefilled; absent when none exists */
  url?: string
  /** a terminal command that starts the agent on the prompt */
  command?: string
}

/* First match wins: Claude Code's and the desktop extension's names contain
   "Claude" too. Names as they reach Doop: "Claude Code (doop)", "Doop for
   Claude Desktop", "Claude", "ChatGPT", "Cursor", "Codex". */
const KINDS: ReadonlyArray<readonly [RegExp, AgentLaunchKind]> = [
  [/claude code/, 'claude-code'],
  [/claude desktop/, 'claude-desktop'],
  [/claude/, 'claude'],
  [/chatgpt/, 'chatgpt'],
  [/cursor/, 'cursor'],
  [/codex/, 'codex'],
]

export function agentLaunchKind(clientName: string | undefined): AgentLaunchKind {
  const name = (clientName ?? '').toLowerCase()
  return KINDS.find(([pattern]) => pattern.test(name))?.[1] ?? 'other'
}

const LABELS: Record<AgentLaunchKind, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
  codex: 'Codex',
  other: 'your agent',
}

/** A prompt as one shell argument, single-quoted. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

export function agentLaunch(clientName: string | undefined, prompt: string): AgentLaunch {
  const kind = agentLaunchKind(clientName)
  const q = encodeURIComponent(prompt)
  const base = { kind, label: LABELS[kind] }
  switch (kind) {
    /* code.claude.com/docs/en/deep-links: filled in, sent on Enter */
    case 'claude-code':
      return { ...base, url: `claude-cli://open?q=${q}`, command: `claude ${shellQuote(prompt)}` }
    /* support.claude.com "Open Claude Desktop with a link" */
    case 'claude-desktop':
      return { ...base, url: `claude://claude.ai/new?q=${q}` }
    case 'claude':
      return { ...base, url: `https://claude.ai/new?q=${q}` }
    case 'chatgpt':
      return { ...base, url: `https://chatgpt.com/?q=${q}` }
    /* cursor.com/docs/reference/deeplinks: opens Cursor, the person confirms */
    case 'cursor':
      return { ...base, url: `https://cursor.com/link/prompt?text=${q}` }
    case 'codex':
      return { ...base, command: `codex ${shellQuote(prompt)}` }
    default:
      return base
  }
}
