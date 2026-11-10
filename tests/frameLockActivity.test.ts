import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from '../shared/types'

/* persistence is not under test: the lock's own line in the activity feed is */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  insertCanvas: async () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

const user: Actor = { name: 'kevin', kind: 'user', color: '#000' }
const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
let canvasId: string

function messages(): string[] {
  return actions.getActivity(canvasId).map((item) => item.message)
}

beforeEach(async () => {
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  canvasId = (await store.createCanvas('locks', 'kevin')).id
})

describe('frame lock activity', () => {
  it('logs a lock and an unlock', () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, user)!
    actions.updateFrame(frame.id, { locked: true }, user)
    expect(messages()).toContain('locked “Hero”')
    actions.updateFrame(frame.id, { locked: false }, user)
    expect(messages()).toContain('unlocked “Hero”')
  })

  it('keeps the lock line when the same update also renames or redesigns the frame', () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, user)!
    /* an agent's update_frame may carry name and locked together */
    actions.updateFrame(frame.id, { name: 'Hero v2', locked: true }, agent)
    expect(messages()).toContain('renamed “Hero” to “Hero v2”')
    expect(messages()).toContain('locked “Hero v2”')

    actions.updateFrame(frame.id, { html: '<h1>Hi</h1>', locked: false }, user)
    expect(messages()).toContain('updated the design of “Hero v2”')
    expect(messages()).toContain('unlocked “Hero v2”')
  })

  it('stays quiet when the lock does not change', () => {
    const frame = actions.createFrame(canvasId, { name: 'Hero' }, user)!
    actions.updateFrame(frame.id, { locked: false }, user)
    actions.updateFrame(frame.id, { x: 10, locked: false }, user)
    expect(messages().filter((m) => m.includes('locked'))).toEqual([])
  })
})
