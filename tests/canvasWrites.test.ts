import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor, ServerMessage } from '../shared/types'

/* persistence is not under test: what the entry does with an operation is */
vi.mock('../server/db/persist.ts', () => ({
  saveTask: () => {},
  saveActivity: () => {},
  saveCanvas: () => {},
  refreshAssetRefs: () => {},
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveFrameVersion: () => {},
  deleteFrame: () => {},
  frameWritePending: () => false,
  getFrameVersion: async () => undefined,
  saveFeedback: () => {},
  saveComment: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))
vi.mock('../server/fonts.ts', () => ({ fontsForCanvas: () => [] }))
const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { CanvasMismatchError, FRAME_CHANGED, FrameVersionConflict, runCanvasWrite } =
  await import('../server/canvasWrites.ts')
const { transaction } = await import('../server/journal.ts')
const { runOperation } = await import('../server/workBudget.ts')
const { withArgsCanvases } = await import('../server/toolLoads.ts')
const { execTool } = await import('../server/resident.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

/* The canvas write entry (server/canvasWrites.ts) and its local host: the server's own
   actions. Its contract: always a promise, a failure only ever its rejection, and every
   kind of operation that awaits it undone by that rejection as by a thrown error. */

const user: Actor = { name: 'Ada', kind: 'user', color: '#2743ee' }
const agent: Actor = { name: 'Doop', kind: 'agent', color: '#000' }
let sent: ServerMessage[]
let canvasId: string

beforeEach(() => {
  sent = []
  actions.wire(
    (_canvasId, message) => void sent.push(message),
    () => {},
  )
  canvasId = store.createCanvas('writes', 'ada').id
})

const types = () => sent.map((message) => message.type)
const doc = (body: string) =>
  `<!doctype html><html><head><title>Writes</title></head><body><main>${body}</main></body></html>`

/** The store refuses the next frame write, as storage or a work budget might. */
const refuseNextWrite = () =>
  vi.spyOn(store, 'updateFrame').mockImplementationOnce(() => {
    throw new Error('storage refused')
  })

describe('the canvas write entry, on its local host', () => {
  it('answers each command with what its action answers', async () => {
    const created = await runCanvasWrite(canvasId, { type: 'create-frame', input: { name: 'A' }, actor: user })
    expect(created).toMatchObject({ name: 'A', canvasId })
    const id = created!.id

    const written = await runCanvasWrite(canvasId, {
      type: 'write-frame',
      frameId: id,
      patch: { html: '<main><p>one</p></main>' },
      actor: user,
    })
    expect(written?.html).toContain('<p>one</p>')
    expect(await runCanvasWrite(canvasId, { type: 'write-frame', frameId: 'gone', patch: {}, actor: user })).toBe(
      undefined,
    )

    const edited = await runCanvasWrite(canvasId, {
      type: 'edit-frame-html',
      frameId: id,
      find: '<p>one</p>',
      replace: '<p>two</p>',
      actor: agent,
      surface: 'mcp',
    })
    expect(edited.ok && edited.frame.html).toContain('<p>two</p>')
    expect(
      await runCanvasWrite(canvasId, {
        type: 'edit-frame-html',
        frameId: id,
        find: '<p>missing</p>',
        replace: '',
        actor: agent,
        surface: 'mcp',
      }),
    ).toEqual({ ok: false, problem: { problem: 'not_found' } })
    expect(
      await runCanvasWrite(canvasId, {
        type: 'edit-frame-html',
        frameId: 'gone',
        find: 'a',
        replace: 'b',
        actor: agent,
        surface: 'mcp',
      }),
    ).toEqual({ ok: false, missing: true })
    const inline = await runCanvasWrite(canvasId, {
      type: 'edit-frame-html',
      frameId: id,
      find: '<p>two</p>',
      replace: `<img src="data:image/png;base64,${'A'.repeat(64)}">`,
      actor: agent,
      surface: 'resident',
    })
    expect(inline.ok).toBe(false)
    expect('inline' in inline && inline.inline).toEqual(expect.any(String))
    expect(store.getFrame(id)?.html).toContain('<p>two</p>')

    expect(await runCanvasWrite(canvasId, { type: 'frame-meta', frameId: id, patch: {}, actor: agent })).toEqual({
      ok: false,
      error: 'nothing to update',
    })
    const moved = await runCanvasWrite(canvasId, { type: 'frame-meta', frameId: id, patch: { x: 40 }, actor: agent })
    expect(moved.ok && moved.value.x).toBe(40)
    expect(
      await runCanvasWrite('no-such-canvas', { type: 'frame-meta', frameId: 'gone', patch: { x: 1 }, actor: agent }),
    ).toEqual({ ok: false, error: 'canvas not found' })

    expect(
      await runCanvasWrite(canvasId, { type: 'restack-frames', frames: [{ id, z: 3 }], actor: user }),
    ).toMatchObject([{ id, z: 3 }])

    const approved = await runCanvasWrite(canvasId, {
      type: 'set-approval',
      frameId: id,
      ready: true,
      user: { id: 'u1', name: 'Ada' },
    })
    expect(approved?.approval).toMatchObject({ status: 'ready_for_dev', approvedBy: 'Ada' })
    expect(
      await runCanvasWrite(canvasId, {
        type: 'agent-approval',
        frameId: 'gone',
        status: 'draft',
        user: { id: 'u1', name: 'Ada' },
        actor: agent,
      }),
    ).toEqual({ ok: false, error: 'no frame with id gone' })

    expect(await runCanvasWrite(canvasId, { type: 'delete-frame', frameId: id, actor: user })).toMatchObject({ id })
    expect(store.getFrame(id)).toBeUndefined()
  })

  it('reports a failure only by rejecting, never by throwing from the call', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Kept' }, user)!
    const fails = refuseNextWrite()
    let answer: Promise<unknown> | undefined
    expect(() => {
      answer = runCanvasWrite(canvasId, { type: 'write-frame', frameId: frame.id, patch: { name: 'x' }, actor: user })
    }).not.toThrow()
    await expect(answer).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getFrame(frame.id)?.name).toBe('Kept')
  })

  it('writes when it is called, before its answer is awaited', () => {
    const frame = actions.createFrame(canvasId, { name: 'Now' }, user)!
    const answer = runCanvasWrite(canvasId, {
      type: 'write-frame',
      frameId: frame.id,
      patch: { name: 'Renamed' },
      actor: user,
    })
    expect(store.getFrame(frame.id)?.name).toBe('Renamed')
    expect(answer).toBeInstanceOf(Promise)
  })

  it('refuses a frame of another canvas than the one it is sent for, and writes nothing', async () => {
    const elsewhere = actions.createFrame(store.createCanvas('other', 'ada').id, { name: 'Other' }, user)!
    sent = []
    for (const command of [
      { type: 'write-frame', frameId: elsewhere.id, patch: { name: 'x' }, actor: user },
      { type: 'delete-frame', frameId: elsewhere.id, actor: user },
      { type: 'frame-meta', frameId: elsewhere.id, patch: { x: 1 }, actor: user },
    ] as const)
      await expect(runCanvasWrite(canvasId, command)).rejects.toBeInstanceOf(CanvasMismatchError)
    expect(store.getFrame(elsewhere.id)).toMatchObject({ name: 'Other', x: elsewhere.x })
    expect(sent).toEqual([])
  })

  it('writes a version-checked command only while the frame is at that version', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Checked' }, user)!
    const version = frame.updatedAt
    actions.updateFrame(frame.id, { name: 'Moved on' }, user)
    sent = []
    for (const command of [
      { type: 'write-frame', frameId: frame.id, patch: { name: 'stale' }, actor: user, ifUpdatedAt: version },
      { type: 'delete-frame', frameId: frame.id, actor: user, ifUpdatedAt: version },
      { type: 'set-approval', frameId: frame.id, ready: true, user: { id: 'u1', name: 'Ada' }, ifUpdatedAt: version },
    ] as const) {
      const refused = await runCanvasWrite(canvasId, command).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(FrameVersionConflict)
      /* what REST answers with, as `requireFrame` always did */
      expect((refused as InstanceType<typeof FrameVersionConflict>).message).toBe(FRAME_CHANGED)
      expect((refused as InstanceType<typeof FrameVersionConflict>).frame).toBe(store.getFrame(frame.id))
    }
    expect(store.getFrame(frame.id)).toMatchObject({ name: 'Moved on' })
    expect(store.getFrame(frame.id)?.approval).toBeUndefined()
    expect(sent).toEqual([])
    const current = store.getFrame(frame.id)!.updatedAt
    expect(
      await runCanvasWrite(canvasId, {
        type: 'write-frame',
        frameId: frame.id,
        patch: { name: 'Fresh' },
        actor: user,
        ifUpdatedAt: current,
      }),
    ).toMatchObject({ name: 'Fresh' })
  })

  it('sends what an operation wrote after it commits, in the order the actions sent it before', async () => {
    /* each on a canvas of its own, so the second finds only the frames it made */
    const run = async (write: (name: string) => Promise<void> | void) => {
      canvasId = store.createCanvas('order', 'ada').id
      sent = []
      await transaction(async () => {
        await write('First')
        await write('Second')
        expect(sent).toEqual([])
      })
      return types()
    }
    const direct = await run((name) => {
      const frame = actions.createFrame(canvasId, { name }, user)!
      actions.updateFrame(frame.id, { html: `<p>${name}</p>` }, user)
    })
    const routed = await run(async (name) => {
      const frame = await runCanvasWrite(canvasId, { type: 'create-frame', input: { name }, actor: user })
      await runCanvasWrite(canvasId, {
        type: 'write-frame',
        frameId: frame!.id,
        patch: { html: `<p>${name}</p>` },
        actor: user,
      })
    })
    expect(routed).toEqual(direct)
    expect(routed.length).toBeGreaterThan(0)
  })

  it('hands back the promise of a command whose action awaits', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Versioned', html: '<main><p>a</p></main>' }, user)!
    const restore = runCanvasWrite(canvasId, {
      type: 'restore-version',
      frameId: frame.id,
      versionId: 'no-such-version',
      actor: user,
    })
    expect(restore).toBeInstanceOf(Promise)
    /* the version is read from the database, which has none: null, as the action answers */
    await expect(restore).resolves.toBe(null)
  })
})

describe('a rejected canvas write inside each kind of operation', () => {
  it('a plain operation (as a request runs in) is undone and tells nobody', async () => {
    const fails = refuseNextWrite()
    let created: string | undefined
    await expect(
      runOperation('test', canvasId, async () => {
        created = (await runCanvasWrite(canvasId, { type: 'create-frame', input: { name: 'Undone' }, actor: user }))!.id
        await runCanvasWrite(canvasId, { type: 'write-frame', frameId: created, patch: { name: 'x' }, actor: user })
      }),
    ).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getFrame(created!)).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('an MCP tool call is undone and tells nobody', async () => {
    const fails = refuseNextWrite()
    let created: string | undefined
    /* the wrapper every MCP tool runs in (server/toolLoads.ts), with what a tool does */
    await expect(
      withArgsCanvases(
        {},
        async () => {
          created = (await runCanvasWrite(canvasId, {
            type: 'create-frame',
            input: { name: 'From a tool' },
            actor: agent,
          }))!.id
          await runCanvasWrite(canvasId, { type: 'write-frame', frameId: created, patch: { name: 'x' }, actor: agent })
        },
        'create_frame',
      ),
    ).rejects.toThrow('storage refused')
    fails.mockRestore()
    expect(store.getFrame(created!)).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('a resident tool call answers an error, is undone and tells nobody', async () => {
    const frame = actions.createFrame(canvasId, { name: 'Home', html: doc('<p>before</p>') }, user)!
    sent = []
    const fails = refuseNextWrite()
    const result = await execTool(
      { type: 'tool_use', id: 't1', name: 'set_frame_html', input: { frame_id: frame.id, html: doc('<p>after</p>') } },
      canvasId,
      actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' }),
      {
        mutatedFrames: new Set<string>(),
        sourceFrames: new Set<string>(),
        verificationFrames: new Set<string>(),
        verifiedFrames: new Set<string>(),
        seenVerified: new Set<string>(),
        rewriteDrafts: new Map<string, string>(),
        vision: false,
        imagesGenerated: 0,
        repliedThreads: new Set<string>(),
        awaitingThreads: new Set<string>(),
        tokenWrites: 0,
        arrangeWrites: 0,
      },
    )
    fails.mockRestore()
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain('storage refused')
    expect(store.getFrame(frame.id)?.html).toContain('<p>before</p>')
    expect(sent).toEqual([])
  })
})
