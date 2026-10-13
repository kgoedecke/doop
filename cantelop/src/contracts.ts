// The SDK owns the Claude Session protocol; these aliases keep Doop's domain imports stable.
export type {
  McpServer,
  ClaudeSessionConfig as SessionConfig,
  ClaudeSessionCommand as Command,
  ClaudeSessionStatus as Status,
  ClaudeSessionMessage as Message,
  ClaudeSessionReply as Reply,
  ClaudeSessionEvent as Event,
} from '@cantelop/sdk/harnesses/claude/protocol'
