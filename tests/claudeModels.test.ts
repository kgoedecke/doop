import { describe, expect, it } from 'vitest'
import { CLAUDE_MODEL_IDS, isClaudeModel, normalizeClaudeModel } from '../shared/localAgent'

describe('Claude model preferences', () => {
  it.each(CLAUDE_MODEL_IDS)('preserves the selected CLI model %s', (model) => {
    expect(normalizeClaudeModel(model)).toBe(model)
  })

  it.each([
    ['opus', 'claude-opus-5'],
    ['sonnet', 'claude-sonnet-5'],
    ['default', 'claude-sonnet-5'],
    [undefined, 'claude-sonnet-5'],
    ['gateway/custom-deployment', 'claude-sonnet-5'],
    ['--bad-flag', 'claude-sonnet-5'],
  ])('retains server subscription defaults for %s', (saved, expected) => {
    expect(normalizeClaudeModel(saved)).toBe(expected)
  })
})

it('matches native model validation boundaries', () => {
  for (const valid of [
    'default',
    'team/deployment-v2',
    'claude-opus-5-5[1m]',
    'arn:aws:bedrock:region:account:inference-profile/model',
    'a'.repeat(256),
  ])
    expect(isClaudeModel(valid)).toBe(true)
  for (const invalid of [
    '',
    '--settings',
    'bad\nmodel',
    'two words',
    'model;command',
    'é-model',
    'model\\path',
    'a'.repeat(257),
  ])
    expect(isClaudeModel(invalid)).toBe(false)
})
