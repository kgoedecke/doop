import { describe, expect, it } from 'vitest'
import { COMPONENTS, DESIGN_BRIEF, DOOP_GUIDE, FRAME_STYLES } from '../server/guide'
import { systemFor } from '../server/resident'
import { AGENT_ROLES } from '../shared/agents'

/**
 * An agent that designed a canvas without tokens or nested components told us why: the
 * brief sent its palette to save_decision, create_tokens was never mentioned, and the
 * component rules read as if they were about frames only. These hold the fixes in place.
 */
describe('tokens and components in the agent guidance', () => {
  it('has the brief create tokens before the first frame, and keep decisions for the reasons', () => {
    expect(DESIGN_BRIEF).toContain('Before your first frame, create the brief')
    expect(DESIGN_BRIEF).toContain('create_tokens')
    expect(DESIGN_BRIEF).toContain('A decision is\n   the why, not a copy of the values')
    /* a canvas that already has tokens is an established style */
    expect(DESIGN_BRIEF).toContain('get_tokens')
  })

  it('tells frame authors to use the canvas tokens, not a palette of their own', () => {
    expect(FRAME_STYLES).toContain('Never declare your own palette on :root')
    expect(FRAME_STYLES).toContain('add it with create_tokens instead of')
  })

  it('says components nest and that the repetition rule holds inside a main', () => {
    expect(COMPONENTS).toContain('Components nest, and every rule here applies inside a main too')
    expect(COMPONENTS).toContain('<doop-use component="NavItem"')
    expect(COMPONENTS).toContain('auto_props=false skips the automatic text, image and link props')
  })

  it('adds reuse to the mandatory review', () => {
    expect(DOOP_GUIDE).toContain('- **Reuse**:')
  })

  it('reaches every resident role in the same words', () => {
    for (const role of AGENT_ROLES) {
      const prompt = systemFor(role)
      expect(prompt).toContain(DESIGN_BRIEF)
      expect(prompt).toContain(COMPONENTS)
      expect(prompt).toContain('Check reuse too')
    }
  })
})
