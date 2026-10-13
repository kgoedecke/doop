export type { ClaudeSessionEvent as ClaudeEvent } from '@cantelop/sdk/harnesses/claude/protocol'

export interface RemoteClaudeStatus {
  authRequired?: boolean
  configured: boolean
  running: boolean
}
