import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Approval writes persist and broadcast like any frame change; these tests only care
   about the approval the tool leaves behind, so both are stubbed, and so is the name lookup. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/auth.ts')>()),
  getUserName: async (id: string) => (id === 'kevin' ? 'Kevin' : undefined),
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { deliveredWork, execTool, newRunState } = await import('../server/resident.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const actor = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
const run = (extra: { requesterId?: string; automated?: boolean } = {}) => newRunState(extra)
const call = (input: unknown) => ({ type: 'tool_use' as const, id: 't1', name: 'set_frame_approval', input })
const html = '<!doctype html><html><body>hi</body></html>'

let canvasId: string
let frameId: string

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('approval', 'kevin').id
  /* made by a person: an agent's new frame plays back first, and approval waits for that */
  const person = actions.resolveActor({ name: 'Kevin', kind: 'user' })
  frameId = actions.createFrame(canvasId, { name: 'Home', width: 390, height: 844, html, x: 0, y: 0 }, person)!.id
})

describe('the resident agent sets approval', () => {
  it('marks a frame ready for dev in the name of the person who asked, and back to draft', async () => {
    const ready = await execTool(
      call({ frame_id: frameId, status: 'ready_for_dev' }),
      canvasId,
      actor(),
      run({ requesterId: 'kevin' }),
    )
    expect(ready.is_error).toBeUndefined()
    expect(store.getFrame(frameId)!.approval).toMatchObject({
      status: 'ready_for_dev',
      approvedBy: 'Kevin',
      approvedByUserId: 'kevin',
      approvedVia: actor().name,
    })
    const draft = await execTool(
      call({ frame_id: frameId, status: 'draft' }),
      canvasId,
      actor(),
      run({ requesterId: 'kevin' }),
    )
    expect(draft.is_error).toBeUndefined()
    expect(store.getFrame(frameId)!.approval).toBeNull()
  })

  it('counts an approval as the delivered work of a card that asked only for it', async () => {
    const state = run({ requesterId: 'kevin' })
    expect(deliveredWork(state)).toBe(false)
    await execTool(call({ frame_id: frameId, status: 'ready_for_dev' }), canvasId, actor(), state)
    expect(deliveredWork(state)).toBe(true)
  })

  it('refuses without a person who can edit the canvas, and inside automation runs', async () => {
    for (const state of [run(), run({ requesterId: 'stranger' }), run({ requesterId: 'kevin', automated: true })]) {
      const result = await execTool(call({ frame_id: frameId, status: 'ready_for_dev' }), canvasId, actor(), state)
      expect(result.is_error).toBe(true)
    }
    expect(store.getFrame(frameId)!.approval).toBeFalsy()
  })
})
