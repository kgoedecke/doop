import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SignalInput } from '@glassray/signals'

/* Canvas writes persist and broadcast like any other; neither matters here. */
vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  getFrameVersion: async () => undefined,
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const { flush, init } = await import('@glassray/signals')
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { AGENT_WORK_WINDOW_MS, agentSignal, agentWorkOnFrame, frameSignal, userSignal } =
  await import('../server/glassray.ts')
const { execTool } = await import('../server/resident.ts')

/**
 * What the route hooks hand Glassray, and the one question they all ask
 * first: was this the agent's work, and recently enough to be reacting to
 * it? The SDK is started against a fake fetch, so the signals are read here
 * exactly as they would go on the wire.
 */

let sent: SignalInput[]

beforeEach(() => {
  sent = []
  init({
    apiKey: 'gr_test',
    endpoint: 'https://glassray.test',
    onError: () => {},
    fetch: async (_url, options) => {
      sent.push(...(JSON.parse(String(options?.body)) as { signals: SignalInput[] }).signals)
      return new Response('{}', { status: 202 })
    },
  })
  actions.wire(
    () => {},
    () => {},
  )
})

const agent = (name = 'Doop') => actions.resolveActor({ name, kind: 'agent' })
const person = (name = 'Kevin') => actions.resolveActor({ name, kind: 'user' })
const html = '<!doctype html><html><body>hi</body></html>'

describe('the shape of what Doop sends', () => {
  it('puts the canvas, the person and their words on a reaction', async () => {
    userSignal({ kind: 'correction', canvasId: 'c1', userId: 'u1', message: 'No, rounder corners' })
    await flush()
    expect(sent).toEqual([
      {
        source: 'user',
        kind: 'correction',
        work_item: { type: 'canvas', id: 'c1' },
        refs: { user: 'u1' },
        message: 'No, rounder corners',
        at: expect.any(Number),
      },
    ])
  })

  it('names the frame and the agent whose design it was', async () => {
    frameSignal({
      kind: 'deleted_agent_work',
      frame: { id: 'f1', canvasId: 'c1', name: 'Hero' },
      userId: 'u1',
      work: { agent: 'Doop', at: Date.now() },
    })
    await flush()
    expect(sent[0]).toMatchObject({
      source: 'user',
      kind: 'deleted_agent_work',
      work_item: { type: 'canvas', id: 'c1' },
      refs: { user: 'u1' },
      context: { frame: 'f1', frame_name: 'Hero', agent: 'Doop' },
    })
  })

  it('says what an agent reports about its own run', async () => {
    agentSignal({
      kind: 'tool_failure',
      message: 'edit_frame_html found no such text',
      canvasId: 'c1',
      userId: 'u1',
      tool: 'edit_frame_html',
      agent: { name: 'Doop', client: 'claude-code' },
      sentiment: 'negative',
    })
    await flush()
    expect(sent[0]).toMatchObject({
      source: 'agent',
      kind: 'tool_failure',
      message: 'edit_frame_html found no such text',
      work_item: { type: 'canvas', id: 'c1' },
      refs: { user: 'u1' },
      agent: { name: 'Doop', client: 'claude-code' },
      tool: 'edit_frame_html',
      sentiment: 'negative',
    })
  })
})

describe('was it the agent’s work', () => {
  it('knows an agent drew it, and that a person drew their own', () => {
    const canvasId = store.createCanvas('work', 'kevin').id
    const theirs = actions.createFrame(canvasId, { name: 'Agent', html }, agent())!
    const mine = actions.createFrame(canvasId, { name: 'Mine', html }, person())!

    expect(agentWorkOnFrame(theirs.id, AGENT_WORK_WINDOW_MS)).toMatchObject({ agent: 'Doop' })
    expect(agentWorkOnFrame(mine.id, AGENT_WORK_WINDOW_MS)).toBeUndefined()
  })

  it('stops counting once the person has taken the design over', () => {
    const canvasId = store.createCanvas('takeover', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Agent', html }, agent())!
    actions.updateFrame(frame.id, { html: `${html}<p>mine</p>` }, person())

    expect(agentWorkOnFrame(frame.id)).toBeUndefined()
  })

  it('lets an edit age out of the window, but never a revert or a sign-off', () => {
    vi.useFakeTimers()
    try {
      const canvasId = store.createCanvas('aged', 'kevin').id
      const frame = actions.createFrame(canvasId, { name: 'Agent', html }, agent())!
      vi.setSystemTime(Date.now() + AGENT_WORK_WINDOW_MS + 60_000)

      /* an hour later, editing an old design is just working on it */
      expect(agentWorkOnFrame(frame.id, AGENT_WORK_WINDOW_MS)).toBeUndefined()
      /* throwing away or signing off exactly what the agent drew still is a reaction */
      expect(agentWorkOnFrame(frame.id)).toMatchObject({ agent: 'Doop' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('an agent inside Doop', () => {
  it('reports its own failed tool call, and stays quiet when the call worked', async () => {
    const canvasId = store.createCanvas('resident', 'kevin').id
    const frame = actions.createFrame(canvasId, { name: 'Home', html }, agent())!
    const run = () => ({
      mutatedFrames: new Set<string>(),
      sourceFrames: new Set<string>(),
      verificationFrames: new Set<string>(),
      verifiedFrames: new Set<string>(),
      rewriteDrafts: new Map<string, string>(),
      vision: false,
      payerId: 'u1',
      imagesGenerated: 0,
      repliedThreads: new Set<string>(),
      awaitingThreads: new Set<string>(),
      tokenWrites: 0,
      arrangeWrites: 0,
    })
    const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })

    const worked = await execTool(call('get_frame_html', { frame_id: frame.id }), canvasId, agent(), run())
    expect(worked.is_error).toBeUndefined()
    await flush()
    expect(sent).toEqual([])

    const failed = await execTool(call('get_frame_html', { frame_id: 'no-such-frame' }), canvasId, agent(), run())
    expect(failed.is_error).toBe(true)
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      source: 'agent',
      kind: 'tool_failure',
      tool: 'get_frame_html',
      work_item: { type: 'canvas', id: canvasId },
      refs: { user: 'u1' },
      agent: { name: 'Doop', client: 'doop-resident' },
      sentiment: 'negative',
    })
    expect(String((sent[0] as { message: string }).message)).toContain('get_frame_html failed')
  })
})
