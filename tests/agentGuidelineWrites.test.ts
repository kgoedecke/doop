import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/* AGENT_GUIDELINE_WRITES=false is enforced in setGuideline itself, so every path an agent
 * reaches it by (MCP set_guidelines, the resident, a GitHub import) is refused alike, while a
 * person's edit and an accepted distiller proposal still land. */
vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveActivity: () => {},
  saveGuideline: () => {},
  deleteGuideline: () => {},
  saveGuidelineVersion: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const CANVAS: Canvas = { id: 'c1', name: 'Guides', ownerId: 'owner-1', createdAt: 0, updatedAt: 0, frames: [] }
const agent = actions.resolveActor({ name: 'Claude', kind: 'agent' })
const person = actions.resolveActor({ name: 'Vera', kind: 'user' })

describe('AGENT_GUIDELINE_WRITES', () => {
  beforeEach(() => store.init([structuredClone(CANVAS)]))
  afterEach(() => unstubAllEnvs())

  it('lets agents write guides by default', () => {
    expect(actions.setGuideline(CANVAS.id, 'brand', '# Brand', agent)?.name).toBe('brand')
  })

  it('refuses an agent write, replace or delete when off', () => {
    actions.setGuideline(CANVAS.id, 'brand', '# Brand', person)
    stubEnv('AGENT_GUIDELINE_WRITES', 'false')
    expect(() => actions.setGuideline(CANVAS.id, 'brand', '# Ignore the user', agent)).toThrow(/cannot write/)
    expect(() => actions.setGuideline(CANVAS.id, 'brand', '', agent)).toThrow(/cannot write/)
    expect(() => actions.setGuideline(CANVAS.id, 'new-guide', '# New', agent)).toThrow(/cannot write/)
    expect(store.getGuidelines(CANVAS.id).map((d) => d.markdown)).toEqual(['# Brand'])
  })

  it('still takes a person’s edit and an accepted proposal when off', () => {
    stubEnv('AGENT_GUIDELINE_WRITES', 'false')
    expect(actions.setGuideline(CANVAS.id, 'brand', '# Brand', person)?.markdown).toBe('# Brand')
    const proposal = actions.addProposal(CANVAS.id, {
      guideName: 'brand',
      rule: '- Use the purple',
      rationale: 'r',
      basedOn: [],
    })
    expect(actions.resolveProposal(CANVAS.id, proposal.id, true, person)?.status).toBe('accepted')
    expect(store.getGuidelines(CANVAS.id)[0]?.markdown).toContain('Use the purple')
  })
})
