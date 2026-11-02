import { describe, expect, it } from 'vitest'
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_ALIASES,
  isClaudeEffort,
  isClaudeModel,
  normalizeClaudeModel,
} from '../shared/localAgent'

/**
 * Claude Code on the desktop runs whatever `--model` names. The menu is the
 * CLI's aliases, which follow new releases on their own, and a pinned id is
 * accepted by shape; the shell checks the same rule again (claude.rs
 * valid_model) before the value becomes an argument.
 */
describe('Claude model preferences', () => {
  it('offers every alias, and nothing else, on the menu', () => {
    expect(CLAUDE_MODELS.map((model) => model.id).sort()).toEqual([...CLAUDE_MODEL_ALIASES].sort())
  })

  it.each([...CLAUDE_MODEL_ALIASES])('runs the alias %s as itself', (alias) => {
    expect(normalizeClaudeModel(alias)).toBe(alias)
  })

  it.each([
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-5-20260901',
  ])('keeps a pinned id %s, including ones saved before the aliases', (id) => {
    expect(isClaudeModel(id)).toBe(true)
    expect(normalizeClaudeModel(id)).toBe(id)
  })

  it.each([
    undefined,
    null,
    '',
    'unknown-model',
    'gpt-6',
    'claude-',
    'claude-Opus',
    'claude-opus 5',
    '--model',
    'claude-x'.padEnd(120, 'x'),
  ])('falls back to the default for %s', (saved) => {
    expect(isClaudeModel(saved)).toBe(false)
    expect(normalizeClaudeModel(saved)).toBe('sonnet')
  })

  it('knows the CLI effort levels and nothing else', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(isClaudeEffort(level)).toBe(true)
    for (const level of ['default', '', 'HIGH', 'none', 3, undefined]) expect(isClaudeEffort(level)).toBe(false)
  })
})
