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
  saveCanvas: () => {},
  loadLegacyFrameIds: async () => [],
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')

const user: Actor = { name: 'kevin', kind: 'user', color: '#000' }
const agent: Actor = { name: 'Claude', kind: 'agent', color: '#e5533c' }
let canvasId: string

async function messages(): Promise<string[]> {
  return (await actions.getActivity(canvasId)).map((item) => item.message)
}

beforeEach(() => {
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
  canvasId = store.createCanvas('locks', 'kevin').id
})

describe('frame lock activity', () => {
  it('logs a lock and an unlock', async () => {
    const frame = (await actions.createFrame(canvasId, { name: 'Hero' }, user))!
    await actions.updateFrame(frame.id, { locked: true }, user)
    expect(await messages()).toContain('locked “Hero”')
    await actions.updateFrame(frame.id, { locked: false }, user)
    expect(await messages()).toContain('unlocked “Hero”')
  })

  it('keeps the lock line when the same update also renames or redesigns the frame', async () => {
    const frame = (await actions.createFrame(canvasId, { name: 'Hero' }, user))!
    /* an agent's update_frame may carry name and locked together */
    await actions.updateFrame(frame.id, { name: 'Hero v2', locked: true }, agent)
    expect(await messages()).toContain('renamed “Hero” to “Hero v2”')
    expect(await messages()).toContain('locked “Hero v2”')

    await actions.updateFrame(frame.id, { html: '<h1>Hi</h1>', locked: false }, user)
    expect(await messages()).toContain('updated the design of “Hero v2”')
    expect(await messages()).toContain('unlocked “Hero v2”')
  })

  it('stays quiet when the lock does not change', async () => {
    const frame = (await actions.createFrame(canvasId, { name: 'Hero' }, user))!
    await actions.updateFrame(frame.id, { locked: false }, user)
    await actions.updateFrame(frame.id, { x: 10, locked: false }, user)
    expect((await messages()).filter((m) => m.includes('locked'))).toEqual([])
  })
})
