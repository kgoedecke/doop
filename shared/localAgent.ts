/**
 * The Claude Code run on the user's own desktop. Claude Code has no model
 * list to ask for, but `--model` takes an alias that always resolves to the
 * newest model the installed CLI knows, so the menu is the aliases: it stays
 * current with no network call and no desktop release. A full id can still be
 * typed to pin one. Keep the shape rule in sync with `valid_model` in
 * desktop/src-tauri/src/claude.rs, which checks it again before the id
 * becomes a CLI argument.
 */
export const CLAUDE_MODEL_ALIASES = ['default', 'fable', 'opus', 'sonnet', 'haiku'] as const
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number]

/** A pinned model: shaped like an Anthropic model id. */
export const CLAUDE_MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{0,98}$/

/** An alias, or a pinned `claude-*` id. */
export type ClaudeModel = string

export const DEFAULT_CLAUDE_MODEL: ClaudeModelAlias = 'sonnet'

export function isClaudeModel(value: unknown): value is ClaudeModel {
  return (
    typeof value === 'string' && (CLAUDE_MODEL_ALIASES.some((alias) => alias === value) || CLAUDE_MODEL_ID.test(value))
  )
}

export const CLAUDE_MODELS: { id: ClaudeModelAlias; name: string; blurb: string }[] = [
  { id: 'fable', name: 'Fable', blurb: 'The newest Fable your Claude Code knows — for the hardest, longest tasks.' },
  { id: 'opus', name: 'Opus', blurb: 'The newest Opus — for complex layouts and demanding design or coding work.' },
  { id: 'sonnet', name: 'Sonnet', blurb: 'The newest Sonnet — a balanced default for everyday design work.' },
  { id: 'haiku', name: 'Haiku', blurb: 'The newest Haiku — for quick edits and straightforward tasks.' },
  { id: 'default', name: 'Claude Code default', blurb: 'Whatever model your Claude Code is set to.' },
]

/** A stored preference as it will run: an alias or pinned id as is, anything
 *  older or unknown on the default. Ids saved before the aliases keep working. */
export function normalizeClaudeModel(model: unknown): ClaudeModel {
  return isClaudeModel(model) ? model : DEFAULT_CLAUDE_MODEL
}

/** `claude --effort`: how hard it thinks per turn; unset leaves the CLI's own
 *  setting. Mirrored by `valid_effort` in claude.rs. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

export const CLAUDE_EFFORT_OPTIONS: { id: ClaudeEffort; name: string; blurb: string }[] = [
  { id: 'low', name: 'Low', blurb: 'Fastest — fine for small, mechanical edits' },
  { id: 'medium', name: 'Medium', blurb: 'A good everyday setting for design work' },
  { id: 'high', name: 'High', blurb: 'More thinking per turn — for layouts that have to be right' },
  { id: 'xhigh', name: 'Extra high', blurb: 'Deeper still; slower turns' },
  { id: 'max', name: 'Max', blurb: 'All the thinking it can do, and the slowest turns' },
]

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return CLAUDE_EFFORTS.some((effort) => effort === value)
}

export interface LocalAgentPreference {
  enabled: boolean
  model: ClaudeModel
  /** unset = the CLI's own effort setting */
  effort?: ClaudeEffort
}

export interface LocalAgentJob {
  id: string
  token: string
  prompt: string
  system: string
  model: ClaudeModel
  effort?: ClaudeEffort
  maxTurns: number
}

export interface LocalAgentResult {
  success: boolean
  text: string
}
