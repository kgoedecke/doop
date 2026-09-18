export type ClaudeModel = 'default' | 'sonnet' | 'opus'

export interface LocalAgentPreference {
  enabled: boolean
  model: ClaudeModel
}

export interface LocalAgentJob {
  id: string
  token: string
  prompt: string
  system: string
  model: ClaudeModel
  maxTurns: number
}

export interface LocalAgentResult {
  success: boolean
  text: string
}
