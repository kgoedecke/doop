import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DRAFTS,
  DRAFTS_STORAGE_KEY,
  canvasNameFromPrompt,
  draftsCardTitle,
  readStoredDrafts,
} from '../src/lib/homePrompt.ts'

describe('home composer', () => {
  it('names the canvas after the prompt, cut at a word', () => {
    expect(canvasNameFromPrompt('  Landing page for a bakery  ')).toBe('Landing page for a bakery')
    expect(canvasNameFromPrompt('first line\nsecond line')).toBe('first line')
    expect(canvasNameFromPrompt('')).toBe('Untitled canvas')
    const long = 'Design a pricing page with three tiers, annual toggle, FAQ and a comparison table'
    const name = canvasNameFromPrompt(long)
    expect(name.endsWith('…')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(49)
    expect(name).toBe('Design a pricing page with three tiers, annual…')
  })

  it('passes one draft through and asks for several otherwise', () => {
    expect(draftsCardTitle(' a hero ', 1)).toBe('a hero')
    expect(draftsCardTitle('a hero', 3)).toMatch(/^Make 3 distinct drafts .*\n\na hero$/s)
  })

  it('reads the stored draft count and falls back to the default', () => {
    const store = (value: string | null) => ({ getItem: () => value })
    expect(readStoredDrafts(store('2'))).toBe(2)
    expect(readStoredDrafts(store('9'))).toBe(DEFAULT_DRAFTS)
    expect(readStoredDrafts(store(null))).toBe(DEFAULT_DRAFTS)
    expect(readStoredDrafts(undefined)).toBe(DEFAULT_DRAFTS)
    expect(DRAFTS_STORAGE_KEY).toBe('doop-home-drafts')
  })
})
