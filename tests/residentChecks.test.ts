import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { AgentTask } from '../shared/types.ts'
import type { LocalHarnessRequest } from '../server/localAgentRuns.ts'
import type { LocalAgentResult } from '../shared/localAgent.ts'
import type { AgentTurnRequest } from '../server/agentModel.ts'

/* What a resident run has to look at before it may finish (server/changeChecks.ts), on the
   API path and on the Claude Plan's desktop harness, which learns it from tool results. */
const mocks = vi.hoisted(() => ({ pickModel: vi.fn() }))

vi.mock('../server/db/persist.ts', () => ({
  refreshAssetRefs: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  deleteFrame: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/agentModel.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server/agentModel.ts')>()),
  pickModel: mocks.pickModel,
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const resident = await import('../server/resident.ts')
const screenshot = await import('../server/screenshot.ts')
const propagation = await import('../server/propagation.ts')
const { stillToCheck } = await import('../server/changeChecks.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

type RunState = Parameters<typeof resident.execTool>[3]

const OWNER = 'ann'
const STILL_TO_CHECK = 'Still to check before you finish'
const ALL_CHECKED = 'Everything this run changed has been checked'
const REMINDER = 'You have not visually verified'
const actor = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`

const runState = (vision = true) => resident.newRunState({ vision })

let calls = 0
const call = (name: string, input: Record<string, unknown>): Anthropic.ToolUseBlockParam => ({
  type: 'tool_use',
  id: `t${++calls}`,
  name,
  input,
})

function text(result: Anthropic.ToolResultBlockParam): string {
  const content = result.content
  if (typeof content === 'string') return content
  return (content ?? []).map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
}

let canvasId: string
let mainFrameId: string
let poolId: string
let bookedId: string
let notesId: string
let hoursId: string

/** One tool call of a run, its result as text, failing the test on a tool error. */
async function exec(state: RunState, name: string, input: Record<string, unknown>, onCanvas = canvasId) {
  const result = await resident.execTool(call(name, input), onCanvas, actor(), state)
  expect(result.is_error, text(result)).toBeUndefined()
  return text(result)
}
const pending = (state: RunState) => resident.uncheckedChanges(state, canvasId)
const squareCorners = () =>
  call('update_component', { component: 'Button', css: '.btn { border-radius: 0; background: #111; color: #fff }' })
const shot = (frameId: string) => call('screenshot_frame', { frame_id: frameId })
const editNotes = () => call('edit_frame_html', { frame_id: notesId, find: 'Lanes', replace: 'Pools' })
const buttonOwed = [expect.objectContaining({ component: expect.objectContaining({ name: 'Button' }) })]

/* A Button component on two screens, as in the playtest, and two plain frames. */
beforeEach(async () => {
  actions.wire(
    () => {},
    () => {},
  )
  mocks.pickModel.mockReset()
  vi.spyOn(screenshot, 'renderFrame').mockResolvedValue(Buffer.from('image'))
  canvasId = store.createCanvas('checks', OWNER).id
  const created = await exec(runState(), 'create_component', {
    name: 'Button',
    html: '<a class="btn"><span data-doop-prop="label">Book</span></a>',
    css: '.btn { border-radius: 999px; background: #111; color: #fff }',
  })
  mainFrameId = JSON.parse(created.split('\n')[0]!).main_frame_id
  const screen = (name: string, body: string) =>
    actions.createFrame(canvasId, { name, width: 390, height: 844, html: page(body), x: 0, y: 0 }, actor())!.id
  poolId = screen('Pool – pick a slot', '<doop-use component="Button" label="Book"></doop-use>')
  bookedId = screen(
    'Booked',
    '<doop-use component="Button" label="Add"></doop-use><doop-use component="Button"></doop-use>',
  )
  notesId = screen('Notes', '<h1>Lanes</h1>')
  hoursId = screen('Hours', '<p>Open late</p>')
  await propagation.whenIdle()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('what a run still has to check', () => {
  it('checks a component change with one look at any frame showing it', async () => {
    const state = runState()
    /* the result says what is left, so an agent with no reminder turn knows */
    const updated = await exec(state, 'update_component', squareCorners().input as Record<string, unknown>)
    expect(updated).toContain(STILL_TO_CHECK)
    expect(updated).toContain('component Button')
    /* the main and the other screen only follow the component: they were not edited */
    expect(await exec(state, 'screenshot_frame', { frame_id: bookedId })).toContain(ALL_CHECKED)
    expect(pending(state)).toEqual([])
    expect(resident.deliveredWork(state)).toBe(true)
  })

  it("counts the component's own preview as a look", async () => {
    const state = runState()
    await resident.execTool(squareCorners(), canvasId, actor(), state)
    await exec(state, 'screenshot_component', { component: 'Button' })
    expect(pending(state)).toEqual([])
  })

  it('asks for a new look after a later change, which a deletion does not excuse', async () => {
    const state = runState()
    await resident.execTool(squareCorners(), canvasId, actor(), state)
    await resident.execTool(shot(poolId), canvasId, actor(), state)
    expect(
      await exec(state, 'update_component', { component: 'Button', css: '.btn { border-radius: 4px }' }),
    ).toContain(STILL_TO_CHECK)
    /* the deletion keeps the look that change gave */
    await exec(state, 'delete_component', { component: 'Button' })
    expect(pending(state)).toEqual(buttonOwed)
  })

  it('still asks for a look at a frame the run wrote itself', async () => {
    const state = runState()
    await resident.execTool(squareCorners(), canvasId, actor(), state)
    const instanceId = /data-doop-id="([^"]+)"[^>]*data-doop-instance/.exec(store.getFrame(poolId)!.html)?.[1]
    await exec(state, 'update_instances', { frame_id: poolId, instances: [{ instance_id: instanceId, props: {} }] })
    /* the main shows the component change, not the screen that was written */
    await resident.execTool(shot(mainFrameId), canvasId, actor(), state)
    expect(pending(state)).toEqual([expect.objectContaining({ frameIds: [poolId] })])
  })

  it('does not count a look at a frame that no longer uses the component', async () => {
    const state = runState()
    await resident.execTool(squareCorners(), canvasId, actor(), state)
    await exec(state, 'set_frame_html', {
      frame_id: poolId,
      html: page('<h1>No slots today</h1><p>Come back tomorrow.</p>'),
    })
    await resident.execTool(shot(poolId), canvasId, actor(), state)
    expect(pending(state)).toEqual(buttonOwed)
  })

  it('lets go of a frame deleted later in the run', async () => {
    const state = runState()
    await resident.execTool(editNotes(), canvasId, actor(), state)
    expect(pending(state)).toHaveLength(1)
    actions.deleteFrame(notesId, actor())
    expect(pending(state)).toEqual([])
  })

  it('takes a deletion as work with nothing to look at, and a repeated import as no work', async () => {
    const deleted = runState()
    await exec(deleted, 'delete_component', { component: 'Button' })
    expect([resident.deliveredWork(deleted), pending(deleted)]).toEqual([true, []])

    const source = store.createCanvas('kit', OWNER).id
    await exec(runState(), 'create_component', { name: 'Badge', html: '<span>New</span>' }, source)
    const imported = async () => {
      const state = { ...runState(), requesterId: OWNER }
      await exec(state, 'import_component', { source_canvas_id: source, component: 'Badge' })
      return resident.deliveredWork(state)
    }
    expect(await imported()).toBe(true)
    expect(await imported()).toBe(false)
  })

  it('says nothing about checks to a model that cannot see, or after a call that changed nothing', async () => {
    const blind = await resident.execTool(squareCorners(), canvasId, actor(), runState(false))
    expect(text(blind)).not.toContain(STILL_TO_CHECK)
    const read = await exec(runState(), 'get_component', { component: 'Button' })
    expect(read).not.toContain(STILL_TO_CHECK)
    expect(read).not.toContain(ALL_CHECKED)
  })

  it('names a few of the frames showing a component, and counts the rest', () => {
    const line = stillToCheck(
      [{ frameIds: ['a'] }, { frameIds: ['m', 'b', 'c', 'd', 'e', 'f'], component: { id: 'c1', name: 'Button' } }],
      (id) => id.toUpperCase(),
    )
    expect(line).toBe(
      'Still to check before you finish: screenshot_frame "A" (a); component Button: screenshot_frame any one of "M" (m), "B" (b), "C" (c), "D" (d) (or 2 more using it), or screenshot_component.',
    )
  })
})

/* ---- whole runs ---- */

let cardCount = 0

/** Queue one card, run the resident on it, and answer the card once it settles. */
async function runCard(model: unknown): Promise<AgentTask> {
  const id = `card-${++cardCount}`
  const card: AgentTask = {
    id,
    agentName: '',
    color: '#000',
    status: 'make the button corners square',
    startedAt: 1000,
    queuedBy: 'Ann',
    queuedByUserId: OWNER,
    stage: 0,
  }
  actions.hydrateLogs({
    tasks: new Map([[canvasId, [card]]]),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  mocks.pickModel.mockResolvedValue(model)
  resident.onFeedback(canvasId)
  const settled = () => actions.getTasks(canvasId).find((t) => t.id === id)
  await vi.waitFor(() => expect(settled()?.endedAt ?? settled()?.failedAt).toBeDefined(), { timeout: 5000 })
  return settled()!
}

const LIMIT: LocalAgentResult = { success: false, text: 'Reached maximum number of turns (200)', limitReached: true }

describe('a run on the Claude Plan', () => {
  it.each([
    ['finishes a component change checked on one screen using it', () => [squareCorners(), shot(bookedId)], undefined],
    ['still fails a change nobody looked at', () => [editNotes()], /could not verify/],
    /* a later call means the screenshot's answer reached the model */
    [
      'takes a run stopped at its limit after its check was seen',
      () => [squareCorners(), shot(poolId), call('get_component', { component: 'Button' })],
      undefined,
      LIMIT,
    ],
    ['does not count a screenshot the limit cut off', () => [squareCorners(), shot(poolId)], /hit its limit/, LIMIT],
  ])('%s', async (_name, script, failure, result: LocalAgentResult = { success: true, text: 'Done.' }) => {
    const card = await runCard({
      provider: 'claude-local',
      label: 'Claude CLI (sonnet)',
      userId: OWNER,
      run: vi.fn(),
      runHarness: vi.fn(async (req: LocalHarnessRequest) => {
        for (const block of script()) await req.execute(block)
        return result
      }),
    })
    if (failure) expect(card.failureReason).toMatch(failure)
    else expect([card.failureReason, card.endedAt]).toEqual([undefined, expect.any(Number)])
  })
})

describe('a run through the API', () => {
  /** A model whose turns are `turns` in order (no tools: it finishes), and the reminders it was sent. */
  async function runApi(turns: (() => Anthropic.ToolUseBlockParam[])[]) {
    let turn = 0
    const reminders: string[] = []
    const card = await runCard({
      provider: 'anthropic-key',
      label: 'Claude (sonnet)',
      userId: OWNER,
      run: vi.fn(async (req: AgentTurnRequest) => {
        const last = req.messages[req.messages.length - 1]
        if (typeof last?.content === 'string' && last.content.includes(REMINDER)) reminders.push(last.content)
        const blocks = turns[turn++]?.() ?? []
        return {
          stop_reason: blocks.length ? 'tool_use' : 'end_turn',
          content: blocks.length ? blocks : [{ type: 'text', text: 'Done.' }],
        }
      }),
    })
    return { card, reminders }
  }

  it.each([
    [
      'another frame',
      () => call('edit_frame_html', { frame_id: hoursId, find: 'Open late', replace: 'Open till ten' }),
      () => hoursId,
    ],
    [
      'the frame it had just checked',
      () => call('edit_frame_html', { frame_id: notesId, find: 'Pools', replace: 'Pools near you' }),
      () => notesId,
    ],
  ])('is reminded again when its fix-up changes %s', async (_what, fixUp, checked) => {
    const { card, reminders } = await runApi([
      () => [editNotes()],
      () => [],
      () => [shot(notesId), fixUp()],
      () => [],
      () => [shot(checked())],
    ])
    expect(reminders).toHaveLength(2)
    expect(card.endedAt).toBeDefined()
  })

  it('names a component change in the reminder, and fails a run that never looks', async () => {
    const { card, reminders } = await runApi([() => [squareCorners()]])
    /* a few reminders, then the safety check stands */
    expect(reminders).toHaveLength(3)
    expect(reminders[0]).toContain('component Button')
    expect(card.failureReason).toMatch(/could not verify/)
  })
})
