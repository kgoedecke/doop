import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentModel } from '../server/agentModel.ts'
import type { LocalHarnessRequest } from '../server/localAgentRuns.ts'

const mocks = vi.hoisted(() => ({ pickModel: vi.fn<typeof import('../server/agentModel.ts').pickModel>() }))

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveActivity: () => {},
  saveMember: () => {},
}))
vi.mock('../server/agentModel.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/agentModel.ts')>()),
  pickModel: mocks.pickModel,
}))
vi.mock('../server/assets.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/assets.ts')>()),
  imagesForFrames: () => Promise.resolve(new Map()),
}))
vi.mock('../server/screenshot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/screenshot.ts')>()),
  renderFrame: () => Promise.resolve(Buffer.from('screenshot')),
}))

const actions = await import('../server/actions.ts')
const resident = await import('../server/resident.ts')
const { store } = await import('../server/store.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const OWNER = 'owner'
const HTML = '<!doctype html><html><head><title>Home</title></head><body><h1>Welcome home</h1></body></html>'
const DONE = { success: true, text: 'Done.' }
const broadcast = vi.fn<Parameters<typeof actions.wire>[0]>()
let canvasId: string

beforeEach(() => {
  broadcast.mockClear()
  mocks.pickModel.mockReset()
  actions.wire(broadcast, () => {})
  canvasId = store.createCanvas('Invitation test', OWNER).id
})

function invitations() {
  return broadcast.mock.calls.flatMap(([id, message]) =>
    id === canvasId && message.type === 'canvas:design-generated' ? [message] : [],
  )
}

type RunHarness = NonNullable<AgentModel['runHarness']>

function queueCard(runHarness: RunHarness, requesterId = OWNER, pipeline = [DEFAULT_ROLE_ID]) {
  mocks.pickModel.mockResolvedValue({
    provider: 'claude-local',
    label: 'Test model',
    userId: requesterId,
    run: vi.fn(),
    runHarness,
  })
  const card = actions.addQueuedCard(canvasId, 'Design the home screen', 'Alex', pipeline, undefined, requesterId)
  if (!card) throw new Error('Could not queue the invitation test card')
  resident.onFeedback(canvasId)
  return card
}

async function verifyFrame(execute: LocalHarnessRequest['execute'], frameId: string) {
  const result = await execute({
    type: 'tool_use',
    id: 'verify',
    name: 'screenshot_frame',
    input: { frame_id: frameId },
  })
  expect(result.is_error).toBeUndefined()
  expect(result.content).toMatchObject([{ type: 'image' }])
}

async function createFrame({ execute, canvasId }: LocalHarnessRequest, verify = true) {
  const result = await execute({
    type: 'tool_use',
    id: 'create',
    name: 'create_frame',
    input: { name: 'Home', html: HTML },
  })
  expect(result.is_error).toBeUndefined()
  const frameId = store.getCanvas(canvasId)?.frames.find((frame) => frame.name === 'Home')?.id
  if (!frameId) throw new Error('Resident did not create the frame')
  if (verify) await verifyFrame(execute, frameId)
  return DONE
}

describe('resident card community invitations', () => {
  it('announces a verified new frame when a card from the owner completes', async () => {
    const card = queueCard(createFrame)

    await vi.waitFor(() => expect(card.endedAt).toBeTypeOf('number'), 5_000)

    const [frame] = store.getCanvas(canvasId)!.frames
    expect(frame?.id).toBeDefined()
    expect(invitations()).toEqual([{ type: 'canvas:design-generated', frameIds: [frame?.id] }])
  })

  it('does not announce an unverified frame, even if the failed card is marked done manually', async () => {
    const card = queueCard((request) => createFrame(request, false))

    await vi.waitFor(() => expect(card.failedAt).toBeTypeOf('number'), 5_000)

    expect(card.failureReason).toContain('could not verify')
    expect(card.endedAt).toBeUndefined()
    expect(store.getCanvas(canvasId)?.frames).toHaveLength(1)
    expect(invitations()).toEqual([])
    actions.completeCard(canvasId, card.id)
    expect(card.endedAt).toBeTypeOf('number')
    expect(invitations()).toEqual([])
  })

  it('does not announce verified work requested by a collaborator instead of the owner', async () => {
    store.addMember(canvasId, 'collaborator', OWNER)
    const card = queueCard(createFrame, 'collaborator')

    await vi.waitFor(() => expect(card.endedAt).toBeTypeOf('number'), 5_000)

    expect(store.getCanvas(canvasId)?.frames).toHaveLength(1)
    expect(invitations()).toEqual([])
  })

  it('does not announce an existing frame after a verified revision', async () => {
    const frame = store.createFrame(canvasId, { name: 'Existing home', html: HTML }, 'Alex')!
    const card = queueCard(async ({ execute }) => {
      const edit = await execute({
        type: 'tool_use',
        id: 'edit',
        name: 'edit_frame_html',
        input: { frame_id: frame.id, find: 'Welcome home', replace: 'Welcome back' },
      })
      expect(edit.is_error).toBeUndefined()
      await verifyFrame(execute, frame.id)
      return DONE
    })

    await vi.waitFor(() => expect(card.endedAt).toBeTypeOf('number'), 5_000)

    expect(frame.html).toContain('Welcome back')
    expect(invitations()).toEqual([])
  })

  it('carries the generated frame through a read-only review and announces it only after the last stage', async () => {
    const atReview = vi.fn()
    const run = vi
      .fn<RunHarness>()
      .mockImplementationOnce(createFrame)
      .mockImplementationOnce(() => {
        atReview(invitations())
        return Promise.resolve(DONE)
      })
    const card = queueCard(run, OWNER, [DEFAULT_ROLE_ID, 'a11y'])

    await vi.waitFor(() => expect(card.endedAt).toBeTypeOf('number'), 5_000)

    const [frame] = store.getCanvas(canvasId)!.frames
    expect(frame?.id).toBeDefined()
    expect(card).toMatchObject({ stage: 1, agentName: roleName('a11y') })
    expect(run).toHaveBeenCalledTimes(2)
    expect(atReview).toHaveBeenCalledWith([])
    expect(invitations()).toEqual([{ type: 'canvas:design-generated', frameIds: [frame?.id] }])
  })
})
