import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite'
import { db } from '../server/db/index.ts'
import {
  automationApprovals,
  automationRuns,
  automations,
  integrations,
  slackInstallations,
  tasks,
} from '../server/db/schema.ts'
import {
  advanceRun,
  createAutomation,
  deleteAutomation,
  listRuns,
  runAutomation,
  tickWorkflows,
  updateAutomation,
} from '../server/automations.ts'
import { store } from '../server/store.ts'
import * as actions from '../server/actions.ts'
import * as persist from '../server/db/persist.ts'
import { consumeResidentTask } from '../server/allowance.ts'
import { onFeedback } from '../server/resident.ts'
import { isBanned } from '../server/auth.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import type { Automation, Step } from '../shared/automations.ts'
import type { Canvas, Frame } from '../shared/types.ts'

const sqlQueries = vi.hoisted(() => [] as string[])

vi.mock('../server/db/index.ts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const schema = await import('../server/db/schema.ts')
  return {
    db: drizzle(new PGlite(), {
      schema,
      logger: {
        logQuery: (query: string) => {
          sqlQueries.push(query)
        },
      },
    }),
  }
})
vi.mock('../server/resident.ts', () => ({ onFeedback: vi.fn() }))
vi.mock('../server/auth.ts', () => ({
  getUserName: vi.fn().mockResolvedValue('Owner'),
  isBanned: vi.fn().mockResolvedValue(false),
}))
vi.mock('../server/allowance.ts', () => ({
  consumeResidentTask: vi.fn().mockResolvedValue({ ok: true, byoModel: true }),
  refundResidentTask: vi.fn(),
}))

let canvas: Canvas
let source: Frame
const owner = { id: 'owner', name: 'Owner' }
const sent: { url: string; body: Record<string, unknown>; auth: string }[] = []

beforeAll(async () => {
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db as unknown as ReturnType<typeof pgliteDrizzle>, { migrationsFolder: 'server/db/migrations' })
}, 30_000)

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(consumeResidentTask).mockResolvedValue({ ok: true, byoModel: true } as Awaited<
    ReturnType<typeof consumeResidentTask>
  >)
  await db.delete(automationRuns)
  await db.delete(automationApprovals)
  await db.delete(automations)
  await db.delete(integrations)
  await db.delete(slackInstallations)
  sent.length = 0
  stubEnv('BETTER_AUTH_URL', 'https://doop.example')
  canvas = store.createCanvas('Campaign', owner.id)
  source = store.createFrame(canvas.id, { name: 'Approved creative', html: '<h1>Spring sale</h1>' }, owner.name)!
  await db.insert(integrations).values({
    id: 'linear-owner',
    userId: owner.id,
    provider: 'linear',
    accessToken: 'linear-secret',
    accounts: [],
    connectedAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(slackInstallations).values({
    teamId: 'T1',
    userId: owner.id,
    botUserId: 'UBOT',
    botToken: 'slack-secret',
    name: 'Workspace',
    connectedAt: Date.now(),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      sent.push({ url: String(url), body, auth: String((init?.headers as Record<string, string>)?.Authorization) })
      if (String(url).endsWith('/chat.postMessage')) return Response.json({ ok: true, channel: 'C123', ts: '1.2' })
      return Response.json({
        data: {
          issueCreate: { success: true, issue: { identifier: 'DES-12', url: 'https://linear.app/issue/DES-12' } },
        },
      })
    }),
  )
})

afterEach(async () => {
  await persist.flush((id) => store.getFrame(id))
  vi.unstubAllGlobals()
  unstubAllEnvs()
})

function agent(): Step {
  return {
    id: 'agent',
    type: 'agent',
    canvasId: canvas.id,
    title: 'Make sizes',
    prompt: 'Make 1080×1080 and 1080×1920 drafts.',
    roles: ['doop'],
  }
}
function slack(): Step {
  return { id: 'slack', type: 'slack', canvasId: canvas.id, channelId: 'C123', message: 'Ready for the next step' }
}
function linear(): Step {
  return {
    id: 'linear',
    type: 'linear',
    canvasId: canvas.id,
    teamId: 'team-1',
    title: 'Review campaign assets',
    description: 'Check the new sizes.',
  }
}
async function workflow(steps: Step[] = [slack()]): Promise<Automation> {
  const result = await createAutomation(owner.id, {
    name: 'Approved campaign',
    trigger: { type: 'approval', canvasId: canvas.id },
    steps,
  })
  expect(typeof result).not.toBe('string')
  return result as Automation
}
function approve(frame = source) {
  return actions.setFrameApproval(frame.id, true, owner)!
}
async function runs(id: string) {
  return (await listRuns(owner.id, id))!
}
async function rawRun(id: string) {
  return (await db.select().from(automationRuns).where(eq(automationRuns.automationId, id)))[0]!
}

it('batches only approved designs, posts once, and keeps receipts when run history is removed', async () => {
  const a = await workflow()
  const second = store.createFrame(canvas.id, { name: 'Second', html: '<p>Sale</p>' }, owner.name)!
  store.createFrame(canvas.id, { name: 'Unapproved secret', html: '<p>Draft</p>' }, owner.name)
  approve()
  approve(second)
  await Promise.all([tickWorkflows(), tickWorkflows(), runAutomation(a.id, { approved: true })])
  expect(await runs(a.id)).toHaveLength(1)
  expect((await runs(a.id))[0]!.status).toBe('ok')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.auth).toBe('Bearer slack-secret')
  expect(sent[0]!.body).toMatchObject({ channel: 'C123', mrkdwn: false, unfurl_links: false })
  expect(sent[0]!.body.text).toContain(source.id)
  expect(sent[0]!.body.text).toContain(second.id)
  expect(sent[0]!.body.text).not.toContain('Unapproved secret')
  const approvedAt = source.approval!.approvedAt
  approve()
  expect(source.approval!.approvedAt).toBe(approvedAt)
  await db.delete(automationRuns)
  await tickWorkflows()
  expect(sent).toHaveLength(1)
})

it('waits for generated drafts, then creates a Linear ticket and posts its link to Slack', async () => {
  const a = await workflow([agent(), linear(), slack()])
  approve()
  await tickWorkflows()
  const run = await rawRun(a.id)
  expect(run.status).toBe('running')
  expect(run.state?.taskId).toBeTruthy()
  const [card] = await db.select().from(tasks).where(eq(tasks.id, run.state!.taskId!))
  expect(card!.queuedByUserId).toBe(owner.id)
  expect(card!.status).toContain(source.id)
  expect(card!.status).toContain('new draft frames')
  expect(card!.status).toContain('inspect_frame')
  expect(onFeedback).toHaveBeenCalledWith(canvas.id)
  await advanceRun(run.id)
  expect(sent).toHaveLength(0)
  const output = store.createFrame(canvas.id, { name: 'Square', width: 1080, height: 1080 }, 'Doop')!
  await db.update(tasks).set({ endedAt: Date.now(), frameIds: output.id }).where(eq(tasks.id, card!.id))
  await advanceRun(run.id)
  await advanceRun(run.id)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.auth).toBe('linear-secret')
  expect(sent[0]!.body.variables).toMatchObject({
    input: { teamId: 'team-1', title: 'Review campaign assets', description: expect.stringContaining(output.id) },
  })
  await advanceRun(run.id)
  expect(sent).toHaveLength(2)
  expect(sent[1]!.body.text).toContain('https://linear.app/issue/DES-12')
  expect((await runs(a.id))[0]!.status).toBe('ok')
  expect(output.approval).toBeFalsy()
  await tickWorkflows()
  expect(await runs(a.id)).toHaveLength(1)
  expect(consumeResidentTask).toHaveBeenCalledTimes(1)
})

it('stops downstream actions if an approved source changes during design work', async () => {
  const a = await workflow([agent(), slack()])
  approve()
  await tickWorkflows()
  const run = await rawRun(a.id)
  store.updateFrame(source.id, { html: '<p>Changed</p>' }, owner.name)
  await advanceRun(run.id)
  expect((await runs(a.id))[0]).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('approved source changed'),
  })
  expect(actions.getTasks(canvas.id).find((t) => t.id === run.state?.taskId)?.failedAt).toBeTruthy()
  expect(sent).toHaveLength(0)
  approve()
  await tickWorkflows()
  expect(await runs(a.id)).toHaveLength(2)
})

it('does not replay older approvals on setup or re-enable; Run now can process existing unhandled approvals', async () => {
  approve()
  source.approval!.approvedAt -= 1000
  const a = await workflow()
  await tickWorkflows()
  expect(sent).toHaveLength(0)
  await runAutomation(a.id)
  expect(sent).toHaveLength(1)
  await updateAutomation(owner.id, a.id, { enabled: false })
  actions.setFrameApproval(source.id, false, owner)
  approve()
  source.approval!.approvedAt -= 500
  await updateAutomation(owner.id, a.id, { enabled: true })
  await tickWorkflows()
  expect(sent).toHaveLength(1)
})

it('enforces canvas access both at setup and at execution', async () => {
  expect(
    await createAutomation('stranger', { trigger: { type: 'approval', canvasId: canvas.id }, steps: [slack()] }),
  ).toBe('the approval canvas is not yours')
  const a = await workflow([agent(), slack()])
  approve()
  await tickWorkflows()
  canvas.ownerId = 'someone-else'
  await advanceRun((await rawRun(a.id)).id)
  expect((await runs(a.id))[0]!.status).toBe('failed')
  expect(sent).toHaveLength(0)
})

it('uses only the automation owner’s integrations and reports how to reconnect', async () => {
  await db.update(slackInstallations).set({ userId: 'someone-else' })
  const a = await workflow()
  approve()
  await tickWorkflows()
  expect((await runs(a.id))[0]).toMatchObject({
    status: 'failed',
    failure: 'reconnect',
    error: expect.stringContaining('Connect Slack'),
  })
  expect(sent).toHaveLength(0)
})

it('surfaces Slack membership errors without exposing upstream response text', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ ok: false, error: 'not_in_channel', secret: 'do-not-expose' }))
  const a = await workflow()
  approve()
  await tickWorkflows()
  expect((await runs(a.id))[0]!.error).toBe('Check the Slack channel ID and invite @Doop to that channel.')
})

it('does not replay an interrupted external step after its lease expires', async () => {
  const a = await workflow([agent(), slack()])
  approve()
  await tickWorkflows()
  const run = await rawRun(a.id)
  await db
    .update(automationRuns)
    .set({
      state: { ...run.state!, stepIndex: 1, taskId: undefined, dispatching: true },
      leaseUntil: Date.now() + 60_000,
    })
    .where(eq(automationRuns.id, run.id))
  await advanceRun(run.id)
  expect((await runs(a.id))[0]!.status).toBe('running')
  await db.update(automationRuns).set({ leaseUntil: 0 }).where(eq(automationRuns.id, run.id))
  await advanceRun(run.id)
  expect((await runs(a.id))[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') })
  expect(sent).toHaveLength(0)
})

it('stops queued design work when its workflow is deleted', async () => {
  const a = await workflow([agent(), slack()])
  approve()
  await tickWorkflows()
  const run = await rawRun(a.id)
  await deleteAutomation(owner.id, a.id)
  expect(actions.getTasks(canvas.id).find((t) => t.id === run.state?.taskId)?.failedAt).toBeTruthy()
  expect(await db.select().from(automationApprovals)).toHaveLength(0)
  expect(sent).toHaveLength(0)
})

it('does not dispatch work when the task allowance is unavailable', async () => {
  vi.mocked(consumeResidentTask).mockResolvedValue({ ok: false } as Awaited<ReturnType<typeof consumeResidentTask>>)
  const a = await workflow([agent(), slack()])
  approve()
  await tickWorkflows()
  expect((await runs(a.id))[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('no model account') })
  expect(onFeedback).not.toHaveBeenCalled()
  expect(sent).toHaveLength(0)
})

it('gives separate approvals distinct identities even within the same millisecond', async () => {
  const a = await workflow()
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  try {
    approve()
    const first = source.approval!.approvedAt
    await runAutomation(a.id)
    actions.setFrameApproval(source.id, false, owner)
    approve()
    expect(source.approval!.approvedAt).toBeGreaterThan(first)
    await runAutomation(a.id)
    expect(sent).toHaveLength(2)
  } finally {
    now.mockRestore()
  }
})

it('does not deliver when a run is deleted while its preflight check is in progress', async () => {
  const a = await workflow()
  approve()
  let started!: () => void
  const checking = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: (value: boolean) => void
  const preflight = new Promise<boolean>((resolve) => {
    finish = resolve
  })
  vi.mocked(isBanned).mockImplementationOnce(() => {
    started()
    return preflight
  })
  const running = runAutomation(a.id)
  await checking
  await deleteAutomation(owner.id, a.id)
  finish(false)
  await running
  expect(sent).toHaveLength(0)
})

it('gives later agents the draft outputs of earlier steps as well as the approved originals', async () => {
  const localize = { ...agent(), id: 'localize', title: 'Localize sizes', prompt: 'Localize those sizes into German.' }
  const a = await workflow([agent(), localize])
  approve()
  await tickWorkflows()
  const run = await rawRun(a.id)
  const output = store.createFrame(canvas.id, { name: 'Square', width: 1080, height: 1080 }, 'Doop')!
  await db.update(tasks).set({ endedAt: Date.now(), frameIds: output.id }).where(eq(tasks.id, run.state!.taskId!))
  await advanceRun(run.id)
  await advanceRun(run.id)
  const next = await rawRun(a.id)
  const [card] = await db.select().from(tasks).where(eq(tasks.id, next.state!.taskId!))
  expect(card!.status).toContain(source.id)
  expect(card!.status).toContain(output.id)
  expect(card!.status).toContain('Completed Make sizes')
  expect(card!.status).toContain('They are drafts and do not need approval')
  expect(card!.status).toContain('Localize those sizes into German.')
})

it('skips handled approval receipts without issuing duplicate inserts', async () => {
  const a = await workflow()
  approve()
  for (let i = 0; i < 100; i++) {
    const frame = store.createFrame(canvas.id, { name: `Handled ${i}` }, owner.name)!
    frame.approval = { ...source.approval!, approvedFrameUpdatedAt: frame.updatedAt }
  }
  await db
    .insert(automationApprovals)
    .values(
      canvas.frames.map((frame) => ({ automationId: a.id, frameId: frame.id, approvedAt: frame.approval!.approvedAt })),
    )
  sqlQueries.length = 0
  await tickWorkflows()
  const receiptQueries = sqlQueries.filter((sql) => sql.includes('automation_approvals'))
  expect(receiptQueries.filter((sql) => /insert/i.test(sql))).toHaveLength(0)
  expect(receiptQueries.filter((sql) => /select/i.test(sql))).toHaveLength(1)
  expect(sent).toHaveLength(0)
})

it('keeps advancing other workflows while one integration request is slow', async () => {
  const slowStep = { ...slack(), channelId: 'C111' }
  const fastStep = { ...slack(), channelId: 'C222' }
  await workflow([slowStep])
  const fast = await workflow([fastStep, linear()])
  approve()
  const respond = vi.mocked(fetch).getMockImplementation()!
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (JSON.parse(String(init?.body ?? '{}')).channel === 'C111') await blocked
    return respond(url, init)
  })
  const firstTick = tickWorkflows()
  let secondTick: Promise<void> | undefined
  try {
    await expect.poll(async () => (await rawRun(fast.id))?.state?.stepIndex).toBe(1)
    secondTick = tickWorkflows()
    await expect
      .poll(() => sent.some((request) => String(request.body.query).includes('DoopAutomationIssue')))
      .toBe(true)
    expect((await runs(fast.id))[0]!.status).toBe('ok')
  } finally {
    release()
    await firstTick
    await secondTick
  }
})

it('bounds concurrent workflow delivery requests', async () => {
  for (let i = 0; i < 8; i++) await workflow()
  approve()
  const respond = vi.mocked(fetch).getMockImplementation()!
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let inFlight = 0
  let peak = 0
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await blocked
    try {
      return await respond(url, init)
    } finally {
      inFlight--
    }
  })
  const tick = tickWorkflows()
  try {
    await expect.poll(() => inFlight).toBe(4)
  } finally {
    release()
    await tick
  }
  expect(peak).toBe(4)
  expect(sent).toHaveLength(8)
})
