import { describe, expect, it } from 'vitest'
import { DEFAULT_ANTHROPIC_TIMEOUT_MS, resolveAnthropicTimeoutMs } from '../server/anthropicTimeout.ts'

describe('resolveAnthropicTimeoutMs', () => {
  it('defaults to 15 minutes when unset', () => {
    expect(resolveAnthropicTimeoutMs({})).toBe(DEFAULT_ANTHROPIC_TIMEOUT_MS)
    expect(DEFAULT_ANTHROPIC_TIMEOUT_MS).toBe(15 * 60 * 1000)
  })

  it('uses ANTHROPIC_TIMEOUT_MS when it is a positive number', () => {
    expect(resolveAnthropicTimeoutMs({ ANTHROPIC_TIMEOUT_MS: '600000' })).toBe(600_000)
  })

  it('falls back to the default for empty, non-numeric, zero, or negative values', () => {
    expect(resolveAnthropicTimeoutMs({ ANTHROPIC_TIMEOUT_MS: '' })).toBe(DEFAULT_ANTHROPIC_TIMEOUT_MS)
    expect(resolveAnthropicTimeoutMs({ ANTHROPIC_TIMEOUT_MS: 'not-a-number' })).toBe(DEFAULT_ANTHROPIC_TIMEOUT_MS)
    expect(resolveAnthropicTimeoutMs({ ANTHROPIC_TIMEOUT_MS: '0' })).toBe(DEFAULT_ANTHROPIC_TIMEOUT_MS)
    expect(resolveAnthropicTimeoutMs({ ANTHROPIC_TIMEOUT_MS: '-5' })).toBe(DEFAULT_ANTHROPIC_TIMEOUT_MS)
  })
})
