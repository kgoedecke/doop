// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { STAR_SNOOZE_MS, finishStarPrompt, noteActiveDay, snoozeStarPrompt, starPromptDue } from '../src/lib/githubStar'

const DAY = 24 * 60 * 60 * 1000
const start = new Date(2026, 10, 1, 12).getTime()

function useOnDays(count: number) {
  for (let i = 0; i < count; i++) noteActiveDay(start + i * DAY)
}

describe('GitHub star ask', () => {
  beforeEach(() => localStorage.clear())

  it('waits for three distinct days of use', () => {
    noteActiveDay(start)
    noteActiveDay(start + 1000)
    useOnDays(2)
    expect(starPromptDue(start + DAY)).toBe(false)
    useOnDays(3)
    expect(starPromptDue(start + 2 * DAY)).toBe(true)
  })

  it('"Later" keeps it away for the snooze, then asks again', () => {
    useOnDays(3)
    snoozeStarPrompt(start + 2 * DAY)
    expect(starPromptDue(start + 3 * DAY)).toBe(false)
    expect(starPromptDue(start + 2 * DAY + STAR_SNOOZE_MS)).toBe(true)
  })

  it('never asks again once starred or dismissed', () => {
    for (const how of ['starred', 'dismissed'] as const) {
      localStorage.clear()
      useOnDays(3)
      finishStarPrompt(how)
      noteActiveDay(start + 10 * DAY)
      expect(starPromptDue(start + 400 * DAY)).toBe(false)
    }
  })
})
