import { describe, expect, it } from 'vitest'
import { COMPONENTS, COMPOSE_CHECK, DESIGN_BRIEF, DOOP_GUIDE, FRAME_STYLES, SYSTEM_FIRST } from '../server/guide'
import { RESIDENT_TOOLS, systemFor } from '../server/resident'
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

  it('opens the guide with the system: tokens, then components, then screens composed from them', () => {
    expect(DOOP_GUIDE.indexOf(SYSTEM_FIRST)).toBeLessThan(DOOP_GUIDE.indexOf('## The room you'))
    expect(SYSTEM_FIRST).toContain('the way a designer sets up a Figma file')
    expect(SYSTEM_FIRST).toContain('create_components')
    expect(SYSTEM_FIRST).toContain('never a copied frame')
    expect(DESIGN_BRIEF).toContain('Then set up the component system on them')
  })

  it('asks for components by judgment, not after a third copy', () => {
    expect(COMPONENTS).toContain('Think in a component system')
    expect(COMPONENTS).toContain('Write a reusable piece as a component the first time')
    expect(COMPONENTS).not.toContain('Before you write the same block a third time')
  })

  it('reaches every resident role in the same words', () => {
    for (const role of AGENT_ROLES) {
      const prompt = systemFor(role)
      expect(prompt).toContain(DESIGN_BRIEF)
      expect(prompt).toContain(COMPONENTS)
      expect(prompt).toContain(SYSTEM_FIRST)
      expect(prompt).toContain('Check reuse too')
    }
  })

  it('asks for the check at the moment HTML is written, over MCP and in the resident', async () => {
    const { buildMcpServer } = await import('../server/mcp')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'guidance-test', version: '1.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    await client.connect(a)
    const { tools } = await client.listTools()
    await client.close()
    for (const name of ['create_frame', 'append_frame_html', 'set_frame_html'])
      expect(tools.find((tool) => tool.name === name)?.description).toContain(COMPOSE_CHECK)
    for (const name of ['create_frame', 'set_frame_html', 'begin_frame_rewrite'])
      expect(RESIDENT_TOOLS.find((tool) => tool.name === name)?.description).toContain(COMPOSE_CHECK)
  })
})
