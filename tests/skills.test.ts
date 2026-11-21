import { describe, expect, it } from 'vitest'
import {
  parseSkillInput,
  parseSkillPatch,
  partialHandleAt,
  skillHandlesIn,
  skillsBlock,
  type Skill,
} from '../shared/skills.ts'

const body = 'Check every heading against the brand voice guide.'

describe('parseSkillInput', () => {
  it('accepts a skill and tidies it', () => {
    expect(parseSkillInput({ handle: ' /Brand-Check ', description: '  Brand  voice ', body: `  ${body}\n` })).toEqual({
      ok: true,
      value: { handle: 'brand-check', description: 'Brand voice', body },
    })
  })

  it('refuses a handle, description or body out of bounds', () => {
    const ok = { handle: 'brand-check', description: 'Brand voice', body }
    for (const handle of ['b', '1brand', 'brand_check', 'a'.repeat(33), ''])
      expect(parseSkillInput({ ...ok, handle }).ok, handle).toBe(false)
    for (const description of ['', 'x'.repeat(121), 'a\u0007b'])
      expect(parseSkillInput({ ...ok, description }).ok, description).toBe(false)
    for (const text of ['too short', 'x'.repeat(8001)]) expect(parseSkillInput({ ...ok, body: text }).ok).toBe(false)
    expect(parseSkillInput({ ...ok, handle: 'a'.repeat(32) }).ok).toBe(true)
    expect(parseSkillInput({ ...ok, body: 'x'.repeat(8000) }).ok).toBe(true)
  })
})

describe('parseSkillPatch', () => {
  it('changes the description and body only, never the handle', () => {
    expect(parseSkillPatch({ handle: 'other', description: 'New line' })).toEqual({
      ok: true,
      value: { description: 'New line' },
    })
    expect(parseSkillPatch({ body: 'short' }).ok).toBe(false)
  })
})

describe('skillHandlesIn', () => {
  it('finds a /handle at the start, mid-sentence, before punctuation and in parentheses', () => {
    expect(skillHandlesIn('/brand-check tighten the hero')).toEqual(['brand-check'])
    expect(skillHandlesIn('please run /brand-check on this')).toEqual(['brand-check'])
    expect(skillHandlesIn('tighten the hero with /brand-check.')).toEqual(['brand-check'])
    expect(skillHandlesIn('tighten the hero (/brand-check)')).toEqual(['brand-check'])
    expect(skillHandlesIn('first\n/brand-check, then /release-notes!')).toEqual(['brand-check', 'release-notes'])
  })

  it('skips paths, URLs and slashes inside words', () => {
    expect(skillHandlesIn('open /c/abc and fix it')).toEqual([])
    expect(skillHandlesIn('match https://x.com/brand please')).toEqual([])
    expect(skillHandlesIn('either a/b works')).toEqual([])
    expect(skillHandlesIn('a comment //x here')).toEqual([])
    expect(skillHandlesIn('/A-caps and /x too short')).toEqual([])
    expect(skillHandlesIn('edit /brand-check.html and /tone.md')).toEqual([])
    expect(skillHandlesIn('end with /brand-check.) or /tone?!')).toEqual(['brand-check', 'tone'])
  })

  it('keeps a handle named twice once, in order of first appearance', () => {
    expect(skillHandlesIn('/tone then /brand-check then /tone again')).toEqual(['tone', 'brand-check'])
  })
})

describe('skillsBlock', () => {
  const skill = (handle: string, text = body): Skill => ({
    handle,
    description: `${handle} rules`,
    body: text,
    createdAt: 1,
    updatedAt: 1,
  })
  const team = [skill('brand-check', 'Use the brand voice: short and warm.'), skill('release-notes')]

  it('gives the bodies of the skills the requests name, in the order they name them', () => {
    const block = skillsBlock(team, 'write the card /release-notes\nand run /brand-check on the hero')
    expect(block).toContain('# Skills requested for this work')
    expect(block).toContain('## /brand-check: brand-check rules\n\nUse the brand voice: short and warm.')
    expect(block!.indexOf('/release-notes:')).toBeLessThan(block!.indexOf('/brand-check:'))
  })

  it('gives nothing for a handle the canvas has no skill for', () => {
    expect(skillsBlock(team, 'try /nope and /c/abc')).toBeUndefined()
    expect(skillsBlock([], '/brand-check')).toBeUndefined()
  })

  it('takes at most five skills a run', () => {
    const many = Array.from({ length: 7 }, (_, i) => skill(`s${i}`))
    const block = skillsBlock(many, many.map((s) => `/${s.handle}`).join(' '))
    expect(block!.match(/^## \//gm)).toHaveLength(5)
    expect(block).not.toContain('/s5:')
  })
})

describe('partialHandleAt', () => {
  const at = (text: string, caret = text.length) => partialHandleAt(text, caret)

  it('finds the handle being typed where a request may name one', () => {
    expect(at('/')).toEqual({ start: 0, query: '' })
    expect(at('/br')).toEqual({ start: 0, query: 'br' })
    expect(at('tighten it (/brand-c')).toEqual({ start: 12, query: 'brand-c' })
    expect(at('first line\n/br')).toEqual({ start: 11, query: 'br' })
  })

  it('reads only up to the caret', () => {
    expect(at('/br the hero', 3)).toEqual({ start: 0, query: 'br' })
    expect(at('/br the hero', 8)).toBeUndefined()
  })

  it('stays quiet inside paths, URLs and words', () => {
    expect(at('and/or')).toBeUndefined()
    expect(at('see https://a.com/b')).toBeUndefined()
    expect(at('open /c/abc')).toBeUndefined()
    expect(at('/Brand')).toBeUndefined()
  })
})
