export const CLAUDE_MODEL_IDS = [
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const

export type ClaudePlanModel = (typeof CLAUDE_MODEL_IDS)[number]
// The server retains the subscription contract; custom IDs stay on the device.
export type ClaudeModel = ClaudePlanModel | 'default' | 'sonnet' | 'opus'

// Keep these constraints in sync with valid_model in desktop/src-tauri/src/claude.rs.
export function isClaudeModel(model: unknown): model is string {
  return typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,255}$/.test(model)
}
export const DEFAULT_CLAUDE_MODEL: ClaudePlanModel = 'claude-sonnet-5'

export const CLAUDE_MODELS: { id: ClaudePlanModel; name: string; blurb: string }[] = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1', blurb: 'For the hardest problems and longer, multi-step design tasks.' },
  { id: 'claude-opus-5', name: 'Opus 5', blurb: 'For complex layouts and demanding design or coding work.' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', blurb: 'A balanced default for everyday design work.' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', blurb: 'For quick edits and straightforward tasks.' },
]

/** Keep the subscription defaults used by existing desktop shells. */
export function normalizeClaudeModel(model: unknown): ClaudePlanModel {
  if (model === 'opus') return 'claude-opus-5'
  return CLAUDE_MODEL_IDS.find((id) => id === model) ?? DEFAULT_CLAUDE_MODEL
}

export interface LocalClaudeModel {
  id: string
  name: string
  blurb: string
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
