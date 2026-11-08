import { describe, expect, it } from 'vitest'
import { parseRunnerPick, resolveRunnerPick, runnerKey, type AgentRunners } from '../shared/agentRunner.ts'
import { readStoredPick, RUNNER_PICK_KEY } from '../src/lib/runnerPick.ts'

const runners: AgentRunners = {
  runners: [
    {
      provider: 'claude-local',
      name: 'Claude Plan',
      online: true,
      model: 'sonnet',
      models: [
        { id: 'opus', name: 'Opus', blurb: '' },
        { id: 'sonnet', name: 'Sonnet', blurb: '' },
      ],
      efforts: [
        { id: 'medium', name: 'Medium', blurb: '' },
        { id: 'max', name: 'Max', blurb: '' },
      ],
    },
    {
      provider: 'chatgpt',
      name: 'ChatGPT',
      email: 'alice@example.com',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      models: [{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', blurb: '' }],
      efforts: [{ id: 'medium', name: 'Medium', blurb: '' }],
    },
  ],
  default: 'claude-local',
}

describe('parseRunnerPick', () => {
  it('keeps a well-formed pick and trims its ids', () => {
    expect(parseRunnerPick({ provider: 'chatgpt', model: ' gpt-5.6-sol ', effort: 'high' })).toEqual({
      provider: 'chatgpt',
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
    expect(parseRunnerPick({ provider: 'claude-local' })).toEqual({ provider: 'claude-local' })
  })
  it('drops nonsense: an unknown connection, no object, oversized ids', () => {
    expect(parseRunnerPick({ provider: 'server' })).toBeUndefined()
    expect(parseRunnerPick('chatgpt')).toBeUndefined()
    expect(parseRunnerPick(null)).toBeUndefined()
    expect(parseRunnerPick({ provider: 'chatgpt', model: 'x'.repeat(121) })).toEqual({ provider: 'chatgpt' })
    expect(parseRunnerPick({ provider: 'chatgpt', model: 7 })).toEqual({ provider: 'chatgpt' })
  })
})

describe('runnerKey', () => {
  it('is empty for the Settings default and tells picks apart by every field', () => {
    expect(runnerKey(undefined)).toBe('')
    expect(runnerKey({ provider: 'chatgpt' })).not.toBe(runnerKey({ provider: 'chatgpt', model: 'a' }))
    expect(runnerKey({ provider: 'chatgpt', model: 'a' })).not.toBe(
      runnerKey({ provider: 'chatgpt', model: 'a', effort: 'low' }),
    )
    expect(runnerKey({ provider: 'chatgpt', model: 'a' })).toBe(runnerKey({ provider: 'chatgpt', model: 'a' }))
  })
})

describe('resolveRunnerPick', () => {
  it('is the Settings default with its own model when nothing was picked', () => {
    expect(resolveRunnerPick(runners, null)?.pick).toEqual({ provider: 'claude-local', model: 'sonnet' })
  })
  it('is the stored pick when its connection is still there', () => {
    const stored = { provider: 'chatgpt' as const, model: 'gpt-5.6-sol', effort: 'medium' }
    expect(resolveRunnerPick(runners, stored)?.pick).toEqual(stored)
  })
  it('drops an effort the connection does not offer and keeps the model it was given', () => {
    const resolved = resolveRunnerPick(runners, { provider: 'claude-local', model: 'opus', effort: 'bogus' })
    expect(resolved?.pick).toEqual({ provider: 'claude-local', model: 'opus' })
  })
  it('falls back to the default when the stored connection is gone', () => {
    const only: AgentRunners = { runners: [runners.runners[1]!], default: 'chatgpt' }
    expect(resolveRunnerPick(only, { provider: 'claude-local', model: 'opus' })?.pick).toEqual({
      provider: 'chatgpt',
      model: 'gpt-5.6-terra',
      effort: 'medium',
    })
  })
  it('takes the first connection when the default is the operator pilot', () => {
    expect(resolveRunnerPick({ ...runners, default: 'gemini-cloud' }, null)?.runner.provider).toBe('claude-local')
  })
  it('is nothing with no connection to pick from', () => {
    expect(resolveRunnerPick(null, null)).toBeUndefined()
    expect(resolveRunnerPick({ runners: [] }, { provider: 'chatgpt' })).toBeUndefined()
  })
})

describe('readStoredPick', () => {
  const storage = (value: string | null) => ({ getItem: (key: string) => (key === RUNNER_PICK_KEY ? value : null) })
  it('reads a saved pick and survives garbage', () => {
    expect(readStoredPick(storage(JSON.stringify({ provider: 'chatgpt', model: 'gpt-5.6-sol' })))).toEqual({
      provider: 'chatgpt',
      model: 'gpt-5.6-sol',
    })
    expect(readStoredPick(storage('{not json'))).toBeNull()
    expect(readStoredPick(storage(JSON.stringify({ provider: 'nope' })))).toBeNull()
    expect(readStoredPick(storage(null))).toBeNull()
    expect(readStoredPick(undefined)).toBeNull()
  })
})
