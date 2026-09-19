export const CLAUDE_MODEL_IDS = [
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const

export type ClaudePlanModel = (typeof CLAUDE_MODEL_IDS)[number]
// Keep accepting preferences from desktop shells shipped before the named picker.
export type ClaudeModel = ClaudePlanModel | 'default' | 'sonnet' | 'opus'
export const DEFAULT_CLAUDE_MODEL: ClaudePlanModel = 'claude-sonnet-5'

export const CLAUDE_MODELS: { id: ClaudePlanModel; name: string }[] = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1' },
  { id: 'claude-opus-5', name: 'Opus 5' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
]

export function normalizeClaudeModel(model: unknown): ClaudePlanModel {
  if (model === 'opus') return 'claude-opus-5'
  return CLAUDE_MODEL_IDS.find((id) => id === model) ?? DEFAULT_CLAUDE_MODEL
}

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
