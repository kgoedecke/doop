/** Where an agent struggled with Doop itself (report_issue). */
export const AGENT_ISSUE_CATEGORIES = ['bug', 'tool_error', 'confusing', 'missing_capability', 'other'] as const
/** What an agent would change or keep about Doop (share_feedback). */
export const AGENT_IDEA_CATEGORIES = ['idea', 'improvement', 'praise', 'other'] as const

export type AgentFeedbackKind = 'issue' | 'feedback'
export type AgentIssueCategory = (typeof AGENT_ISSUE_CATEGORIES)[number]
export type AgentIdeaCategory = (typeof AGENT_IDEA_CATEGORIES)[number]
export type AgentFeedbackCategory = AgentIssueCategory | AgentIdeaCategory

export const MAX_AGENT_FEEDBACK_CHARS = 4000

/** Which kind of agent sent it: one connected over MCP, or a resident Doop Agent run. */
export type AgentFeedbackSource = 'mcp' | 'resident'

export interface AgentFeedbackReport {
  id: string
  at: number
  kind: AgentFeedbackKind
  source: AgentFeedbackSource
  category: AgentFeedbackCategory
  message: string
  tool: string | null
  agentName: string | null
  client: string | null
  canvasId: string | null
  userId: string | null
}
