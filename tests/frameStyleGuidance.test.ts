import { describe, expect, it } from 'vitest'
import { DOOP_GUIDE, FRAME_STYLES } from '../server/guide'
import { systemFor } from '../server/resident'
import { AGENT_ROLES } from '../shared/agents'

describe('where frame CSS goes', () => {
  it('reaches MCP agents and every resident role in the same words', () => {
    expect(DOOP_GUIDE).toContain(FRAME_STYLES)
    for (const role of AGENT_ROLES) expect(systemFor(role)).toContain(FRAME_STYLES)
  })

  it('names what still belongs in a <style> block, so states and motion are not dropped', () => {
    for (const kept of ['@keyframes', ':hover', '::before', '@media', ':root', 'reset']) {
      expect(FRAME_STYLES).toContain(kept)
    }
  })

  it('keeps a property that changes out of the style attribute, where it would outrank the rule', () => {
    expect(FRAME_STYLES).toContain('An inline value outranks every rule')
    expect(FRAME_STYLES).toContain('the resting value included')
  })
})
