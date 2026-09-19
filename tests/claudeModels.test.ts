import { describe, expect, it } from 'vitest'
import { CLAUDE_MODEL_IDS, normalizeClaudeModel } from '../shared/localAgent'

describe('Claude model preferences', () => {
  it.each(CLAUDE_MODEL_IDS)('preserves the selected CLI model %s', (model) => {
    expect(normalizeClaudeModel(model)).toBe(model)
  })

  it.each([
    ['opus', 'claude-opus-5'],
    ['sonnet', 'claude-sonnet-5'],
    ['default', 'claude-sonnet-5'],
    [undefined, 'claude-sonnet-5'],
    ['unknown-model', 'claude-sonnet-5'],
  ])('migrates a legacy or missing preference %s', (saved, expected) => {
    expect(normalizeClaudeModel(saved)).toBe(expected)
  })
})
